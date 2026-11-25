import assert from 'node:assert/strict';
import test from 'node:test';

import { HooksEngine } from '../dist/cognition/hooks-engine.js';

test('hook quality uses only the latest ten reported outcomes', async () => {
  const keyword = 'database migration';
  const memory = {
    id: 'memory-database-migration',
    text: 'memory for database migration',
    category: 'fact',
    importance: 0.8,
    metadata: { hooks: [{ keyword, weight: 'high', weightScore: 1 }] },
    createdAt: 1,
    updatedAt: 1,
  };
  const engine = new HooksEngine({
    queryHookBearing: async () => [memory],
    onShutdown: () => {},
  }, {
    embed: async () => [1, 0],
  }, { cooldownMs: 1, minTriggerScore: 0.1 });
  const originalReadonly = process.env.MR_OTTER_READONLY;
  const originalLog = console.log;
  const logs = [];
  const originalDateNow = Date.now;
  let fakeNow = 1_000;
  delete process.env.MR_OTTER_READONLY;
  console.log = (...args) => logs.push(args.join(' '));
  Date.now = () => (fakeNow += 2);

  try {
    for (let index = 0; index < 20; index++) {
      const result = await engine.triggerHooks(keyword);
      assert.equal(result.triggered, true);
      await engine.reportHookOutcome(keyword, index < 10);
    }

    const quality = engine.qualityTracker.get(keyword);
    assert.equal(quality.triggerCount, 20);
    assert.equal(quality.successCount, 10);
    assert.equal(quality.failCount, 10);
    assert.ok(logs.some(message => message.includes('(rate=0.00)')));
  } finally {
    await engine.flush();
    console.log = originalLog;
    Date.now = originalDateNow;
    if (originalReadonly === undefined) delete process.env.MR_OTTER_READONLY;
    else process.env.MR_OTTER_READONLY = originalReadonly;
  }
});
