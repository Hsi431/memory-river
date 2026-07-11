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

async function requestJson(server, method, url, body) {
  const payload = body === undefined ? [] : [JSON.stringify(body)];
  const request = Readable.from(payload);
  request.method = method;
  request.url = url;

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

test('health returns ok, version, dataDir, and uptime', async () => {
  await withTestService(async ({ dataDir, server }) => {
    const { status, body } = await requestJson(server, 'GET', '/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, 'string');
    assert.equal(body.dataDir, dataDir);
    assert.equal(Number.isInteger(body.uptimeSec), true);
  });
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
