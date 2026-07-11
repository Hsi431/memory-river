import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import { Field, Int64, Schema, Utf8 } from 'apache-arrow';
import { maintainAuxTables } from '../scripts/maintain-aux-tables.mjs';

import {
  AUX_TABLE_VERSION_RETENTION_MS,
  AUX_TABLE_WRITE_MAINTENANCE_INTERVAL,
  optimizeAuxTablesInConnection,
  recordAuxTableWrite,
} from '../dist/store/aux-table-maintenance.js';

function countManifests(storePath, tableName) {
  const versionsPath = path.join(storePath, `${tableName}.lance`, '_versions');
  return fs.readdirSync(versionsPath).filter((name) => name.endsWith('.manifest')).length;
}

function bestEffortRmSync(target, options) {
  try {
    fs.rmSync(target, options);
  } catch (error) {
    console.warn(`[test-teardown] best-effort rm failed for ${target}:`, error?.code ?? error);
  }
}

test('500 auxiliary writes compact manifests without deleting rows', async () => {
  const storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'aux-maintenance-writes-'));
  try {
    const db = await lancedb.connect(storePath);
    const table = await db.createEmptyTable('subsystem_effectiveness', new Schema([
      new Field('id', new Utf8(), false),
      new Field('value', new Int64(), false),
    ]));

    for (let write = 1; write < AUX_TABLE_WRITE_MAINTENANCE_INTERVAL; write++) {
      await table.add([
        { id: `${write}-a`, value: write },
        { id: `${write}-b`, value: write },
      ]);
      await recordAuxTableWrite(table, 'test:subsystem_effectiveness', 0);
    }

    const finalWrite = AUX_TABLE_WRITE_MAINTENANCE_INTERVAL;
    await table.add([
      { id: `${finalWrite}-a`, value: finalWrite },
      { id: `${finalWrite}-b`, value: finalWrite },
    ]);
    const rowsBefore = await table.countRows();
    const manifestsBefore = countManifests(storePath, 'subsystem_effectiveness');

    await recordAuxTableWrite(table, 'test:subsystem_effectiveness', 0);

    const rowsAfter = await table.countRows();
    const manifestsAfter = countManifests(storePath, 'subsystem_effectiveness');
    console.log(`aux manifest compression: ${manifestsBefore} -> ${manifestsAfter}; rows=${rowsAfter}`);

    assert.ok(rowsBefore > 500);
    assert.equal(rowsAfter, rowsBefore);
    assert.ok(manifestsBefore >= AUX_TABLE_WRITE_MAINTENANCE_INTERVAL);
    assert.ok(manifestsAfter < 50);
  } finally {
    bestEffortRmSync(storePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('write-triggered maintenance uses a one-hour retention window and is non-fatal', async () => {
  let optimizeCalls = 0;
  let cleanupOlderThan;
  const table = {
    optimize: async (options) => {
      optimizeCalls++;
      cleanupOlderThan = options.cleanupOlderThan;
      throw new Error('simulated optimize failure');
    },
  };

  const before = Date.now();
  for (let write = 0; write < AUX_TABLE_WRITE_MAINTENANCE_INTERVAL; write++) {
    await assert.doesNotReject(() => recordAuxTableWrite(table, 'test:failure'));
  }
  const after = Date.now();

  assert.equal(optimizeCalls, 1);
  assert.ok(cleanupOlderThan instanceof Date);
  assert.ok(cleanupOlderThan.getTime() >= before - AUX_TABLE_VERSION_RETENTION_MS);
  assert.ok(cleanupOlderThan.getTime() <= after - AUX_TABLE_VERSION_RETENTION_MS);
});

test('decay maintenance covers every auxiliary table present in the connection', async () => {
  const tableNames = [
    'memories',
    'subsystem_effectiveness',
    'graph_triples',
    'conflict_stats',
    'concentrator_stats',
    'status_audit_log',
    'night_consolidation_stats',
    'transcript_watermark',
    'wal_metadata',
    'hook_stats',
    'future_aux_table',
  ];
  const optimized = [];
  const db = {
    tableNames: async () => tableNames,
    openTable: async (name) => ({
      optimize: async () => {
        optimized.push(name);
      },
    }),
  };

  await optimizeAuxTablesInConnection(db, 'test');

  assert.deepEqual(optimized, tableNames.filter((name) => name !== 'memories'));
});

test('one-time auxiliary maintenance script is idempotent', async () => {
  const storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'aux-maintenance-script-'));
  try {
    const db = await lancedb.connect(storePath);
    await db.createTable('memories', [{ id: 'seed', value: 0 }]);
    const auxTable = await db.createTable('subsystem_effectiveness', [{ id: 'seed', value: 0 }]);
    await auxTable.add([{ id: 'next', value: 1 }]);

    const first = await maintainAuxTables(storePath);
    const second = await maintainAuxTables(storePath);

    assert.deepEqual(first, ['subsystem_effectiveness']);
    assert.deepEqual(second, ['subsystem_effectiveness']);
  } finally {
    bestEffortRmSync(storePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
