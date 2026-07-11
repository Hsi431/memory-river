import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../dist/store/store-v4.js';
import { ConflictDetector } from '../dist/cognition/conflict-detector.js';

function makeTempPaths(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'home');
  const ram = path.join(root, 'ram-db');
  const ssd = path.join(root, 'ssd-db');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ram, { recursive: true });
  fs.mkdirSync(ssd, { recursive: true });
  return { root, home, ram, ssd };
}

async function withTempStore(prefix, fn) {
  const paths = makeTempPaths(prefix);
  const oldHome = process.env.HOME;
  process.env.HOME = paths.home;

  const store = new MemoryStore(paths.ssd, paths.ram, 4, undefined, {
    embed: async () => [0, 0, 0, 0],
  });

  try {
    await store.ensureInitialized();
    await fn({ store });
  } finally {
    await store.shutdown?.().catch?.(() => {});
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    fs.rmSync(paths.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function makeCandidate(id, category = 'preference', metadata = '{}') {
  return {
    entry: {
      id,
      text: `old ${category} memory ${id}`,
      vector: [0, 0, 0, 0],
      importance: 0.8,
      category,
      parentId: null,
      metadata,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    vectorScore: 0.9,
    rankScore: 0.9,
    rawDistance: 0.1,
    bm25Score: 0,
    fusedScore: 0.9,
  };
}

function makeDetector(store, {
  candidates = [],
  llm,
  statusOk = true,
  calls,
} = {}) {
  const callLog = calls ?? { queried: 0, statuses: [] };
  store.hybridVectorSearch = async () => {
    callLog.queried++;
    return candidates;
  };
  const statusManager = {
    changeStatus: async (request) => {
      callLog.statuses.push(request);
      return {
        ok: statusOk,
        memoryId: request.memoryId,
        fromStatus: 'active',
        toStatus: request.toStatus,
        auditRowId: 'audit-1',
        ...(statusOk ? {} : { error: 'status failed' }),
      };
    },
  };
  return {
    detector: new ConflictDetector(
      store,
      { embed: async () => [0, 0, 0, 0] },
      llm,
      statusManager,
    ),
    calls: callLog,
  };
}

async function waitConflictEvents(store, expectedCount) {
  for (let i = 0; i < 20; i++) {
    const rows = await store.querySubsystemEffectiveness({ subsystem: 'conflict', limit: 50 });
    if (rows.length >= expectedCount) return rows;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return await store.querySubsystemEffectiveness({ subsystem: 'conflict', limit: 50 });
}

function byEvent(rows, event) {
  return rows.filter(row => row.event === event);
}

test('non-conflict category records category_skipped and does not query candidates', async () => {
  await withTempStore('conflict-eff-skip-', async ({ store }) => {
    const { detector, calls } = makeDetector(store);

    const result = await detector.detectAndResolve('new-1', 'new text', 'fact');
    const rows = await waitConflictEvents(store, 1);

    assert.deepEqual(result, { hasConflict: false, conflictingIds: [], resolution: 'skip' });
    assert.equal(calls.queried, 0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event, 'conflict_detect_attempted');
    assert.equal(rows[0].outcome, 'category_skipped');
    assert.deepEqual(JSON.parse(rows[0].metadata), { category: 'fact' });
  });
});

test('conflict category with no candidates records entered and no_candidates', async () => {
  await withTempStore('conflict-eff-no-candidates-', async ({ store }) => {
    const { detector } = makeDetector(store, { candidates: [] });

    const result = await detector.detectAndResolve('new-1', 'new preference', 'preference');
    const rows = await waitConflictEvents(store, 2);

    assert.deepEqual(result, { hasConflict: false, conflictingIds: [], resolution: 'no_candidates' });
    assert.equal(byEvent(rows, 'conflict_detect_attempted')[0].outcome, 'entered');
    assert.equal(byEvent(rows, 'conflict_candidates_found')[0].outcome, 'no_candidates');
    assert.equal(byEvent(rows, 'conflict_candidates_found')[0].count, 0);
  });
});

test('candidate judged as no conflict records no_conflict', async () => {
  await withTempStore('conflict-eff-no-conflict-', async ({ store }) => {
    const oldId = 'old-pref-1';
    const { detector, calls } = makeDetector(store, {
      candidates: [makeCandidate(oldId)],
      llm: { generate: async () => '共存' },
    });

    const result = await detector.detectAndResolve('new-1', 'new preference', 'preference');
    const rows = await waitConflictEvents(store, 3);
    const judged = byEvent(rows, 'conflict_llm_judged')[0];

    assert.deepEqual(result, { hasConflict: false, conflictingIds: [], resolution: 'no_conflict' });
    assert.equal(calls.statuses.length, 0);
    assert.equal(byEvent(rows, 'conflict_candidates_found')[0].outcome, 'has_candidates');
    assert.equal(judged.outcome, 'no_conflict');
    assert.equal(judged.count, 0);
    assert.equal(JSON.parse(judged.metadata).candidateCount, 1);
  });
});

test('conflict found records all four funnel events and resolution outcome', async () => {
  await withTempStore('conflict-eff-found-', async ({ store }) => {
    const oldId = 'old-pref-1';
    const { detector, calls } = makeDetector(store, {
      candidates: [makeCandidate(oldId)],
      llm: { generate: async () => '衝突' },
      statusOk: true,
    });

    const result = await detector.detectAndResolve('new-1', 'new preference', 'preference');
    const rows = await waitConflictEvents(store, 4);

    assert.deepEqual(result, {
      hasConflict: true,
      conflictingIds: [oldId],
      resolution: 'deprecated 1 conflicting memories',
    });
    assert.equal(calls.statuses.length, 1);
    assert.equal(byEvent(rows, 'conflict_detect_attempted')[0].outcome, 'entered');
    assert.equal(byEvent(rows, 'conflict_candidates_found')[0].outcome, 'has_candidates');
    assert.equal(byEvent(rows, 'conflict_llm_judged')[0].outcome, 'conflict_found');
    assert.equal(byEvent(rows, 'conflict_llm_judged')[0].count, 1);
    const resolved = byEvent(rows, 'conflict_resolution_fired')[0];
    assert.equal(resolved.entityId, oldId);
    assert.equal(resolved.relatedId, 'new-1');
    assert.equal(resolved.outcome, 'ok');
    assert.deepEqual(JSON.parse(resolved.metadata), { category: 'preference', reason: 'conflict_detected' });
  });
});

test('LLM failure records llm_failed and preserves conservative no-conflict behavior', async () => {
  await withTempStore('conflict-eff-llm-failed-', async ({ store }) => {
    const { detector, calls } = makeDetector(store, {
      candidates: [makeCandidate('old-pref-1')],
      llm: { generate: async () => { throw new Error('llm down'); } },
    });

    const result = await detector.detectAndResolve('new-1', 'new preference', 'preference');
    const rows = await waitConflictEvents(store, 3);
    const judged = byEvent(rows, 'conflict_llm_judged')[0];

    assert.deepEqual(result, { hasConflict: false, conflictingIds: [], resolution: 'no_conflict' });
    assert.equal(calls.statuses.length, 0);
    assert.equal(judged.outcome, 'llm_failed');
    assert.equal(judged.count, 0);
    assert.equal(JSON.parse(judged.metadata).errorMessage, 'llm down');
  });
});

test('events in one detect attempt share queryHash', async () => {
  await withTempStore('conflict-eff-queryhash-', async ({ store }) => {
    const { detector } = makeDetector(store, {
      candidates: [makeCandidate('old-pref-1')],
      llm: { generate: async () => '衝突' },
    });

    await detector.detectAndResolve('new-1', 'new preference', 'preference');
    const rows = await waitConflictEvents(store, 4);
    const hashes = new Set(rows.map(row => row.queryHash));

    assert.equal(rows.length, 4);
    assert.equal(hashes.size, 1);
    assert.ok([...hashes][0]);
  });
});

test('business results stay unchanged for detector outcomes', async () => {
  await withTempStore('conflict-eff-business-', async ({ store }) => {
    const skipped = makeDetector(store);
    assert.deepEqual(
      await skipped.detector.detectAndResolve('new-skip', 'new text', 'fact'),
      { hasConflict: false, conflictingIds: [], resolution: 'skip' },
    );

    const noCandidates = makeDetector(store, { candidates: [] });
    assert.deepEqual(
      await noCandidates.detector.detectAndResolve('new-none', 'new preference', 'preference'),
      { hasConflict: false, conflictingIds: [], resolution: 'no_candidates' },
    );

    const noConflict = makeDetector(store, {
      candidates: [makeCandidate('old-pref-1')],
      llm: { generate: async () => '共存' },
    });
    assert.deepEqual(
      await noConflict.detector.detectAndResolve('new-no-conflict', 'new preference', 'preference'),
      { hasConflict: false, conflictingIds: [], resolution: 'no_conflict' },
    );

    const conflict = makeDetector(store, {
      candidates: [makeCandidate('old-pref-2')],
      llm: { generate: async () => '衝突' },
    });
    assert.deepEqual(
      await conflict.detector.detectAndResolve('new-conflict', 'new preference', 'preference'),
      {
        hasConflict: true,
        conflictingIds: ['old-pref-2'],
        resolution: 'deprecated 1 conflicting memories',
      },
    );
  });
});
