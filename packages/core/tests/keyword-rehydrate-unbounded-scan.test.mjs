import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { rehydrateByKeyword } from '../dist/transcript/rehydrate-keyword.js';

test('keyword rehydrate reaches matching transcript files older than the newest ten', async () => {
  const transcriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'F3-keyword-rehydrate-'));
  try {
    for (let index = 0; index < 11; index += 1) {
      const file = path.join(transcriptsDir, `session-${index}.jsonl`);
      const entry = {
        entryId: index + 1,
        sessionId: `session-${index}`,
        user: index === 0 ? 'needle in the oldest transcript' : 'unrelated transcript content',
        assistant: '',
        timestamp: index + 1,
      };
      fs.writeFileSync(file, `${JSON.stringify(entry)}\n`);
      const mtime = new Date(10000 + index * 1000);
      fs.utimesSync(file, mtime, mtime);
    }

    const results = await rehydrateByKeyword(transcriptsDir, 'needle', { limit: 10 });
    assert.deepEqual(results.map(entry => entry.entryId), [1]);
  } finally {
    fs.rmSync(transcriptsDir, { recursive: true, force: true });
  }
});
