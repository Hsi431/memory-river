import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { connect } from '@lancedb/lancedb';
import { MemoryStore } from '../dist/store/store-v4.js';

async function rowsForId(dbPath, id) {
  const db = await connect(dbPath);
  const table = await db.openTable('memories');
  return await table.query().where(`id = '${id}'`).toArray();
}

function comparableRows(rows) {
  return rows.map((row) => ({ ...row, vector: Array.from(row.vector ?? []) }));
}

test('SIGKILL during an insert recovers matching RAM and SSD rows', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-wal-sigkill-'));
  const paths = {
    ssd: path.join(root, 'ssd'),
    ram: path.join(root, 'ram'),
    wal: path.join(root, 'wal.jsonl'),
  };
  const child = fork(new URL('./wal-sigkill-child.mjs', import.meta.url), [paths.ssd, paths.ram, paths.wal], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('child never reached WAL-synced checkpoint')), 10_000);
    child.once('error', reject);
    child.on('message', (message) => {
      if (message.phase === 'wal-synced') child.send('continue');
      if (message.phase === 'ram-add-start') {
        clearTimeout(timeout);
        child.kill('SIGKILL');
        resolve();
      }
      if (message.phase === 'error') reject(new Error(message.message));
    });
  });
  await new Promise((resolve) => child.once('exit', resolve));

  const [insert] = fs.readFileSync(paths.wal, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const id = insert.id;
  const ramBeforeRecovery = await rowsForId(paths.ram, id);
  const ssdBeforeRecovery = await rowsForId(paths.ssd, id);
  console.log(`[wal-sigkill] before recovery: RAM=${ramBeforeRecovery.length}, SSD=${ssdBeforeRecovery.length}`);
  assert.ok(ramBeforeRecovery.length <= 1, 'LanceDB add must not leave duplicate/partial rows');
  assert.ok(ssdBeforeRecovery.length <= 1, 'LanceDB add must not leave duplicate/partial rows');

  const store = new MemoryStore(paths.ssd, paths.ram, 4, paths.wal);
  await store.ensureInitialized();
  const ramAfterRecovery = await rowsForId(paths.ram, id);
  const ssdAfterRecovery = await rowsForId(paths.ssd, id);
  assert.deepEqual(comparableRows(ramAfterRecovery), comparableRows(ssdAfterRecovery));
  assert.equal(ramAfterRecovery.length, 1);
  await store.shutdown();
});
