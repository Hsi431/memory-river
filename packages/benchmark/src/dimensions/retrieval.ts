/**
 * Dimension 1: Retrieval quality (Benchmark B2).
 *
 * Loads a synthetic bilingual fixture, ingests it into a real MemoryStore backed
 * by genuine Qwen3 embeddings (local Ollama), then scores four retriever paths
 * against ground-truth relevant ids:
 *
 *   vector  - pure vector search           (store.vectorSearch)
 *   bm25    - pure lexical / FTS search     (store.ftsSearch)
 *   rrf     - RRF fusion of vector + BM25   (store.hybridVectorSearch, the default)
 *   rerank  - RRF + CRAG reranker           (Retriever.hybridSearch)
 *
 * The baseline matrix quantifies the gain from fusion and reranking — the core
 * claim of retriever-v4. Retrieval-level metrics (Recall@k / MRR / nDCG@k) are
 * deterministic. An optional answer-level judge (DeepSeek V4) adds answer
 * accuracy when DEEPSEEK_API_KEY is set.
 *
 * This dimension is NOT part of CI: it needs a running Ollama, and the rerank
 * path downloads a MiniLM model on first use.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MemoryStore } from '@memory-river/core/store/store-v4';
import { Retriever } from '@memory-river/core/retrieval/retriever-v4';

import type { BenchmarkResult } from '../report.js';
import type { BenchmarkOptions } from './index.js';
import { createDeepSeekJudge, judgeAvailable } from '../harness/deepseek-llm.js';
import { createRealEmbedder, EMBED_DIM, ollamaHealthy } from '../harness/real-embedder.js';
import { meanScores, scoreQuery, type PerQueryScore } from '../harness/retrieval-metrics.js';

const RETRIEVE_K = 5;
const PATHS = ['vector', 'bm25', 'rrf', 'rerank'] as const;
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
  expectedAnswer: string;
}
interface Dataset {
  version: string;
  memories: DatasetMemory[];
  queries: DatasetQuery[];
}

interface RankedResult {
  ids: string[];
  texts: string[];
}

function datasetPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', '..', 'datasets', 'fixtures', 'retrieval.json');
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

export async function runRetrievalBenchmark(
  options: BenchmarkOptions = {},
): Promise<BenchmarkResult> {
  if (!(await ollamaHealthy())) {
    return {
      dimension: 'retrieval',
      metrics: {},
      details: {
        skipped: 'ollama-unavailable',
        hint: `Start Ollama and pull the embedding model, then re-run mr-bench retrieval.`,
      },
    };
  }

  const dataset = loadDataset();
  const embedder = createRealEmbedder();

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-bench-retrieval-'));
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
        metadata: JSON.stringify({ benchmark: 'retrieval', datasetId: mem.id }),
      } as Parameters<MemoryStore['store']>[0]);
      idMap.set(mem.id, saved.id);
    }
    // No manual FTS reindex: the store's init-time index already covers rows
    // added afterwards, and a second-handle createIndex/optimize would rewrite
    // the table version underneath the store's live handle and corrupt it.

    const retriever = new Retriever(
      store,
      embedder,
      { vectorWeight: 0.7, bm25Weight: 0.3, candidatePoolMultiplier: 2 },
      rerankerCacheDir(),
    );

    // ── Run every query through all four paths ────────────────────────────────
    const scores: Record<PathName, PerQueryScore[]> = { vector: [], bm25: [], rrf: [], rerank: [] };
    const byKind: Record<string, Record<PathName, number[]>> = {};
    const ranked: Record<string, Record<PathName, RankedResult>> = {};
    let rerankAvailable = true;

    const toRanked = (results: Array<{ entry: { id: string; text: string } }>): RankedResult => ({
      ids: results.map(r => r.entry.id),
      texts: results.map(r => r.entry.text),
    });

    for (const q of dataset.queries) {
      const relevant = new Set(q.relevantIds.map(id => idMap.get(id)!));
      const queryVector = await embedder.embed(q.query, 'query');

      const results: Record<PathName, RankedResult> = {
        vector: toRanked(await store.vectorSearch(queryVector, RETRIEVE_K)),
        bm25: toRanked(await store.ftsSearch(q.query, RETRIEVE_K)),
        rrf: toRanked(await store.hybridVectorSearch(q.query, RETRIEVE_K)),
        rerank: { ids: [], texts: [] },
      };
      if (rerankAvailable) {
        try {
          // hybridSearchWithoutBoost: skip Hebbian reinforcement so scoring one
          // query does not mutate memory health and bias later queries.
          results.rerank = toRanked((await retriever.hybridSearchWithoutBoost(q.query, RETRIEVE_K)).results);
        } catch {
          rerankAvailable = false;
        }
      }
      ranked[q.id] = results;

      byKind[q.kind] ??= { vector: [], bm25: [], rrf: [], rerank: [] };
      for (const p of PATHS) {
        if (p === 'rerank' && !rerankAvailable) continue;
        const s = scoreQuery(results[p].ids, relevant);
        scores[p].push(s);
        byKind[q.kind][p].push(s['recall@5']);
      }
    }

    // ── Aggregate retrieval-level metrics ────────────────────────────────────
    const metrics: Record<string, number> = {};
    const baselineMatrix: Record<string, PerQueryScore> = {};
    for (const p of PATHS) {
      if (scores[p].length === 0) continue;
      const mean = meanScores(scores[p]);
      baselineMatrix[p] = mean;
      for (const [metric, value] of Object.entries(mean)) metrics[`${p}.${metric}`] = value;
    }

    const meanRecall = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const kindMatrix: Record<string, Record<string, number>> = {};
    for (const [kind, paths] of Object.entries(byKind)) {
      kindMatrix[kind] = {};
      for (const p of PATHS) {
        if (paths[p].length > 0) kindMatrix[kind][`${p}.recall@5`] = meanRecall(paths[p]);
      }
    }

    // ── Optional answer-level judge (DeepSeek V4) ────────────────────────────
    const judge = await runJudge(dataset, ranked, rerankAvailable, options.judgeAll ?? false);
    if (judge) {
      for (const [p, acc] of Object.entries(judge.accuracy)) metrics[`${p}.answer_accuracy`] = acc;
    }

    return {
      dimension: 'retrieval',
      metrics,
      details: {
        datasetVersion: dataset.version,
        memories: dataset.memories.length,
        queries: dataset.queries.length,
        retrieveK: RETRIEVE_K,
        rerankAvailable,
        baselineMatrix,
        byKind: kindMatrix,
        judge: judge ?? { available: judgeAvailable(), ran: false },
      },
    };
  } finally {
    await store.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

interface JudgeOutcome {
  available: true;
  ran: true;
  model: string;
  accuracy: Record<string, number>;
  stats: { calls: number; promptTokens: number; completionTokens: number };
}

async function runJudge(
  dataset: Dataset,
  ranked: Record<string, Record<PathName, RankedResult>>,
  rerankAvailable: boolean,
  judgeAll: boolean,
): Promise<JudgeOutcome | null> {
  if (!judgeAvailable() || process.env.MR_BENCH_NO_JUDGE) return null;

  const llm = createDeepSeekJudge();
  const productionPath: PathName = rerankAvailable ? 'rerank' : 'rrf';
  const paths = judgeAll
    ? PATHS.filter(p => p !== 'rerank' || rerankAvailable)
    : [productionPath];
  const correct: Record<string, number> = Object.fromEntries(paths.map(p => [p, 0]));
  const counts: Record<string, number> = Object.fromEntries(paths.map(p => [p, 0]));

  const tasks: Array<Promise<void>> = [];
  for (const q of dataset.queries) {
    for (const p of paths) {
      tasks.push(
        (async () => {
          const texts = ranked[q.id][p].texts.slice(0, RETRIEVE_K);
          const answer = await generateAnswer(llm, q.query, texts);
          const ok = await judgeAnswer(llm, q.query, q.expectedAnswer, answer);
          counts[p]++;
          if (ok) correct[p]++;
        })(),
      );
    }
  }
  await Promise.all(tasks);

  const accuracy: Record<string, number> = {};
  for (const p of paths) accuracy[p] = counts[p] > 0 ? correct[p] / counts[p] : 0;

  return {
    available: true,
    ran: true,
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
    accuracy,
    stats: { ...llm.stats },
  };
}

async function generateAnswer(
  llm: { generate(prompt: string): Promise<string> },
  query: string,
  contexts: string[],
): Promise<string> {
  const context = contexts.length
    ? contexts.map(t => `- ${t}`).join('\n')
    : '(no context retrieved)';
  const prompt =
    `Answer the question using ONLY the context snippets below. ` +
    `Reply with one short sentence. If the context does not contain the answer, reply exactly: I don't know.\n\n` +
    `Context:\n${context}\n\nQuestion: ${query}\nAnswer:`;
  return llm.generate(prompt);
}

async function judgeAnswer(
  llm: { generate(prompt: string): Promise<string> },
  query: string,
  expected: string,
  candidate: string,
): Promise<boolean> {
  const prompt =
    `Grade whether the candidate answer is correct.\n` +
    `Question: ${query}\nReference answer: ${expected}\nCandidate answer: ${candidate}\n\n` +
    `Is the candidate correct and consistent with the reference? Reply with exactly YES or NO.`;
  const verdict = (await llm.generate(prompt)).trim().toUpperCase();
  return verdict.startsWith('YES');
}
