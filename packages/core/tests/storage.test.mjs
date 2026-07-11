import assert from 'node:assert/strict';
import test from 'node:test';

import { MIN_RAM_DB_BYTES, resolveRamDbPath } from '../dist/storage.js';

test('auto storage uses RAM when /dev/shm can hold the conservative estimate', () => {
  const result = resolveRamDbPath({
    dbPath: '/ssd/lancedb',
    ramDbPath: '/dev/shm/memory-river/lancedb',
    getDbSizeBytes: () => 400 * 1024 * 1024,
    getShmFreeBytes: () => 900 * 1024 * 1024,
  });

  assert.equal(result.mode, 'ram');
  assert.equal(result.ramDbPath, '/dev/shm/memory-river/lancedb');
  assert.equal(result.requiredBytes, 800 * 1024 * 1024);
});

test('auto storage falls back to SSD with an override hint when /dev/shm is insufficient', () => {
  const logs = [];
  const result = resolveRamDbPath({
    dbPath: '/ssd/lancedb',
    ramDbPath: '/dev/shm/memory-river/lancedb',
    getDbSizeBytes: () => 0,
    getShmFreeBytes: () => MIN_RAM_DB_BYTES - 1,
    log: message => logs.push(message),
  });

  assert.equal(result.mode, 'ssd-fallback');
  assert.equal(result.ramDbPath, '/ssd/lancedb');
  assert.equal(result.requiredBytes, MIN_RAM_DB_BYTES);
  assert.match(logs[0], /storageMode=ram/);
});

test('explicit storage modes bypass auto detection', () => {
  assert.equal(resolveRamDbPath({
    dbPath: '/ssd/lancedb', ramDbPath: '/dev/shm/lancedb', storageMode: 'ram',
  }).ramDbPath, '/dev/shm/lancedb');
  assert.equal(resolveRamDbPath({
    dbPath: '/ssd/lancedb', ramDbPath: '/dev/shm/lancedb', storageMode: 'ssd',
  }).ramDbPath, '/ssd/lancedb');
});
