import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryRiverEngine } from '../dist/engine.js';
import { createTranscriptArchive } from '../dist/transcript/transcript-archive.js';

test('compact keeps the original outer timestamp when rewriting the session file', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'F3-compact-timestamp-'));
  const sessionFile = path.join(root, 'session.jsonl');
  const timestamp = 1_710_000_000_000;
  fs.writeFileSync(sessionFile, [
    JSON.stringify({ type: 'session', id: 'timestamp-session' }),
    JSON.stringify({
      type: 'message',
      timestamp: new Date(timestamp).toISOString(),
      message: { role: 'user', content: 'original user message', timestamp },
    }),
    JSON.stringify({
      type: 'message',
      timestamp: new Date(timestamp + 1000).toISOString(),
      message: { role: 'assistant', content: 'original assistant message', timestamp: timestamp + 1000 },
    }),
  ].join('\n') + '\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const engine = new MemoryRiverEngine({}, {
    paths: {},
    transcriptArchive: createTranscriptArchive(path.join(root, 'transcripts')),
    deriveSessionFile: () => null,
    ollamaUrl: '',
    geminiApiKey: '',
    deepseekApiKey: '',
  });
  engine.activePluginConfig = { concentration: { asyncCompactRaceGuard: false } };
  engine.activeConcentrator = {
    async concentrate(messages) {
      return { wasConcentrated: true, status: 'complete', messages: [messages[0]] };
    },
    estimateTokens() {
      return 1;
    },
  };

  const result = await engine.compact({
    sessionId: 'timestamp-session',
    sessionKey: 'timestamp-session',
    sessionFile,
    force: true,
  });

  assert.equal(result.compacted, true);
  const rewritten = fs.readFileSync(sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rewritten[1].timestamp, new Date(timestamp).toISOString());
});
