import assert from 'node:assert/strict';
import test from 'node:test';

import { GraphStore } from '../dist/store/graph-store.js';

function makeStoreWithFailingSsd() {
  const store = new GraphStore({}, {}, { embed: async () => [0.1, 0.2, 0.3, 0.4] }, 4);
  store.ramTable = { add: async () => {} };
  store.ssdTable = { add: async () => { throw new Error('ssd add failed'); } };
  return store;
}

test('addTriple rejects when the SSD graph write fails', async () => {
  const store = makeStoreWithFailingSsd();

  await assert.rejects(
    store.addTriple({ subject: 'a', relation: 'relates_to', object: 'b' }, 'memory-1'),
    /ssd add failed/,
  );
});

test('addTriples rejects when the SSD graph batch write fails', async () => {
  const store = makeStoreWithFailingSsd();
  store.embedder = { embedBatch: async () => [[0.1, 0.2, 0.3, 0.4]] };

  await assert.rejects(
    store.addTriples([{ subject: 'a', relation: 'relates_to', object: 'b' }], 'memory-1'),
    /ssd add failed/,
  );
});
