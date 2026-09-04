import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { resolveSessionIdentity, setFallbackObserver } from '../dist/util/session-identity.js';
import { InboxWatcher } from '../dist/pipeline/inbox-watcher.js';

function withObserver(fn) {
  const seen = [];
  setFallbackObserver(info => seen.push(info));
  try {
    fn();
  } finally {
    setFallbackObserver(null);
  }
  return seen;
}

test('沒有 session 身分時預設仍然通知 observer', () => {
  const seen = withObserver(() => {
    const id = resolveSessionIdentity({});
    assert.equal(id.isFallback, true);
    assert.equal(id.canonicalKey, 'global');
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ctx, 'resolveSessionIdentity');
});

test('silentFallback 讓預期中的 fallback 不通知 observer', () => {
  const seen = withObserver(() => {
    const id = resolveSessionIdentity({}, { silentFallback: true });
    assert.equal(id.isFallback, true);
    assert.equal(id.canonicalKey, 'global');
  });
  assert.deepEqual(seen, []);
});

test('river capsule 保底走檔名,不算 fallback 事件', () => {
  const watcher = Object.create(InboxWatcher.prototype);
  const filePath = path.join('/tmp', 'river_capsule_123.txt');
  const seen = withObserver(() => {
    const key = watcher.getRiverCapsuleSessionKey({}, filePath);
    assert.equal(key, 'river_capsule_123.txt');
  });
  assert.deepEqual(seen, []);
});

test('river capsule 有 sessionKey 時照常用它當 key', () => {
  const watcher = Object.create(InboxWatcher.prototype);
  const seen = withObserver(() => {
    const key = watcher.getRiverCapsuleSessionKey(
      { metadata: { sessionKey: 'sess-abc' } },
      '/tmp/river_capsule_456.txt',
    );
    assert.equal(key, 'sess-abc');
  });
  assert.deepEqual(seen, []);
});
