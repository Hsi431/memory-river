import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  assertInboxDrained,
  countInboxBacklog,
} from '../dist/harness/real-river.js';

function makeTestRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mr-bench-drain-'));
}

test('missing inbox is considered drained', () => {
  const root = makeTestRoot();
  try {
    const inboxDir = path.join(root, 'missing');
    assert.equal(countInboxBacklog(inboxDir), 0);
    assert.doesNotThrow(() => assertInboxDrained(inboxDir));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('empty inbox is considered drained', () => {
  const root = makeTestRoot();
  try {
    const inboxDir = path.join(root, 'inbox');
    fs.mkdirSync(inboxDir);
    assert.equal(countInboxBacklog(inboxDir), 0);
    assert.doesNotThrow(() => assertInboxDrained(inboxDir));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('error directory does not count as inbox backlog', () => {
  const root = makeTestRoot();
  try {
    const inboxDir = path.join(root, 'inbox');
    fs.mkdirSync(path.join(inboxDir, 'error'), { recursive: true });
    assert.equal(countInboxBacklog(inboxDir), 0);
    assert.doesNotThrow(() => assertInboxDrained(inboxDir));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pending files count and prevent inbox drain assertion', () => {
  const root = makeTestRoot();
  try {
    const inboxDir = path.join(root, 'inbox');
    fs.mkdirSync(inboxDir);
    fs.writeFileSync(path.join(inboxDir, 'pending_x.json'), '{}');
    fs.writeFileSync(path.join(inboxDir, 'y.json.processing'), '{}');
    assert.equal(countInboxBacklog(inboxDir), 2);
    assert.throws(
      () => assertInboxDrained(inboxDir),
      error => {
        assert.match(error.message, /BenchmarkIngestionError:/);
        assert.match(error.message, /pending=2/);
        assert.match(error.message, /pending_x\.json/);
        assert.match(error.message, /y\.json\.processing/);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
