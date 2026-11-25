import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { configFromEnv, defaultRamDir } from '../dist/config.js';

test('default data dir keeps the historical shared-memory RAM path', () => {
  const ramDir = defaultRamDir(path.join(os.homedir(), '.memory-river'));
  assert.equal(path.basename(ramDir), 'memory-river');
});

test('a different data dir gets its own RAM dir instead of sharing the default one', () => {
  const a = defaultRamDir('/tmp/mr-instance-a');
  const b = defaultRamDir('/tmp/mr-instance-b');
  assert.notEqual(a, b);
  assert.notEqual(path.basename(a), 'memory-river');
  assert.equal(a, defaultRamDir('/tmp/mr-instance-a'));
});

test('configFromEnv derives the RAM dir from MEMORY_RIVER_DATA_DIR unless RAM dir is set', () => {
  const saved = { data: process.env.MEMORY_RIVER_DATA_DIR, ram: process.env.MEMORY_RIVER_RAM_DIR, ram2: process.env.RAM_DIR };
  try {
    process.env.MEMORY_RIVER_DATA_DIR = '/tmp/mr-instance-c';
    delete process.env.MEMORY_RIVER_RAM_DIR;
    delete process.env.RAM_DIR;
    assert.equal(configFromEnv('/nonexistent/config.json').ramDir, defaultRamDir('/tmp/mr-instance-c'));
    process.env.MEMORY_RIVER_RAM_DIR = '/tmp/explicit-ram';
    assert.equal(configFromEnv('/nonexistent/config.json').ramDir, '/tmp/explicit-ram');
  } finally {
    for (const [key, value] of [['MEMORY_RIVER_DATA_DIR', saved.data], ['MEMORY_RIVER_RAM_DIR', saved.ram], ['RAM_DIR', saved.ram2]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
