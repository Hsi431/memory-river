import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as lancedb from '@lancedb/lancedb';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let rootPath;
let dbPath;
let outputPath;
let runCli;

before(async () => {
  ({ runCli } = await import(path.join(packageDir, 'dist/cli.js')));
  rootPath = await mkdtemp(path.join(tmpdir(), 'mr-dashboard-export-'));
  dbPath = path.join(rootPath, 'db');
  outputPath = path.join(rootPath, 'nested', 'memories.md');
  const db = await lancedb.connect(dbPath);

  await db.createTable('memories', [
    {
      id: 'active-b',
      text: 'Second active memory',
      category: 'preference',
      importance: 0.6,
      status: 'active',
      updatedAt: '2026-06-15T10:00:00.000Z',
      metadata: JSON.stringify({ health: { healthScore: 82 } }),
    },
    {
      id: 'trashed-newest',
      text: 'Trashed memory must not appear',
      category: 'fact',
      importance: 0.9,
      status: 'trashed',
      updatedAt: '2026-06-15T12:00:00.000Z',
      metadata: JSON.stringify({ health: { healthScore: 10 } }),
    },
    {
      id: 'active-a',
      text: 'First active memory',
      category: 'fact',
      importance: 0.8,
      status: 'active',
      updatedAt: '2026-06-15T10:00:00.000Z',
      metadata: JSON.stringify({ health: { healthScore: 95 } }),
    },
    {
      id: 'deprecated-memory',
      text: 'Deprecated memory must not appear',
      category: 'fact',
      importance: 0.4,
      status: 'deprecated',
      updatedAt: '2026-06-15T11:00:00.000Z',
      metadata: JSON.stringify({ health: { healthScore: 20 } }),
    },
  ]);
});

after(async () => {
  if (!rootPath) return;
  try {
    await rm(rootPath, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[test-teardown] best-effort rm failed for ${rootPath}:`, error?.code ?? error);
  }
});

test('export writes active memories with metadata in deterministic order', async () => {
  const stdout = [];
  const originalLog = console.log;
  console.log = (...values) => stdout.push(values.join(' '));
  try {
    const status = await runCli(['export', '--db', dbPath, '--out', outputPath]);
    assert.equal(status, 0);
  } finally {
    console.log = originalLog;
  }

  const markdown = await readFile(outputPath, 'utf8');
  assert.match(stdout.join('\n'), /Exported 2 memories to /);
  assert.match(markdown, /## active-a/);
  assert.match(markdown, /## active-b/);
  assert.doesNotMatch(markdown, /trashed-newest|Trashed memory must not appear/);
  assert.doesNotMatch(markdown, /deprecated-memory|Deprecated memory must not appear/);
  assert.match(markdown, /id: "active-a"/);
  assert.match(markdown, /category: "fact"/);
  assert.match(markdown, /status: "active"/);
  assert.match(markdown, /importance: 0.8/);
  assert.match(markdown, /healthScore: 95/);
  assert.match(markdown, /updatedAt: "2026-06-15T10:00:00.000Z"/);
  assert.ok(markdown.indexOf('## active-a') < markdown.indexOf('## active-b'));
});
