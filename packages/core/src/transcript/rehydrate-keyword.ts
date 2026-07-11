import * as fs from 'node:fs';
import * as path from 'node:path';

import { rankKeywordMatches } from './keyword-search.js';
import type { TranscriptEntry } from './rehydrate.js';

const MAX_KEYWORD_RESULTS = 200;

export async function rehydrateByKeyword(
  transcriptsDir: string,
  keyword: string,
  opts?: { sessionKey?: string; limit?: number; offset?: number },
): Promise<TranscriptEntry[]> {
  if (!fs.existsSync(transcriptsDir)) return [];
  const files = fs.readdirSync(transcriptsDir)
    .filter(file => file.endsWith('.jsonl') && !file.endsWith('.idx'))
    .filter(file => !opts?.sessionKey || file === `${opts.sessionKey}.jsonl` || file.startsWith(`${opts.sessionKey}.`))
    .sort((a, b) => fs.statSync(path.join(transcriptsDir, b)).mtimeMs - fs.statSync(path.join(transcriptsDir, a)).mtimeMs)
    .slice(0, opts?.sessionKey ? undefined : 10);
  const candidates: Array<{ value: TranscriptEntry; text: string; timestamp: number }> = [];
  for (const file of files) {
    for (const line of fs.readFileSync(path.join(transcriptsDir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as TranscriptEntry;
        const text = `${entry.user ?? ''} ${entry.assistant ?? ''}`.toLowerCase();
        candidates.push({ value: entry, text, timestamp: entry.timestamp });
      } catch {}
    }
  }
  const offset = opts?.offset ?? 0;
  const limit = Math.min(opts?.limit ?? 10, MAX_KEYWORD_RESULTS);
  return rankKeywordMatches(candidates, keyword).slice(offset, offset + limit);
}
