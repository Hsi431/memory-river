/**
 * Index-based rehydrator extracted from the original locomo dimension so that
 * conversation-runner.ts can import it without creating a circular dependency
 * with locomo.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { RehydratedTurn } from '../agent/otter.js';

function transcriptFiles(transcriptsDir: string, sessionKeys: string[]): string[] {
  if (!fs.existsSync(transcriptsDir)) return [];
  return fs.readdirSync(transcriptsDir)
    .filter(file => file.endsWith('.jsonl'))
    .filter(file => sessionKeys.some(key =>
      file === `${key}.jsonl` || new RegExp(`^${escapeRegex(key)}\\.\\d+\\.jsonl$`).test(file),
    ))
    .sort()
    .map(file => path.join(transcriptsDir, file));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readLineAt(filePath: string, offset: number): RehydratedTurn | null {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(100_000);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
    if (bytesRead === 0) return null;
    const newline = buffer.indexOf(0x0a);
    const line = buffer.subarray(0, newline === -1 ? bytesRead : newline).toString('utf8');
    const raw = JSON.parse(line) as Partial<RehydratedTurn>;
    if (typeof raw.entryId !== 'number') return null;
    return {
      entryId: raw.entryId,
      user: typeof raw.user === 'string' ? raw.user : '',
      assistant: typeof raw.assistant === 'string' ? raw.assistant : '',
      timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : 0,
    };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export function createIdxRehydrator(
  transcriptsDir: string,
  sessionKeys: string[],
  defaultBleed = 2,
): (entryIds: number[], limit: number, bleed?: number) => Promise<RehydratedTurn[]> {
  return async (entryIds, limit, bleed = defaultBleed) => {
    // Expand each requested entryId with ±bleed neighbour turns so a fact in the
    // turn adjacent to the summary's sourceEntryId is recovered too. Mirrors core
    // rehydrate.ts (bleed=2); exact-only was missing neighbour-turn facts.
    const wanted = new Set<number>();
    for (const id of entryIds) {
      for (let d = -bleed; d <= bleed; d++) {
        const n = id + d;
        if (n >= 0) wanted.add(n);
      }
    }
    const locations = new Map<number, { filePath: string; offset: number }>();
    for (const filePath of transcriptFiles(transcriptsDir, sessionKeys)) {
      const idxPath = `${filePath}.idx`;
      if (!fs.existsSync(idxPath)) continue;
      let index: Record<string, number>;
      try {
        index = JSON.parse(fs.readFileSync(idxPath, 'utf8')) as Record<string, number>;
      } catch {
        continue;
      }
      for (const entryId of wanted) {
        const offset = index[String(entryId)];
        if (typeof offset === 'number' && !locations.has(entryId)) {
          locations.set(entryId, { filePath, offset });
        }
      }
    }

    // Keep the explicitly requested ids first (never let neighbour bleed crowd
    // them out of the limit), then fill remaining budget with neighbours; emit in
    // entryId (reading) order.
    const requestedFound = [...new Set(entryIds)].filter(id => locations.has(id));
    const requestedSet = new Set(requestedFound);
    const neighbourFound = [...locations.keys()].filter(id => !requestedSet.has(id));
    const keptIds = [...requestedFound, ...neighbourFound].slice(0, limit).sort((a, b) => a - b);
    const turns: RehydratedTurn[] = [];
    for (const entryId of keptIds) {
      const location = locations.get(entryId)!;
      const turn = readLineAt(location.filePath, location.offset);
      if (turn?.entryId === entryId) turns.push(turn);
    }
    return turns;
  };
}
