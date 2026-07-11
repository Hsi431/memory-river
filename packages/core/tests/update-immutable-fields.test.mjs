import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStore } from '../dist/store/store-v4.js';

const VALID_ID = '11111111-1111-4111-8111-111111111111';

function makeFakeStore() {
  const calls = {
    ensureInitialized: 0,
    tokenizeChinese: [],
    appendWal: [],
    ramUpdates: [],
    ssdUpdates: [],
    commitWal: [],
  };

  const store = {
    ssdAvailable: true,
    ramTable: {
      async update(values, options) {
        calls.ramUpdates.push({ values, options });
      },
    },
    ssdTable: {
      async update(values, options) {
        calls.ssdUpdates.push({ values, options });
      },
    },
    async ensureInitialized() {
      calls.ensureInitialized += 1;
    },
    async tokenizeChinese(text) {
      calls.tokenizeChinese.push(text);
      return `tokens:${text}`;
    },
    async appendWal(entry) {
      calls.appendWal.push(entry);
      return 'txn-1';
    },
    async lancedbRetry(_label, fn) {
      return await fn();
    },
    async commitWal(id, txnId) {
      calls.commitWal.push({ id, txnId });
    },
    handleSsdError(err) {
      throw err;
    },
  };

  return { store, calls };
}

async function callUpdate(store, id, updates) {
  return await MemoryStore.prototype.update.call(store, id, updates);
}

test('update() accepts normal text updates', async () => {
  const { store, calls } = makeFakeStore();

  const result = await callUpdate(store, VALID_ID, { text: 'updated text' });

  assert.equal(result, true);
  assert.equal(calls.ensureInitialized, 1);
  assert.deepEqual(calls.tokenizeChinese, ['updated text']);
  assert.equal(calls.appendWal.length, 1);
  assert.equal(calls.appendWal[0].id, VALID_ID);
  assert.equal(calls.appendWal[0].values.text, 'updated text');
  assert.equal(calls.appendWal[0].values.textTokens, 'tokens:updated text');
  assert.equal(calls.ramUpdates.length, 1);
  assert.equal(calls.commitWal.length, 1);
});

for (const [field, value] of [
  ['id', '22222222-2222-4222-8222-222222222222'],
  ['textTokens', 'bad tokens'],
  ['vector', [0.1, 0.2, 0.3]],
  ['createdAt', 123],
]) {
  test(`update() rejects immutable field ${field}`, async () => {
    const { store, calls } = makeFakeStore();

    await assert.rejects(
      () => callUpdate(store, VALID_ID, { [field]: value }),
      new RegExp(`update\\(\\) rejected: cannot modify immutable field '${field}'`),
    );

    assert.equal(calls.ensureInitialized, 1);
    assert.equal(calls.appendWal.length, 0);
    assert.equal(calls.ramUpdates.length, 0);
    assert.equal(calls.ssdUpdates.length, 0);
    assert.equal(calls.commitWal.length, 0);
  });
}
