import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createMemoryRiver } from '@memory-river/core';

import {
  acquireServiceLock,
  createMemoryRiverHttpServer,
  serviceLockPath,
} from '../dist/index.js';
import { isAllowedRequest, requestPath } from '../dist/http.js';
import { createMemoryRiverClient } from '../../claude-code-plugin/lib/http.mjs';

async function bestEffortRm(target, options) {
  try {
    await rm(target, options);
  } catch (error) {
    console.warn(`[test-teardown] best-effort rm failed for ${target}:`, error?.code ?? error);
  }
}

class MockEmbedder {
  getDimensions() {
    return 1024;
  }

  async embed(text) {
    const vector = new Array(1024).fill(0);
    for (const word of String(text).toLowerCase().split(/\W+/)) {
      if (!word) continue;
      let hash = 0;
      for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % 1024;
      vector[hash] = 1;
    }
    return vector;
  }

  async embedBatch(texts) {
    return Promise.all(texts.map(text => this.embed(text)));
  }

  async healthCheck() {
    return true;
  }
}

async function withTestService(fn) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'memory-river-service-'));
  const river = createMemoryRiver(
    { dataDir, ramDir: path.join(dataDir, 'ram') },
    { embedder: new MockEmbedder() },
  );
  let server;
  try {
    await river.start();
    server = createMemoryRiverHttpServer({
      river,
      dataDir,
      sessionKey: 'service-test-session',
    });
    return await fn({ dataDir, server });
  } finally {
    await river.stop().catch(() => {});
    await bestEffortRm(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

async function requestJson(server, method, url, body, headers = {}) {
  const payload = body === undefined ? [] : [JSON.stringify(body)];
  const request = Readable.from(payload);
  request.method = method;
  request.url = url;
  request.headers = {
    host: '127.0.0.1:4791',
    'content-type': 'application/json',
    ...headers,
  };

  return await new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      writeHead(statusCode) {
        this.statusCode = statusCode;
      },
      end(chunk) {
        try {
          resolve({
            status: this.statusCode,
            body: JSON.parse(chunk?.toString() || 'null'),
          });
        } catch (error) {
          reject(error);
        }
      },
    };
    server.emit('request', request, response);
  });
}

