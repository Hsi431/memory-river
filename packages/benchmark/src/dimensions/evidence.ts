import * as fs from 'node:fs';
import * as path from 'node:path';

import { safeRate } from '../harness/metrics.js';
import { createTempMemoryRiver } from '../harness/temp-store.js';
import type { BenchmarkResult } from '../report.js';

const SESSION_KEY = 'benchmark-evidence';
const FIXTURES = [
  'Project Atlas stores audit logs for thirty days.',
  'Project Beacon rotates signing keys every Friday.',
  'Project Cedar requires two reviewers for production changes.',
  'Project Delta keeps rollback artifacts in cold storage.',
];

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function overlapRate(left: string, right: string): number {
  const expected = tokens(left);
  const actual = tokens(right);
  let matches = 0;
  for (const token of expected) if (actual.has(token)) matches++;
  return safeRate(matches, expected.size);
}

function parsePointer(pointer: unknown): { sourcePath: string; line: number } | null {
  if (typeof pointer !== 'string') return null;
  const match = /^(.*):(\d+)$/.exec(pointer);
  if (!match) return null;
  const line = Number(match[2]);
  return line > 0 ? { sourcePath: match[1]!, line } : null;
}

export async function runEvidenceBenchmark(): Promise<BenchmarkResult> {
  const temp = await createTempMemoryRiver();
  try {
    const messages = FIXTURES.flatMap((text, index) => [
      { role: 'user' as const, content: text, timestamp: 1_710_000_000_000 + index },
      { role: 'assistant' as const, content: `Recorded evidence item ${index + 1}.` },
    ]);
    await temp.river.archiveTranscript(
      { sessionKey: SESSION_KEY, sessionId: SESSION_KEY },
      messages,
    );

    const sourcePath = path.join(temp.dataDir, 'transcripts', `${SESSION_KEY}.jsonl`);
    const sourceLines = fs.readFileSync(sourcePath, 'utf8').trim().split('\n');
    const sourceEntries = sourceLines.map(line => JSON.parse(line)) as Array<{ entryId: number }>;
    for (let index = 0; index < FIXTURES.length; index++) {
      await temp.river.remember(FIXTURES[index], {
        category: 'fact',
        importance: 0.6,
        metadata: {
          benchmarkTag: 'evidence',
          evidence: `${sourcePath}:${sourceEntries[index].entryId}`,
        },
      });
    }

    let resolvable = 0;
    let rehydrated = 0;
    let consistent = 0;
    const recalledIds: string[] = [];
    for (const expectedText of FIXTURES) {
      const recalled = await temp.river.recall(expectedText, 5);
      const target = recalled.find(result => result.entry.text === expectedText);
      if (!target) continue;
      recalledIds.push(target.entry.id);

      const metadata = typeof target.entry.metadata === 'string'
        ? JSON.parse(target.entry.metadata) as { evidence?: string }
        : {};
      const pointer = parsePointer(metadata.evidence);
      if (!pointer || pointer.sourcePath !== sourcePath || !fs.existsSync(pointer.sourcePath)) continue;
      resolvable++;

      const entries = await temp.river.rehydrate({
        mode: 'entry_ids',
        sessionKey: SESSION_KEY,
        entryIds: [pointer.line],
        bleed: 0,
      });
      const hit = entries.find(entry => entry.entryId === pointer.line);
      if (!hit) continue;
      rehydrated++;
      if (overlapRate(expectedText, `${hit.user} ${hit.assistant}`) >= 0.8) consistent++;
    }

    return {
      dimension: 'evidence',
      metrics: {
        evidence_resolvable_rate: safeRate(resolvable, FIXTURES.length),
        rehydrate_hit_rate: safeRate(rehydrated, FIXTURES.length),
        content_consistency_rate: safeRate(consistent, FIXTURES.length),
      },
      details: {
        fixture_count: FIXTURES.length,
        recalled_count: recalledIds.length,
        source_path: sourcePath,
        recalled_ids: recalledIds,
      },
    };
  } finally {
    await temp.cleanup();
  }
}
