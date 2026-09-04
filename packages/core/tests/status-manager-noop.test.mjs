import assert from 'node:assert/strict';
import test from 'node:test';

import { StatusManager } from '../dist/store/status-manager.js';

test('same-status change is a no-op without update or audit and preserves supersededBy', async () => {
  const updateCalls = [];
  const auditRows = [];
  const entry = {
    metadata: JSON.stringify({ status: 'deprecated', supersededBy: 'first-replacement' }),
  };
  const store = {
    getById: async () => entry,
    update: async (...args) => updateCalls.push(args),
    recordStatusAudit: async row => {
      auditRows.push(row);
      return row.id;
    },
  };

  const result = await new StatusManager(store).changeStatus({
    memoryId: 'memory-1',
    toStatus: 'deprecated',
    reason: 'causal_update',
    source: 'test',
    supersededBy: 'later-replacement',
  });

  assert.equal(result.ok, true);
  assert.equal(result.fromStatus, 'deprecated');
  assert.equal(result.toStatus, 'deprecated');
  assert.equal(result.noOp, true);
  assert.deepEqual(updateCalls, []);
  assert.deepEqual(auditRows, []);
  assert.equal(JSON.parse(entry.metadata).supersededBy, 'first-replacement');
});

test('a real status change records the reason and source on the entry metadata', async () => {
  const updateCalls = [];
  const entry = { metadata: JSON.stringify({ status: 'active' }) };
  const store = {
    getById: async () => entry,
    update: async (id, patch) => updateCalls.push([id, patch]),
    recordStatusAudit: async row => row.id,
  };

  const result = await new StatusManager(store).changeStatus({
    memoryId: 'memory-1',
    toStatus: 'deprecated',
    reason: 'slot_supersedes',
    source: 'inbox-watcher.slot',
    supersededBy: 'replacement-1',
  });

  assert.equal(result.ok, true);
  assert.equal(updateCalls.length, 1);
  const written = JSON.parse(updateCalls[0][1].metadata);
  assert.equal(written.status, 'deprecated');
  assert.equal(written.statusReason, 'slot_supersedes');
  assert.equal(written.statusSource, 'inbox-watcher.slot');
  assert.equal(written.supersededBy, 'replacement-1');
});
