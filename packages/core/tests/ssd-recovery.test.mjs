import test from 'node:test';
import assert from 'node:assert/strict';

import { GraphStore } from '../dist/store/graph-store.js';
import { MemoryStore } from '../dist/store/store-v4.js';

const waitFor = async (predicate, timeoutMs = 250) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

const makeMemoryStore = (probeIntervalMs = 10) => (
  new MemoryStore('/tmp/unused-ssd', '/tmp/unused-ram', 4, undefined, undefined, undefined, probeIntervalMs)
);

const makeGraphStore = (probeIntervalMs = 10) => (
  new GraphStore({}, {}, { embed: async () => [0, 0, 0, 0] }, 4, probeIntervalMs)
);

for (const [name, makeStore] of [
  ['MemoryStore', makeMemoryStore],
  ['GraphStore', makeGraphStore],
]) {
  test(`${name}: one SSD failure does not degrade`, async () => {
    const store = makeStore();
    try {
      store.handleSsdError(new Error('transient'), 'test');

      assert.equal(store.ssdAvailable, true);
      assert.equal(store.ssdConsecutiveFailures, 1);
      assert.equal(store.ssdRecoveryProbeTimer, null);
    } finally {
      await store.shutdown();
    }
  });

  test(`${name}: successful SSD operation resets the consecutive failure count`, async () => {
    const store = makeStore();
    try {
      for (let i = 0; i < 4; i++) {
        store.handleSsdError(new Error('transient'), 'test');
      }
      store.handleSsdSuccess();
      for (let i = 0; i < 4; i++) {
        store.handleSsdError(new Error('transient'), 'test');
      }

      assert.equal(store.ssdAvailable, true);
      assert.equal(store.ssdConsecutiveFailures, 4);
    } finally {
      await store.shutdown();
    }
  });

  test(`${name}: degrades on five consecutive failures and recovers after a successful probe`, async () => {
    const store = makeStore();
    store.ssdTable = { countRows: async () => 1 };
    try {
      for (let i = 0; i < 4; i++) {
        store.handleSsdError(new Error('persistent'), 'test');
        assert.equal(store.ssdAvailable, true);
      }

      store.handleSsdError(new Error('persistent'), 'test');
      assert.equal(store.ssdAvailable, false);
      assert.notEqual(store.ssdRecoveryProbeTimer, null);
      assert.equal(store.ssdRecoveryProbeTimer.hasRef(), false);

      await waitFor(() => store.ssdAvailable);
      assert.equal(store.ssdConsecutiveFailures, 0);
      assert.equal(store.ssdRecoveryProbeTimer, null);
    } finally {
      await store.shutdown();
    }
  });
}
