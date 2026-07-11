import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lancedb from '@lancedb/lancedb';

import { normalizeLanceUpdateValues } from '../dist/store/store-v4.js';

test('normalizeLanceUpdateValues lets LanceDB update string fields containing JSON braces and quotes', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-update-escape-'));
  const db = await lancedb.connect(tempDir);
  const table = await db.createTable('memories', [{
    id: 'row-1',
    metadata: '{}',
    status: 'active',
    text: 'before',
    updatedAt: 0,
  }]);

  const metadata = JSON.stringify({
    brace: '{json}',
    single: "can't",
    double: '"quoted"',
  });
  const text = `payload {' "}`;
  const updatedAt = Date.now();

  await table.update(
    normalizeLanceUpdateValues({
      metadata,
      status: 'deprecated',
      text,
      updatedAt,
    }),
    { where: "id = 'row-1'" }
  );

  const rows = await table.query().where("id = 'row-1'").limit(1).toArray();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].metadata, metadata);
  assert.equal(rows[0].status, 'deprecated');
  assert.equal(rows[0].text, text);
  assert.equal(Number(rows[0].updatedAt), updatedAt);

  try {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    console.warn(`[test-teardown] best-effort rm failed for ${tempDir}:`, error?.code ?? error);
  }
});
