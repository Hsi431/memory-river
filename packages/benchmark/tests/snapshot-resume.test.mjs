import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  checkpointPathFor,
  planConversationIngestion,
} from '../dist/dimensions/conversation-runner.js';

function makeSnapshotDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mr-bench-resume-'));
}

function withSnapshotDir(fn) {
  const dir = makeSnapshotDir();
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('no snapshot dir ingests from scratch', () => {
  assert.deepEqual(planConversationIngestion(undefined, false), { mode: 'fresh' });
});

test('empty snapshot dir ingests from scratch', () => {
  withSnapshotDir(dir => {
    assert.deepEqual(planConversationIngestion(dir, false), { mode: 'fresh' });
  });
});

test('a complete manifest restores without re-ingesting', () => {
  withSnapshotDir(dir => {
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ memoryCount: 316, compactedSessions: 31 }),
    );
    assert.deepEqual(planConversationIngestion(dir, false), {
      mode: 'restore',
      memoryCount: 316,
      compactedSessions: 31,
    });
  });
});

test('a mid-conversation checkpoint resumes at the next session', () => {
  withSnapshotDir(dir => {
    fs.writeFileSync(
      checkpointPathFor(dir),
      JSON.stringify({ memoryCount: 139, compactedSessions: 10, ingestedSessions: 10 }),
    );
    assert.deepEqual(planConversationIngestion(dir, false), {
      mode: 'resume',
      startSession: 10,
      memoryCount: 139,
      compactedSessions: 10,
    });
  });
});

test('compactedSessions is not used as the resume index', () => {
  // A session can be ingested without compacting, so the two counters diverge;
  // resuming on the compacted count would silently re-ingest paid sessions.
  withSnapshotDir(dir => {
    fs.writeFileSync(
      checkpointPathFor(dir),
      JSON.stringify({ memoryCount: 90, compactedSessions: 6, ingestedSessions: 9 }),
    );
    const plan = planConversationIngestion(dir, false);
    assert.equal(plan.mode, 'resume');
    assert.equal(plan.startSession, 9);
  });
});

test('a manifest wins over a stale checkpoint left beside it', () => {
  withSnapshotDir(dir => {
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ memoryCount: 316, compactedSessions: 31 }),
    );
    fs.writeFileSync(
      checkpointPathFor(dir),
      JSON.stringify({ memoryCount: 139, compactedSessions: 10, ingestedSessions: 10 }),
    );
    assert.equal(planConversationIngestion(dir, false).mode, 'restore');
  });
});

test('--rebuild-snapshot ignores both manifest and checkpoint', () => {
  withSnapshotDir(dir => {
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ memoryCount: 316, compactedSessions: 31 }),
    );
    fs.writeFileSync(
      checkpointPathFor(dir),
      JSON.stringify({ memoryCount: 139, compactedSessions: 10, ingestedSessions: 10 }),
    );
    assert.deepEqual(planConversationIngestion(dir, true), { mode: 'fresh' });
  });
});

test('a checkpoint truncated by a crash restarts instead of throwing', () => {
  withSnapshotDir(dir => {
    fs.writeFileSync(checkpointPathFor(dir), '{"memoryCount":139,"compacted');
    assert.deepEqual(planConversationIngestion(dir, false), { mode: 'fresh' });
  });
});

test('a zero-session checkpoint is not treated as progress', () => {
  withSnapshotDir(dir => {
    fs.writeFileSync(
      checkpointPathFor(dir),
      JSON.stringify({ memoryCount: 0, compactedSessions: 0, ingestedSessions: 0 }),
    );
    assert.deepEqual(planConversationIngestion(dir, false), { mode: 'fresh' });
  });
});
