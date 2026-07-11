import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MemoryStore } from '@memory-river/core/store/store-v4';

import { installMockClock } from '../harness/clock.js';
import { safeRate } from '../harness/metrics.js';
import { createTempMemoryRiver } from '../harness/temp-store.js';
import type { BenchmarkResult } from '../report.js';

const HOUR = 60 * 60 * 1000;
const NOW = 1_710_000_000_000;

interface LifecycleRow {
  id: string;
  text: string;
  category: string;
  importance: number;
  metadata: string;
  createdAt: number;
}

function health(score: number, elapsedHours: number, accessCount = 0) {
  const at = NOW - elapsedHours * HOUR;
  return {
    healthScore: score,
    lastAccessedAt: at,
    lastDecayedAt: at,
    accessCount,
    decayCount: 0,
  };
}

function makeLifecycleStore(rows: LifecycleRow[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-bench-lifecycle-'));
  const store = new MemoryStore(
    path.join(root, 'ssd'),
    path.join(root, 'ram'),
    256,
    {
      initialScore: 100,
      coreCategories: ['identity', 'constraint', 'business', 'core_rule'],
      coreImportanceThreshold: 0.8,
      skillDecayFactor: 0.25,
    },
  );
  const table = {
    query() {
      return {
        limit() {
          return {
            async toArray() {
              return rows;
            },
          };
        },
      };
    },
    async optimize() {},
  };
  const mutableStore = store as any;
  mutableStore.ensureInitialized = async () => {};
  mutableStore.ramTable = table;
  mutableStore.ssdTable = { async optimize() {} };
  mutableStore.batchUpdateMemories = async (
    updates: Array<{ id: string; metadata: string }>,
  ) => {
    for (const update of updates) {
      const row = rows.find(candidate => candidate.id === update.id);
      if (row) row.metadata = update.metadata;
    }
  };
  return { root, store };
}

function scoreOf(row: LifecycleRow): number {
  return Number(JSON.parse(row.metadata).health.healthScore);
}

async function measureSupersession(): Promise<{ correct: number; firstId: string; secondId: string }> {
  const temp = await createTempMemoryRiver();
  try {
    const first = await temp.river.skills.save({
      name: 'benchmark-release-checklist',
      summary: 'Release checklist version one validates tests and artifacts.',
      triggers: ['prepare release'],
      steps: ['run tests', 'build artifacts'],
    });
    const second = await temp.river.skills.save({
      name: 'benchmark-release-checklist',
      summary: 'Release checklist version two validates tests, artifacts, and rollback.',
      triggers: ['prepare release'],
      steps: ['run tests', 'build artifacts', 'verify rollback'],
    });
    const loaded = await temp.river.skills.load('benchmark-release-checklist');
    const listed = (await temp.river.skills.list())
      .filter(skill => skill.name === 'benchmark-release-checklist');
    return {
      correct: Number(first.id !== second.id && loaded?.id === second.id && listed.length === 1),
      firstId: first.id,
      secondId: second.id,
    };
  } finally {
    await temp.cleanup();
  }
}

export async function runLifecycleBenchmark(): Promise<BenchmarkResult> {
  const rows: LifecycleRow[] = [
    {
      id: '10000000-0000-4000-8000-000000000001',
      text: 'should_retain identity',
      category: 'identity',
      importance: 0.2,
      metadata: JSON.stringify({ benchmarkTag: 'should_retain', health: health(1, 400) }),
      createdAt: NOW - 400 * HOUR,
    },
    {
      id: '10000000-0000-4000-8000-000000000002',
      text: 'should_retain important decision',
      category: 'other',
      importance: 0.95,
      metadata: JSON.stringify({ benchmarkTag: 'should_retain', health: health(1, 400) }),
      createdAt: NOW - 400 * HOUR,
    },
    {
      id: '20000000-0000-4000-8000-000000000001',
      text: 'should_forget stale note one',
      category: 'other',
      importance: 0.1,
      metadata: JSON.stringify({ benchmarkTag: 'should_forget', health: health(1, 400) }),
      createdAt: NOW - 400 * HOUR,
    },
    {
      id: '20000000-0000-4000-8000-000000000002',
      text: 'should_forget stale note two',
      category: 'other',
      importance: 0.1,
      metadata: JSON.stringify({ benchmarkTag: 'should_forget', health: health(2, 400) }),
      createdAt: NOW - 400 * HOUR,
    },
    {
      id: '30000000-0000-4000-8000-000000000001',
      text: 'normal survival control',
      category: 'other',
      importance: 0.1,
      metadata: JSON.stringify({ benchmarkTag: 'normal', health: health(100, 400) }),
      createdAt: NOW - 400 * HOUR,
    },
    {
      id: '40000000-0000-4000-8000-000000000001',
      text: 'skill_v2 survival control',
      category: 'skill',
      importance: 0.1,
      metadata: JSON.stringify({
        benchmarkTag: 'skill_v2',
        capsuleVersion: 2,
        status: 'active',
        health: health(100, 400),
      }),
      createdAt: NOW - 400 * HOUR,
    },
  ];
  const originalRows = [...rows];
  const { root, store } = makeLifecycleStore(rows);
  const clock = installMockClock(NOW);
  let cleanupRounds = 0;

  try {
    for (const advance of [0, 24 * HOUR]) {
      clock.advance(advance);
      await store.decayMemories(5, 0, {
        deleteWith: async id => {
          const index = rows.findIndex(row => row.id === id);
          if (index < 0) return false;
          rows.splice(index, 1);
          return true;
        },
      });
      cleanupRounds++;
    }
  } finally {
    clock.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }

  const retained = originalRows.filter(row => JSON.parse(row.metadata).benchmarkTag === 'should_retain');
  const forgotten = originalRows.filter(row => JSON.parse(row.metadata).benchmarkTag === 'should_forget');
  const retainedSurvivors = retained.filter(row => rows.some(candidate => candidate.id === row.id)).length;
  const forgottenRemoved = forgotten.filter(row => !rows.some(candidate => candidate.id === row.id)).length;
  const normal = rows.find(row => row.text === 'normal survival control');
  const skill = rows.find(row => row.text === 'skill_v2 survival control');
  const supersession = await measureSupersession();

  return {
    dimension: 'lifecycle',
    metrics: {
      retention_rate: safeRate(retainedSurvivors, retained.length),
      forget_rate: safeRate(forgottenRemoved, forgotten.length),
      supersession_correctness: supersession.correct,
      false_eviction_rate: safeRate(retained.length - retainedSurvivors, retained.length),
      skill_vs_normal_survival_ratio: normal && skill ? scoreOf(skill) / scoreOf(normal) : 0,
    },
    details: {
      cleanup_rounds: cleanupRounds,
      retained_total: retained.length,
      forgotten_total: forgotten.length,
      normal_health: normal ? scoreOf(normal) : null,
      skill_v2_health: skill ? scoreOf(skill) : null,
      superseded_skill_id: supersession.firstId,
      active_skill_id: supersession.secondId,
    },
  };
}
