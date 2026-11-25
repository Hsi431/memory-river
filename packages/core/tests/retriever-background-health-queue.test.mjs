import assert from 'node:assert/strict';
import test from 'node:test';

import { Retriever } from '../dist/retrieval/retriever-v4.js';

const QUEUE_LIMIT = 100;
const originalEnv = {
  readonly: process.env.MR_OTTER_READONLY,
  crossEncoder: process.env.MR_CRAG_CROSS_ENCODER,
};

test.beforeEach(() => {
  delete process.env.MR_OTTER_READONLY;
  process.env.MR_CRAG_CROSS_ENCODER = '0';
});

test.afterEach(() => {
  if (originalEnv.readonly === undefined) delete process.env.MR_OTTER_READONLY;
  else process.env.MR_OTTER_READONLY = originalEnv.readonly;
  if (originalEnv.crossEncoder === undefined) delete process.env.MR_CRAG_CROSS_ENCODER;
  else process.env.MR_CRAG_CROSS_ENCODER = originalEnv.crossEncoder;
});

test('health queue reports each dropped write without blocking recall', async () => {
  const entry = {
    id: '00000000-0000-0000-0000-000000000001',
    text: 'A concrete memory recalled by the query.',
    vector: [1, 0],
    importance: 0.8,
    category: 'fact',
    parentId: null,
    metadata: JSON.stringify({ abstractness: 0, health: { healthScore: 100 } }),
    createdAt: 1,
    updatedAt: 1,
  };
  let releaseFirstBoost;
  let signalFirstBoost;
  const firstBoostBlocked = new Promise(resolve => { releaseFirstBoost = resolve; });
  const firstBoostStarted = new Promise(resolve => { signalFirstBoost = resolve; });
  const boostCalls = [];
  const queueDropStats = [];
  let blockFirstBoost = true;
  const store = {
    async hybridVectorSearch() {
      return [{
        entry,
        vectorScore: 1,
        rankScore: 1,
        rawDistance: 0,
        bm25Score: 0,
        fusedScore: 1,
      }];
    },
    async getById() {
      return entry;
    },
    async query() {
      return [];
    },
    async boostHealth(id) {
      boostCalls.push(id);
      if (blockFirstBoost) {
        blockFirstBoost = false;
        signalFirstBoost();
        await firstBoostBlocked;
      }
    },
    async recordMemoryRecalls() {},
    async recordConflictStat(stat) {
      queueDropStats.push(stat);
    },
  };
  const embedder = { async embed() { return [1, 0]; } };
  const retriever = new Retriever(store, embedder, {}, 'test-cache', null);
  const warnings = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = (...args) => warnings.push(args.join(' '));
  console.log = () => {};

  try {
    const first = await retriever.hybridSearch('health queue query', 1);
    await firstBoostStarted;
    assert.equal(first.results.length, 1);

    for (let index = 0; index < QUEUE_LIMIT + 3; index++) {
      const response = await retriever.hybridSearch('health queue query', 1);
      assert.equal(response.results.length, 1);
    }

    const dropCount = retriever.getBackgroundWriteQueueDropCount?.('boost_health_queue_drop') ?? 0;
    assert.equal(dropCount, 3);
    assert.equal(warnings.filter(message => message.includes('boost_health_queue_drop')).length, 3);
    assert.equal(queueDropStats.filter(stat => stat.operationName === 'boost_health_queue_drop').length, 3);
  } finally {
    releaseFirstBoost();
    await new Promise(resolve => setTimeout(resolve, 0));
    console.warn = originalWarn;
    console.log = originalLog;
  }
});
