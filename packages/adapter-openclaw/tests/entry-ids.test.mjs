import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeRecorder() {
  const fn = (...args) => {
    fn.calls.push(args);
  };
  fn.calls = [];
  return fn;
}

function makeApi(root) {
  return {
    logger: { info: makeRecorder(), warn: makeRecorder(), error: makeRecorder(), debug: makeRecorder() },
    pluginConfig: {
      dbPath: path.join(root, 'ssd'),
      ramDbPath: path.join(root, 'ram'),
      inboxPath: path.join(root, 'inbox'),
      embedding: { provider: 'ollama', model: 'test-embedding', dimensions: 8 },
      autoRecall: false,
    },
    registerHook: makeRecorder(),
    on: makeRecorder(),
    registerTool: makeRecorder(),
    registerService: makeRecorder(),
    registerContextEngine: makeRecorder(),
  };
}

function writeTranscript(root, sessionKey) {
  const transcriptDir = path.join(root, 'transcripts');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const entries = Array.from({ length: 18 }, (_, index) => {
    const entryId = 336 + index;
    return JSON.stringify({
      entryId,
      sessionId: sessionKey,
      user: `user ${entryId}`,
      assistant: `assistant ${entryId}`,
      timestamp: entryId,
    });
  });
  fs.writeFileSync(path.join(transcriptDir, `${sessionKey}.jsonl`), `${entries.join('\n')}\n`);
}

function entriesFrom(result) {
  return JSON.parse(result.content[0].text).entries;
}

test('OpenClaw rehydrate accepts equivalent range and number-array entryIds', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-openclaw-entry-ids-'));
  const oldHome = process.env.HOME;
  const oldTranscriptPath = process.env.MEMORY_TRANSCRIPT_PATH;
  process.env.HOME = root;
  process.env.MEMORY_TRANSCRIPT_PATH = path.join(root, 'transcripts');
  const sessionKey = 'openclaw-entry-ids-test';
  const ids = Array.from({ length: 18 }, (_, index) => 336 + index);

  try {
    const mod = await import(`../dist/index.js?entry_ids=${Date.now()}`);
    mod.__memoryRiverTestHooks.resetState();
    mod.__memoryRiverTestHooks.setState({ pluginInitPromise: new Promise(() => {}) });
    writeTranscript(root, sessionKey);
    const api = makeApi(root);
    mod.default.register(api);
    const tool = api.registerTool.calls.map(([registered]) => registered)
      .find(registered => registered.name === 'memory_rehydrate');
    assert.deepEqual(
      tool.parameters.properties.entryIds.anyOf.map(schema => schema.type).sort(),
      ['array', 'string'],
    );
    const common = { mode: 'entry_ids', sessionKey, bleed: 0, limit: 200 };

    const fromRange = await tool.execute('id', { ...common, entryIds: '336-353' });
    const fromArray = await tool.execute('id', { ...common, entryIds: ids });
    const fromMultipleRanges = await tool.execute('id', {
      ...common,
      entryIds: '336-340,348-353',
    });

    assert.deepEqual(entriesFrom(fromRange), entriesFrom(fromArray));
    assert.deepEqual(entriesFrom(fromMultipleRanges).map(entry => entry.entryId), [
      336, 337, 338, 339, 340, 348, 349, 350, 351, 352, 353,
    ]);
    for (const value of ['', 'abc', '5-3']) {
      let result;
      await assert.doesNotReject(async () => {
        result = await tool.execute('id', { ...common, entryIds: value });
      });
      assert.equal(result.isError, true);
      assert.deepEqual(JSON.parse(result.content[0].text), { error: 'entryIds 不可空' });
    }
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldTranscriptPath === undefined) delete process.env.MEMORY_TRANSCRIPT_PATH;
    else process.env.MEMORY_TRANSCRIPT_PATH = oldTranscriptPath;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${root}:`, error?.code ?? error);
    }
  }
});