test('health returns ok, version, and uptime without the data directory', async () => {
  await withTestService(async ({ server }) => {
    const { status, body } = await requestJson(server, 'GET', '/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, 'string');
    assert.equal('dataDir' in body, false);
    assert.equal(Number.isInteger(body.uptimeSec), true);
  });
});

test('HTTP request policy rejects cross-site requests and non-JSON POSTs', async () => {
  const remembered = [];
  const server = createMemoryRiverHttpServer({
    river: { async remember(text) { remembered.push(text); } },
    dataDir: path.join(tmpdir(), 'memory-river-http-security-test'),
    sessionKey: 'http-security-test',
  });

  const externalHost = await requestJson(server, 'POST', '/store', { text: 'blocked by host' }, {
    host: '127.0.0.1.attacker.example:4791',
  });
  assert.equal(externalHost.status, 403);

  const externalOrigin = await requestJson(server, 'POST', '/store', { text: 'blocked by origin' }, {
    origin: 'https://attacker.example',
  });
  assert.equal(externalOrigin.status, 403);

  const textPlain = await requestJson(server, 'POST', '/store', { text: 'blocked by content type' }, {
    'content-type': 'text/plain',
  });
  assert.equal(textPlain.status, 415);

  const pluginRequest = await requestJson(server, 'POST', '/store', { text: 'plugin request' }, {
    host: 'localhost:4791',
  });
  assert.equal(pluginRequest.status, 200);

  const localOrigin = await requestJson(server, 'POST', '/store', { text: 'loopback origin' }, {
    host: '[::1]:4791',
    origin: 'http://127.0.0.1:7777',
  });
  assert.equal(localOrigin.status, 200);
  assert.deepEqual(remembered, ['plugin request', 'loopback origin']);
});

test('HTTP header policy can be called without opening a socket', () => {
  assert.equal(isAllowedRequest({ host: '127.0.0.1:4791' }), true);
  assert.equal(isAllowedRequest({ host: 'localhost' }), true);
  assert.equal(isAllowedRequest({ host: '[::1]:7777' }), true);
  assert.equal(isAllowedRequest({ host: '127.0.0.1.attacker.example' }), false);
  assert.equal(isAllowedRequest({ host: 'localhost', origin: 'https://attacker.example' }), false);
  assert.equal(isAllowedRequest({ host: 'localhost', origin: 'http://[::1]:7777' }), true);
});

test('ordinary HTTP routes reject bodies larger than one mebibyte', async () => {
  const remembered = [];
  const server = createMemoryRiverHttpServer({
    river: { async remember(text) { remembered.push(text); } },
    dataDir: path.join(tmpdir(), 'memory-river-http-body-limit-test'),
    sessionKey: 'http-body-limit-test',
  });

  const oversized = await requestJson(server, 'POST', '/store', {
    text: 'x'.repeat(1024 * 1024 + 1),
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(remembered, []);
});

test('archive-transcript accepts the large JSON body sent by the plugin', async () => {
  let archived;
  const server = createMemoryRiverHttpServer({
    river: {
      async archiveTranscript(session, messages) {
        archived = { session, messages };
        return { ok: true };
      },
    },
    dataDir: path.join(tmpdir(), 'memory-river-http-archive-size-test'),
    sessionKey: 'http-archive-size-test',
  });
  const content = 'x'.repeat(5 * 1024 * 1024);

  let outgoingRequest;
  const client = createMemoryRiverClient({
    baseUrl: 'http://127.0.0.1:4791',
    fetchImpl: async (url, options) => {
      outgoingRequest = { url, options };
      const pathname = url.slice('http://127.0.0.1:4791'.length);
      const response = await requestJson(
        server,
        options.method,
        pathname,
        JSON.parse(options.body),
        options.headers,
      );
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: async () => response.body,
      };
    },
  });
  const result = await client.archiveTranscript(
    { sessionKey: 'cc-large-transcript' },
    [{ role: 'assistant', content }],
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(outgoingRequest.url, 'http://127.0.0.1:4791/archive-transcript');
  assert.equal(outgoingRequest.options.method, 'POST');
  assert.equal(outgoingRequest.options.headers['content-type'], 'application/json');
  assert.ok(Buffer.byteLength(outgoingRequest.options.body) > 5 * 1024 * 1024);
  assert.equal(archived.session.sessionKey, 'cc-large-transcript');
  assert.equal(archived.messages[0].content.length, content.length);
});

test('rehydrate clamps limit and bleed to safe ranges', async () => {
  const calls = [];
  const server = createMemoryRiverHttpServer({
    river: {
      async rehydrate(request) {
        calls.push(request);
        return request;
      },
    },
    dataDir: path.join(tmpdir(), 'memory-river-http-numeric-limits-test'),
    sessionKey: 'http-numeric-limits-test',
  });

  await requestJson(server, 'POST', '/rehydrate', { entryIds: [], limit: 100000, bleed: -3 });
  await requestJson(server, 'POST', '/rehydrate', { entryIds: [], limit: -5, bleed: 500 });

  assert.equal(calls[0].limit, 100);
  assert.equal(calls[0].bleed, 0);
  assert.equal(calls[1].limit, 1);
  assert.equal(calls[1].bleed, 20);
});

test('recall clamps limit before calling the memory engine', async () => {
  const limits = [];
  const server = createMemoryRiverHttpServer({
    river: {
      async recall(_query, limit) {
        limits.push(limit);
        return [];
      },
    },
    dataDir: path.join(tmpdir(), 'memory-river-http-recall-limit-test'),
    sessionKey: 'http-recall-limit-test',
  });

  const result = await requestJson(server, 'POST', '/recall', { query: 'limit test', limit: 100000 });

  assert.equal(result.status, 200);
  assert.deepEqual(limits, [100]);
});

test('malformed request URLs return 400 without an unhandled rejection', async () => {
  const server = createMemoryRiverHttpServer({
    river: {},
    dataDir: path.join(tmpdir(), 'memory-river-http-invalid-url-test'),
    sessionKey: 'http-invalid-url-test',
  });
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  let status;
  try {
    const request = Readable.from([]);
    request.method = 'POST';
    request.url = 'http://[';
    request.headers = { host: '127.0.0.1:4791', 'content-type': 'application/json' };
    server.emit('request', request, {
      writeHead(statusCode) { status = statusCode; },
      end() {},
    });
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  assert.deepEqual(unhandled, []);
  assert.equal(status, 400);
});

test('request path parsing does not throw on malformed URLs', () => {
  let path;
  assert.doesNotThrow(() => {
    path = requestPath({ url: 'http://[' });
  });
  assert.equal(path, null);
});

test('store then recall returns the memory and a non-empty block', async () => {
  await withTestService(async ({ server }) => {
    const phrase = 'service recall smoke memory amber-719';
    const stored = await requestJson(server, 'POST', '/store', {
      text: phrase,
      category: 'fact',
      importance: 0.8,
    });
    assert.equal(stored.status, 200);
    assert.equal(stored.body.ok, true);

    const recalled = await requestJson(server, 'POST', '/recall', {
      query: 'amber-719',
      limit: 5,
    });
    assert.equal(recalled.status, 200);
    assert.equal(Array.isArray(recalled.body.results), true);
    assert.match(JSON.stringify(recalled.body.results), /amber-719/);
    assert.equal(typeof recalled.body.block, 'string');
    assert.ok(recalled.body.block.length > 0);
    assert.match(recalled.body.block, /amber-719/);
  });
});

test('rehydrate expands range strings like the existing integer-array input', async () => {
  const calls = [];
  const river = {
    async rehydrate(request) {
      calls.push(request);
      return request.entryIds.map(entryId => ({ entryId }));
    },
  };
  const server = createMemoryRiverHttpServer({
    river,
    dataDir: '/tmp/memory-river-service-entry-ids-test',
    sessionKey: 'service-entry-ids-test',
  });
  const ids = Array.from({ length: 18 }, (_, index) => 336 + index);

  const fromRange = await requestJson(server, 'POST', '/rehydrate', { entryIds: '336-353' });
  const fromArray = await requestJson(server, 'POST', '/rehydrate', { entryIds: ids });
  const fromMultipleRanges = await requestJson(server, 'POST', '/rehydrate', {
    entryIds: '336-340,348-353',
  });

  assert.deepEqual(fromRange.body, fromArray.body);
  assert.deepEqual(fromMultipleRanges.body.map(entry => entry.entryId), [
    336, 337, 338, 339, 340, 348, 349, 350, 351, 352, 353,
  ]);
  assert.deepEqual(calls.map(call => call.entryIds), [ids, ids, [
    336, 337, 338, 339, 340, 348, 349, 350, 351, 352, 353,
  ]]);

  for (const value of ['', 'abc', '5-3']) {
    let result;
    await assert.doesNotReject(async () => {
      result = await requestJson(server, 'POST', '/rehydrate', { entryIds: value });
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, []);
  }
});

async function waitFor(predicate, label, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForExit(child, timeoutMs = 10000) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('timed out waiting for process exit'));
    }, timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test('lockfile rejects a second live instance', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'memory-river-service-lock-'));
  const lock = await acquireServiceLock(dataDir);
  try {
    const firstPid = (await readFile(serviceLockPath(dataDir), 'utf8')).trim();
    assert.equal(firstPid, String(process.pid));

    await assert.rejects(
      () => acquireServiceLock(dataDir),
      error => {
        assert.match(error.message, /held by live pid/);
        assert.match(error.message, new RegExp(String(process.pid)));
        return true;
      },
    );
  } finally {
    await lock.release().catch(() => {});
    await bestEffortRm(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

function spawnServeWithMockedListen(dataDir) {
  const cliUrl = new URL('../dist/cli.js', import.meta.url).href;
  const script = `
    import { Server } from 'node:net';
    Server.prototype.listen = function(...args) {
      const callback = args.find(arg => typeof arg === 'function');
      process.nextTick(() => {
        this.emit('listening');
        if (callback) callback.call(this);
      });
      return this;
    };
    Server.prototype.address = function() {
      return { address: '127.0.0.1', family: 'IPv4', port: 0 };
    };
    Server.prototype.close = function(callback) {
      process.nextTick(() => callback?.());
      return this;
    };
    await import(${JSON.stringify(cliUrl)});
  `;
  return spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      MEMORY_RIVER_DATA_DIR: dataDir,
      MEMORY_RIVER_RAM_DIR: path.join(dataDir, 'ram'),
      MR_SERVE_PORT: '0',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

test('SIGTERM stops the daemon and removes the lockfile', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'memory-river-service-term-'));
  const serviceLock = serviceLockPath(dataDir);
  const running = spawnServeWithMockedListen(dataDir);
  try {
    await waitFor(() => existsSync(serviceLock), 'lockfile');
    running.kill('SIGTERM');
    const exit = await waitForExit(running);
    assert.equal(exit.code, 143);
    await waitFor(() => !existsSync(serviceLock), 'lockfile removal');
  } finally {
    if (!running.killed) running.kill('SIGKILL');
    await bestEffortRm(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});
