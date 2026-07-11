import test from 'node:test';
import assert from 'node:assert/strict';
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

test('memory_rehydrate marks validation and unknown-mode errors without marking empty results', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-rehydrate-errors-'));
  const oldHome = process.env.HOME;
  const oldTranscriptPath = process.env.MEMORY_TRANSCRIPT_PATH;
  process.env.HOME = root;
  process.env.MEMORY_TRANSCRIPT_PATH = path.join(root, 'transcripts');

  try {
    const mod = await import(`../dist/index.js?rehydrate_errors=${Date.now()}`);
    mod.__memoryRiverTestHooks.resetState();
    mod.__memoryRiverTestHooks.setState({ pluginInitPromise: new Promise(() => {}) });
    const registerTool = makeRecorder();
    mod.default.register({
      logger: { info() {}, warn() {}, error() {} },
      pluginConfig: {
        autoRecall: false,
        dbPath: path.join(root, 'ssd'),
        ramDbPath: path.join(root, 'ram'),
        inboxPath: path.join(root, 'inbox'),
        embedding: { dimensions: 4 },
      },
      registerTool,
      registerHook() {},
      on() {},
      registerService() {},
      registerContextEngine() {},
    });
    const tool = registerTool.calls.map(([registered]) => registered)
      .find(registered => registered.name === 'memory_rehydrate');

    const missingParam = await tool.execute('id', { mode: 'keyword' });
    const unknownMode = await tool.execute('id', { mode: 'unknown' });
    const emptyResult = await tool.execute('id', { mode: 'keyword', keyword: 'not-found' });

    assert.equal(missingParam.isError, true);
    assert.equal(unknownMode.isError, true);
    assert.equal(Object.hasOwn(emptyResult, 'isError'), false);
    assert.deepEqual(JSON.parse(emptyResult.content[0].text).entries, []);
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
