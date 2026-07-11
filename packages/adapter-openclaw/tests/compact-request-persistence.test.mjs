import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  CompactRequestSchemaError,
  buildCompactRequestFilename,
  isCompactRequestFilename,
  readCompactRequest,
  validateCompactRequest,
  writeCompactRequest,
} from '@memory-river/core/pipeline/compact-request';
import { InboxWatcher } from '@memory-river/core/pipeline/inbox-watcher';
import { __asyncCompactTestHooks } from '../dist/index.js';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeItem(overrides = {}) {
  return {
    type: 'compact_request',
    version: 1,
    requestId: randomUUID(),
    trackingKey: 'canonical:test:stage2',
    sessionId: 'session-id',
    sessionKey: 'session-key',
    originalTokens: 42000,
    compressedTokens: 12000,
    createdAt: Date.now(),
    source: 'asyncCompactAfterAssemble',
    ...overrides,
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

test('validateCompactRequest rejects invalid fields with CompactRequestSchemaError', () => {
  const invalidCases = [
    null,
    {},
    makeItem({ type: 'memory' }),
    makeItem({ version: 2 }),
    makeItem({ requestId: '' }),
    makeItem({ trackingKey: '' }),
    makeItem({ originalTokens: Number.NaN }),
    makeItem({ compressedTokens: Infinity }),
    makeItem({ createdAt: 'now' }),
    makeItem({ source: 'other' }),
    makeItem({ sessionId: 123 }),
    makeItem({ sessionKey: false }),
  ];

  for (const invalid of invalidCases) {
    assert.throws(() => validateCompactRequest(invalid), CompactRequestSchemaError);
  }
});

test('buildCompactRequestFilename and isCompactRequestFilename agree', () => {
  const item = makeItem({ createdAt: 1777969711702, requestId: randomUUID() });
  const filename = buildCompactRequestFilename(item);

  assert.match(filename, /^compact_request_1777969711702_[0-9a-f-]+\.json$/i);
  assert.equal(isCompactRequestFilename(filename), true);
  assert.equal(isCompactRequestFilename(filename + '.processing'), false);
  assert.equal(isCompactRequestFilename('pending_1777969711702_abc.json'), false);
});

test('writeCompactRequest and readCompactRequest round-trip', async () => {
  const root = makeTempDir('compact-request-roundtrip-');
  try {
    const item = makeItem();
    const filePath = await writeCompactRequest(root, item);
    const readBack = await readCompactRequest(filePath);
    assert.deepEqual(readBack, item);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeCompactRequest leaves only final json filename after atomic rename', async () => {
  const root = makeTempDir('compact-request-atomic-');
  try {
    const item = makeItem();
    const filePath = await writeCompactRequest(root, item);
    const files = fs.readdirSync(root);

    assert.equal(path.basename(filePath), buildCompactRequestFilename(item));
    assert.equal(filePath.endsWith('.json'), true);
    assert.equal(files.some(file => file.endsWith('.tmp')), false);
    assert.deepEqual(files, [path.basename(filePath)]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('InboxWatcher consumes compact_request json and deletes it on success', async () => {
  const root = makeTempDir('compact-request-watch-');
  try {
    const item = makeItem();
    const filePath = await writeCompactRequest(root, item);
    const calls = [];
    const watcher = new InboxWatcher(
      {},
      {},
      {},
      null,
      null,
      { generate: async () => '' },
      root,
      2000,
      undefined,
      {},
      async (req) => { calls.push(req); },
    );

    await watcher.processInbox('start');

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      trackingKey: item.trackingKey,
      sessionId: item.sessionId,
      sessionKey: item.sessionKey,
      originalTokens: item.originalTokens,
      compressedTokens: item.compressedTokens,
      timestamp: item.createdAt,
    });
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(fs.existsSync(filePath + '.processing'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('enqueueAsyncCompact blocks duplicate trackingKey before writing second file', async () => {
  const root = makeTempDir('compact-request-dup-');
  try {
    __asyncCompactTestHooks.reset();
    __asyncCompactTestHooks.setInboxPath(root);
    const req = {
      trackingKey: 'canonical:test:dup',
      sessionId: 'sid',
      sessionKey: 'skey',
      originalTokens: 40000,
      compressedTokens: 10000,
      timestamp: Date.now(),
    };

    __asyncCompactTestHooks.enqueue(req);
    __asyncCompactTestHooks.enqueue(req);

    const wrote = await waitFor(() => fs.readdirSync(root).some(file => isCompactRequestFilename(file)));
    assert.equal(wrote, true);
    assert.equal(fs.readdirSync(root).filter(file => isCompactRequestFilename(file)).length, 1);
  } finally {
    __asyncCompactTestHooks.reset();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('enqueueAsyncCompact releases queued key when inbox write fails', async () => {
  const root = makeTempDir('compact-request-write-fail-');
  const notDirectory = path.join(root, 'not-a-dir');
  fs.writeFileSync(notDirectory, 'occupied', 'utf-8');
  try {
    __asyncCompactTestHooks.reset();
    __asyncCompactTestHooks.setInboxPath(notDirectory);
    const trackingKey = 'canonical:test:write-fail';
    __asyncCompactTestHooks.enqueue({
      trackingKey,
      originalTokens: 40000,
      compressedTokens: 10000,
      timestamp: Date.now(),
    });

    const released = await waitFor(() => !__asyncCompactTestHooks.isQueued(trackingKey));
    assert.equal(released, true);
  } finally {
    __asyncCompactTestHooks.reset();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('compact request processor normal no-op return is treated as success', async () => {
  const root = makeTempDir('compact-request-noop-');
  try {
    const item = makeItem({ trackingKey: 'canonical:test:race-abort' });
    const filePath = await writeCompactRequest(root, item);
    const watcher = new InboxWatcher(
      {},
      {},
      {},
      null,
      null,
      { generate: async () => '' },
      root,
      2000,
      undefined,
      {},
      async () => {},
    );

    await watcher.processInbox('start');

    assert.equal(fs.existsSync(filePath), false);
    assert.equal(fs.existsSync(path.join(root, 'error', path.basename(filePath))), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('compact request retry exhausts and moves request to inbox error dead-letter', async () => {
  const root = makeTempDir('compact-request-dead-letter-');
  try {
    const item = makeItem({ trackingKey: 'canonical:test:dead-letter' });
    const filePath = await writeCompactRequest(root, item);
    let attempts = 0;
    const watcher = new InboxWatcher(
      {},
      {},
      {},
      null,
      null,
      { generate: async () => '' },
      root,
      2000,
      undefined,
      {},
      async () => {
        attempts += 1;
        throw new Error('lance io error: simulated compact request retry failure');
      },
    );

    await watcher.processInbox('start');

    const errorPath = path.join(root, 'error', path.basename(filePath));
    assert.equal(attempts, 3);
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(fs.existsSync(filePath + '.processing'), false);
    assert.equal(fs.existsSync(errorPath), true);
    assert.deepEqual(await readCompactRequest(errorPath), item);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('orphan compact request processing file older than five minutes is restored to json', async () => {
  const root = makeTempDir('compact-request-orphan-');
  try {
    const item = makeItem({ trackingKey: 'canonical:test:orphan' });
    const filePath = await writeCompactRequest(root, item);
    const processingPath = filePath + '.processing';
    fs.renameSync(filePath, processingPath);
    const oldTime = new Date(Date.now() - 6 * 60 * 1000);
    fs.utimesSync(processingPath, oldTime, oldTime);
    const calls = [];
    const watcher = new InboxWatcher(
      {},
      {},
      {},
      null,
      null,
      { generate: async () => '' },
      root,
      2000,
      undefined,
      {},
      async (req) => { calls.push(req); },
    );

    await watcher.processInbox('start');

    assert.equal(fs.existsSync(processingPath), false);
    assert.equal(fs.existsSync(filePath), true);
    assert.deepEqual(await readCompactRequest(filePath), item);
    assert.equal(calls.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restart start trigger consumes pending compact request json files', async () => {
  const root = makeTempDir('compact-request-restart-');
  try {
    const first = makeItem({ trackingKey: 'canonical:test:restart-1', createdAt: Date.now() - 1 });
    const second = makeItem({ trackingKey: 'canonical:test:restart-2', createdAt: Date.now() });
    const firstPath = await writeCompactRequest(root, first);
    const secondPath = await writeCompactRequest(root, second);
    const calls = [];
    const watcher = new InboxWatcher(
      {},
      {},
      {},
      null,
      null,
      { generate: async () => '' },
      root,
      2000,
      undefined,
      {},
      async (req) => { calls.push(req); },
    );

    await watcher.processInbox('start');

    assert.deepEqual(
      new Set(calls.map(call => call.trackingKey)),
      new Set([first.trackingKey, second.trackingKey]),
    );
    assert.equal(fs.existsSync(firstPath), false);
    assert.equal(fs.existsSync(secondPath), false);
    assert.equal(fs.existsSync(firstPath + '.processing'), false);
    assert.equal(fs.existsSync(secondPath + '.processing'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
