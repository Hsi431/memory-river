import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lancedb from '@lancedb/lancedb';

import { MemoryStore } from '../dist/store/store-v4.js';

const VECTOR = [0, 0, 0, 0];
const LAST_CONCENTRATED_AT = 1_710_000_000_000;

function makeStore(t, root) {
  const store = new MemoryStore(path.join(root, 'ssd'), path.join(root, 'ram'), 4);
  t.after(async () => {
    await store.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return store;
}

async function firstWrite(store) {
  const entry = await store.store({
    text: 'session schema row',
    vector: VECTOR,
    importance: 0.5,
    category: 'other',
    parentId: null,
    metadata: JSON.stringify({ usageCount: 3, lastUsedAt: LAST_CONCENTRATED_AT }),
    sessionId: 'session-schema-id',
    lastConcentratedAt: LAST_CONCENTRATED_AT,
  });
  const schema = await store.ramTable.schema();
  const row = (await store.ramTable.query().where(`id = '${entry.id}'`).limit(1).toArray())[0];
  return { schema, row };
}

function assertSessionFields({ schema, row }) {
  const fields = schema.fields.map(field => field.name);
  assert.ok(fields.includes('sessionId'));
  assert.ok(fields.includes('lastConcentratedAt'));
  assert.equal(row.sessionId, 'session-schema-id');
  assert.equal(Number(row.lastConcentratedAt), LAST_CONCENTRATED_AT);
  const metadata = JSON.parse(row.metadata);
  assert.equal(metadata.usageCount, 3);
  assert.equal(metadata.lastUsedAt, LAST_CONCENTRATED_AT);
}

test('new memories table writes and reads session schema fields on its first row', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'F3-store-session-schema-'));
  const store = makeStore(t, root);

  assertSessionFields(await firstWrite(store));
});

test('existing memories table migration adds session schema fields before writes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'F3-store-session-migration-'));
  const ssdPath = path.join(root, 'ssd');
  fs.mkdirSync(ssdPath, { recursive: true });
  const db = await lancedb.connect(ssdPath);
  await db.createTable('memories', [{
    id: 'init_00000000000000000000000000000000',
    text: '_SYSTEM_INIT_',
    textTokens: '_SYSTEM_INIT_',
    vector: VECTOR,
    importance: 0,
    category: 'other',
    parentId: '',
    metadata: '{}',
    createdAt: 0,
    updatedAt: 0,
    slotKey: '',
    slotValue: '',
    confidence: 0,
    extractionDomain: '',
    supersedes: '[]',
    hasHooks: false,
  }]);
  const store = makeStore(t, root);

  assertSessionFields(await firstWrite(store));
});
