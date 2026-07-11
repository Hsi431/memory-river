/**
 * Dimension: CRAG filter precision/recall (with distractors).
 *
 * The retrieval dimension showed the CRAG reranker is net-negative on a clean,
 * vector-friendly fixture — but a clean fixture has no noise for CRAG to remove,
 * so it can only show CRAG's cost (dropped relevants), never its benefit (noise
 * suppression). This dimension supplies the missing axis: every query plants
 * deliberate distractors (wrong attribute, superseded fact, lexical homonym,
 * topic-adjacent) that pass RRF similarity but should be filtered out.
 *
 * It runs two paths on the same corpus:
 *   rrf    - RRF fusion, no CRAG   (store.hybridVectorSearch) — the baseline pool
 *   rerank - RRF + CRAG reranker   (Retriever.hybridSearchWithoutBoost)
 *
 * and reports each path's relevantRecall / distractorRejection / precision / f1.
 * CRAG's contribution is the rerank−rrf delta: it earns its keep only if it
 * lifts distractorRejection without sinking relevantRecall. This is the
 * verification harness for any CRAG threshold change — rerun after a fix and the
 * delta should move from "drops relevants" toward "drops distractors".
 *
 * Deterministic (no LLM judge). NOT part of CI: needs a running Ollama, and the
 * rerank path downloads a MiniLM model on first use.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MemoryStore } from '@memory-river/core/store/store-v4';
import { Retriever } from '@memory-river/core/retrieval/retriever-v4';

import type { BenchmarkResult } from '../report.js';
import type { BenchmarkOptions } from './index.js';
import { createRealEmbedder, EMBED_DIM, ollamaHealthy } from '../harness/real-embedder.js';
import {
  aggregateConfusions,
  cragConfusion,
  scoreFromConfusion,
  type CragConfusion,
  type CragScore,
} from '../harness/crag-metrics.js';

const DEFAULT_POOL_K = 10;
const PATHS = ['rrf', 'rerank'] as const;
type PathName = (typeof PATHS)[number];

interface DatasetMemory {
  id: string;
  sessionId: string;
  category: string;
  importance: number;
  text: string;
}
interface DatasetQuery {
  id: string;
  kind: string;
  query: string;
  relevantIds: string[];
  distractorIds: string[];
}
interface Dataset {
  version: string;
  poolK?: number;
  memories: DatasetMemory[];
  queries: DatasetQuery[];
}

function datasetPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', '..', 'datasets', 'fixtures', 'crag-distractor.json');
}

function rerankerCacheDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.join(here, '..', '..', '.cache', 'reranker');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadDataset(): Dataset {
  return JSON.parse(fs.readFileSync(datasetPath(), 'utf8')) as Dataset;
}

export async function runCragBenchmark(
  _options: BenchmarkOptions = {},
): Promise<BenchmarkResult> {
  if (!(await ollamaHealthy())) {
    return {
      dimension: 'crag',
      metrics: {},
      details: {
        skipped: 'ollama-unavailable',
        hint: 'Start Ollama and pull the embedding model, then re-run mr-bench crag.',
      },
    };
  }

  const dataset = loadDataset();
  const poolK = dataset.poolK ?? DEFAULT_POOL_K;
  const embedder = createRealEmbedder();

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-bench-crag-'));
  const dbPath = path.join(root, 'data', 'memories');
  const ramPath = path.join(root, 'ram', 'memories');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(path.dirname(ramPath), { recursive: true });

  const store = new MemoryStore(dbPath, ramPath, EMBED_DIM, undefined, embedder);
  await store.ensureInitialized();

  try {
    // ── Ingest corpus, mapping fixture ids to store-assigned ids ──────────────
    const idMap = new Map<string, string>();
    for (const mem of dataset.memories) {
      const vector = await embedder.embed(mem.text, 'store');
      const saved = await store.store({
        text: mem.text,
        vector,
        importance: mem.importance,
        category: mem.category,
        parentId: null,
        sessionId: mem.sessionId,
        metadata: JSON.stringify({ benchmark: 'crag', datasetId: mem.id }),
      } as Parameters<MemoryStore['store']>[0]);
      idMap.set(mem.id, saved.id);
    }

    const retriever = new Retriever(
      store,
      embedder,
      { vectorWeight: 0.7, bm25Weight: 0.3, candidatePoolMultiplier: 2 },
      rerankerCacheDir(),
    );

    const mapped = (ids: readonly string[]): string[] => ids.map(id => idMap.get(id)!);
    const idsOf = (results: Array<{ entry: { id: string } }>): string[] =>
      results.map(r => r.entry.id);

    const confusions: Record<PathName, CragConfusion[]> = { rrf: [], rerank: [] };
    const byKind: Record<string, Record<PathName, CragConfusion[]>> = {};
    const perQuery: Array<Record<string, unknown>> = [];
    let rerankAvailable = true;

    for (const q of dataset.queries) {
      const relevant = mapped(q.relevantIds);
      const distractor = mapped(q.distractorIds);

      const kept: Record<PathName, string[]> = {
        rrf: idsOf(await store.hybridVectorSearch(q.query, poolK)),
        rerank: [],
      };
      if (rerankAvailable) {
        try {
          // hybridSearchWithoutBoost: skip Hebbian reinforcement so scoring one
          // query does not mutate memory health and bias later queries.
          kept.rerank = idsOf((await retriever.hybridSearchWithoutBoost(q.query, poolK)).results);
        } catch {
          rerankAvailable = false;
        }
      }

      byKind[q.kind] ??= { rrf: [], rerank: [] };
      const row: Record<string, unknown> = { id: q.id, kind: q.kind };
      for (const p of PATHS) {
        if (p === 'rerank' && !rerankAvailable) continue;
        const c = cragConfusion(kept[p], relevant, distractor);
        confusions[p].push(c);
        byKind[q.kind][p].push(c);
        row[p] = scoreFromConfusion(c);
      }
      perQuery.push(row);
    }

    // ── Aggregate (micro-averaged over the labeled set) ──────────────────────
    const metrics: Record<string, number> = {};
    const summary: Record<string, CragScore> = {};
    for (const p of PATHS) {
      if (confusions[p].length === 0) continue;
      const score = aggregateConfusions(confusions[p]);
      summary[p] = score;
      metrics[`${p}.relevantRecall`] = score.relevantRecall;
      metrics[`${p}.distractorRejection`] = score.distractorRejection;
      metrics[`${p}.precision`] = score.precision;
      metrics[`${p}.f1`] = score.f1;
    }

    // CRAG's contribution: rerank − rrf on the two axes that matter.
    if (summary.rrf && summary.rerank) {
      metrics['crag.recallDelta'] = summary.rerank.relevantRecall - summary.rrf.relevantRecall;
      metrics['crag.rejectionDelta'] =
        summary.rerank.distractorRejection - summary.rrf.distractorRejection;
      metrics['crag.f1Delta'] = summary.rerank.f1 - summary.rrf.f1;
    }

    const kindMatrix: Record<string, Record<PathName, CragScore>> = {};
    for (const [kind, paths] of Object.entries(byKind)) {
      kindMatrix[kind] = {} as Record<PathName, CragScore>;
      for (const p of PATHS) {
        if (paths[p].length > 0) kindMatrix[kind][p] = aggregateConfusions(paths[p]);
      }
    }

    return {
      dimension: 'crag',
      metrics,
      details: {
        datasetVersion: dataset.version,
        memories: dataset.memories.length,
        queries: dataset.queries.length,
        poolK,
        rerankAvailable,
        summary,
        byKind: kindMatrix,
        perQuery,
      },
    };
  } finally {
    await store.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
