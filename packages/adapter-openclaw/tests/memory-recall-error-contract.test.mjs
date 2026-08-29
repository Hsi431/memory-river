import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const buildDir = process.env.MEMORY_RIVER_BUILD_DIR
  ? path.resolve(process.env.MEMORY_RIVER_BUILD_DIR)
  : path.resolve('dist');

let importCounter = 0;

async function freshHooks() {
  const mod = await import(`${pathToFileURL(path.join(buildDir, 'index.js')).href}?memory_recall_contract=${importCounter++}`);
  const hooks = mod.__memoryRiverTestHooks;
  assert.ok(hooks, '__memoryRiverTestHooks export is required');
  hooks.resetState();
  return hooks;
}

test('memory_recall init failure returns isError contract', async () => {
  const hooks = await freshHooks();
  hooks.setState({
    pluginInitPromise: Promise.reject(new Error('boom init')),
    pluginInitialized: false,
  });

  const result = await hooks.executeMemoryRecall({ query: 'alpha' });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /MEMORY_RIVER_INIT_FAILED/);
  assert.match(result.content[0].text, /boom init/);
});

test('memory_recall retrieverRef null returns init failed isError', async () => {
  const hooks = await freshHooks();
  hooks.setState({
    pluginInitPromise: Promise.resolve(),
    pluginInitialized: true,
    retrieverRef: null,
  });

  const result = await hooks.executeMemoryRecall({ query: 'alpha' });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /MEMORY_RIVER_INIT_FAILED/);
});

test('memory_recall empty result includes queryHash and searched count without isError', async () => {
  const hooks = await freshHooks();
  hooks.setState({
    pluginInitPromise: Promise.resolve(),
    pluginInitialized: true,
    retrieverRef: {
      hybridSearch: async () => ({ results: [], queryHash: 'abc12345' }),
      getStore: () => ({ count: async () => 42 }),
    },
  });

  const result = await hooks.executeMemoryRecall({ query: 'alpha' });

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, '查無相關記憶 (queryHash=abc12345, searched=42 memories)');
});

test('memory_recall normal result carries the temporal-label legend', async () => {
  const hooks = await freshHooks();
  hooks.setState({
    pluginInitPromise: Promise.resolve(),
    pluginInitialized: true,
    retrieverRef: {
      hybridSearch: async () => ({
        results: [
          { entry: { text: 'first memory' } },
          { entry: { text: 'second memory' } },
        ],
        queryHash: 'abc12345',
      }),
      getStore: () => ({ count: async () => 2 }),
    },
  });

  const result = await hooks.executeMemoryRecall({ query: 'alpha' });

  // bdd93d3 之後 recall 會在標頭後面帶一行時間標籤的說明(無論這批記憶有沒有標籤都會帶)。
  assert.deepEqual(result, {
    content: [{
      type: 'text',
      text: '[相關記憶]\n'
        + '[時間標籤為候選證據，`事件日期` 是記憶宣稱的事件時間、`的對話` 是這段話被講出來的日期；沒有標籤代表時間不明。]\n'
        + '• first memory\n• second memory',
    }],
  });
});
