import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryRiver } from '../dist/api.js';
import { MemoryRiverEngine } from '../dist/engine.js';
import { StatusManager } from '../dist/store/status-manager.js';
import { MemoryStore } from '../dist/store/store-v4.js';

function bestEffortRmSync(target, options) {
  try {
    fs.rmSync(target, options);
  } catch (error) {
    console.warn(`[test-teardown] best-effort rm failed for ${target}:`, error?.code ?? error);
  }
}
import { SkillValidationError, validateSkillDef } from '../dist/skills/validate.js';

const VALID_SKILL = {
  name: 'git-release',
  summary: 'Create and publish a release.',
  triggers: ['publish release', 'create tag'],
  steps: ['Run the release checks.', 'Create and push the tag.'],
};

function violationFor(def, expected) {
  assert.throws(
    () => validateSkillDef(def),
    error => error instanceof SkillValidationError && error.message.includes(expected),
  );
}

test('quality gate accepts a valid skill and enforces every rule', () => {
  assert.doesNotThrow(() => validateSkillDef(VALID_SKILL));
  assert.doesNotThrow(() => validateSkillDef({ ...VALID_SKILL, name: '發版_流程-2' }));

  violationFor({ ...VALID_SKILL, name: 'my skill!' }, 'skillName: 不符');
  violationFor({ ...VALID_SKILL, summary: '' }, 'summary: 需 1–200 chars');
  violationFor({ ...VALID_SKILL, summary: 'x'.repeat(201) }, 'summary: 需 1–200 chars');
  violationFor({ ...VALID_SKILL, triggers: [] }, 'triggerConditions: 需 1–5 條');
  violationFor({ ...VALID_SKILL, triggers: Array(6).fill('x') }, 'triggerConditions: 需 1–5 條');
  violationFor({ ...VALID_SKILL, triggers: ['x'.repeat(101)] }, 'triggerConditions[0]: 超過 100 chars');
  violationFor({ ...VALID_SKILL, triggers: ['same', 'same'] }, 'triggerConditions[1]: 不得重複');
  violationFor({ ...VALID_SKILL, steps: ['only one'] }, 'executionSteps: 需 2–15 步');
  violationFor({ ...VALID_SKILL, steps: Array(16).fill('x') }, 'executionSteps: 需 2–15 步');
  violationFor({ ...VALID_SKILL, steps: ['ok', 'x'.repeat(301)] }, 'executionSteps[1]: 超過 300 chars');
});

test('quality gate reports all violations in one error', () => {
  assert.throws(
    () => validateSkillDef({
      name: 'bad name',
      summary: '',
      triggers: [],
      steps: ['x'.repeat(301)],
    }),
    error => {
      assert.ok(error instanceof SkillValidationError);
      assert.equal(error.violations.length, 5);
      assert.match(error.message, /^skill_save rejected \(5 violations\):/);
      assert.match(error.message, /1\. skillName:/);
      assert.match(error.message, /5\. executionSteps\[0\]:/);
      return true;
    },
  );
});

test('createMemoryRiver exposes the skills namespace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-skills-api-'));
  const river = createMemoryRiver({
    dataDir: path.join(root, 'data'),
    ramDir: path.join(root, 'ram'),
  }, {
    embedder: {
      embed: async () => [0, 0, 0, 0],
      embedBatch: async texts => texts.map(() => [0, 0, 0, 0]),
      getDimensions: () => 4,
      healthCheck: async () => true,
    },
    llm: { generate: async () => '' },
  });

  try {
    for (const method of ['save', 'search', 'load', 'list']) {
      assert.equal(typeof river.skills[method], 'function');
    }
  } finally {
    bestEffortRmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

class FakeSkillStore {
  constructor() {
    this.entries = [];
    this.searchFilters = null;
  }

  async queryAllWithMeta() {
    return this.entries.map(entry => ({
      ...entry,
      metadataObj: JSON.parse(entry.metadata),
    }));
  }

  async store(entry) {
    const now = Date.now();
    const stored = {
      ...entry,
      id: `${String(this.entries.length + 1).padStart(8, '0')}-0000-4000-8000-000000000000`,
      createdAt: now,
      updatedAt: now,
    };
    this.entries.push(stored);
    return stored;
  }

  async getById(id, includeAllStatus = false) {
    const entry = this.entries.find(candidate => candidate.id === id);
    if (!entry) return null;
    const metadata = JSON.parse(entry.metadata);
    return includeAllStatus || metadata.status === 'active' ? { ...entry } : null;
  }

  async update(id, updates) {
    const entry = this.entries.find(candidate => candidate.id === id);
    if (!entry) return false;
    Object.assign(entry, updates, { updatedAt: Date.now() });
    return true;
  }

  async recordStatusAudit() {}

  async boostHealth(id) {
    const entry = await this.getById(id);
    if (!entry) return false;
    const metadata = JSON.parse(entry.metadata);
    const health = metadata.health ?? { healthScore: 50, accessCount: 0, decayCount: 0 };
    health.accessCount += 1;
    health.healthScore = Math.min(100, health.healthScore + 20 + health.accessCount * 5);
    health.lastAccessedAt = Date.now();
    metadata.health = health;
    await this.update(id, { metadata: JSON.stringify(metadata) });
    return true;
  }

  async hybridSkillCapsuleSearch(_query, limit, filters) {
    this.searchFilters = filters;
    return this.entries
      .map(entry => ({ entry, metadata: JSON.parse(entry.metadata) }))
      .filter(({ metadata }) => metadata.skillName)
      .filter(({ metadata }) => filters.capsuleVersion === undefined || metadata.capsuleVersion === filters.capsuleVersion)
      .filter(({ metadata }) => filters.status === undefined || metadata.status === filters.status)
      .slice(0, limit)
      .map(({ entry, metadata }) => ({
        id: entry.id,
        skillName: metadata.skillName,
        triggerConditions: metadata.triggerConditions,
        executionSteps: metadata.executionSteps,
        summary: entry.text,
        status: metadata.status,
      }));
  }
}

function makeEngine() {
  const store = new FakeSkillStore();
  const engine = new MemoryRiverEngine({}, {
    paths: {},
    transcriptArchive: {},
    deriveSessionFile: () => null,
    ollamaUrl: '',
    geminiApiKey: '',
    deepseekApiKey: '',
  });
  engine.pluginInitPromise = Promise.resolve();
  engine.memoryStoreRef = store;
  engine.embedderRef = { embed: async () => [0, 0, 0, 0] };
  engine.statusManagerRef = new StatusManager(store);
  return { engine, store };
}

test('save supersedes the old active version and resets usage', async () => {
  const { engine, store } = makeEngine();
  const first = await engine.saveSkill(VALID_SKILL);
  const firstEntry = store.entries.find(entry => entry.id === first.id);
  const firstMeta = JSON.parse(firstEntry.metadata);
  firstMeta.usageCount = 9;
  firstEntry.metadata = JSON.stringify(firstMeta);

  const second = await engine.saveSkill({ ...VALID_SKILL, summary: 'Updated release process.' });
  const oldMeta = JSON.parse(firstEntry.metadata);
  const newMeta = JSON.parse(store.entries.find(entry => entry.id === second.id).metadata);

  assert.equal(oldMeta.status, 'superseded');
  assert.equal(oldMeta.supersededBy, second.id);
  assert.equal(newMeta.status, 'active');
  assert.equal(newMeta.usageCount, 0);
  assert.equal(newMeta.lastUsedAt, null);
  assert.equal(newMeta.capsuleVersion, 2);
  assert.equal(Object.hasOwn(newMeta, 'capsuleType'), false);
});

test('concurrent same-name saves leave exactly one active capsule', async () => {
  const { engine, store } = makeEngine();

  await Promise.all([
    engine.saveSkill(VALID_SKILL),
    engine.saveSkill({ ...VALID_SKILL, summary: 'Updated release process.' }),
  ]);

  const active = store.entries.filter(entry => JSON.parse(entry.metadata).status === 'active');
  assert.equal(active.length, 1);
  assert.equal(JSON.parse(active[0].metadata).skillName, VALID_SKILL.name);
});

test('load increments usage, records last use, boosts health, and returns null when absent', async () => {
  const { engine, store } = makeEngine();
  const { id } = await engine.saveSkill(VALID_SKILL);
  const entry = store.entries.find(candidate => candidate.id === id);
  const metadata = JSON.parse(entry.metadata);
  metadata.health = { healthScore: 50, accessCount: 0, decayCount: 0 };
  entry.metadata = JSON.stringify(metadata);

  const loaded = await engine.loadSkill(VALID_SKILL.name);
  const updatedMeta = JSON.parse(entry.metadata);

  assert.equal(loaded.name, VALID_SKILL.name);
  assert.deepEqual(loaded.executionSteps, VALID_SKILL.steps);
  assert.equal(loaded.usageCount, 1);
  assert.equal(updatedMeta.usageCount, 1);
  assert.equal(typeof updatedMeta.lastUsedAt, 'number');
  assert.equal(updatedMeta.health.accessCount, 1);
  assert.equal(updatedMeta.health.healthScore, 75);
  assert.equal(await engine.loadSkill('missing-skill'), null);
});

test('concurrent same-name loads preserve every usage increment', async () => {
  const { engine, store } = makeEngine();
  const { id } = await engine.saveSkill(VALID_SKILL);
  const loadCount = 8;

  await Promise.all(Array.from({ length: loadCount }, () => engine.loadSkill(VALID_SKILL.name)));

  const entry = store.entries.find(candidate => candidate.id === id);
  assert.equal(JSON.parse(entry.metadata).usageCount, loadCount);
});

test('load and list select only the newest same-name active v2 skill', async () => {
  const { engine, store } = makeEngine();
  const baseMetadata = {
    capsuleVersion: 2,
    skillName: VALID_SKILL.name,
    triggerConditions: VALID_SKILL.triggers,
    executionSteps: VALID_SKILL.steps,
    usageCount: 0,
    lastUsedAt: null,
    status: 'active',
  };
  store.entries.push(
    {
      id: '60000000-0000-4000-8000-000000000000',
      text: 'Older release process.',
      metadata: JSON.stringify(baseMetadata),
      category: 'skill',
      importance: 0.7,
      createdAt: 100,
      updatedAt: 100,
    },
    {
      id: '70000000-0000-4000-8000-000000000000',
      text: 'Newest release process.',
      metadata: JSON.stringify(baseMetadata),
      category: 'skill',
      importance: 0.7,
      createdAt: 200,
      updatedAt: 200,
    },
  );
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    const loaded = await engine.loadSkill(VALID_SKILL.name);
    const listed = await engine.listSkills();

    assert.equal(loaded.id, '70000000-0000-4000-8000-000000000000');
    assert.deepEqual(listed, [{
      name: VALID_SKILL.name,
      triggerConditions: VALID_SKILL.triggers,
      summary: 'Newest release process.',
    }]);
    assert.equal(warnings.some(message => message.includes('60000000-0000-4000-8000-000000000000')
      && message.includes('70000000-0000-4000-8000-000000000000')), true);
  } finally {
    console.warn = originalWarn;
  }
});

test('save rolls back the new skill when superseding an old version fails', async () => {
  const { engine, store } = makeEngine();
  const old = await store.store({
    text: 'Older release process.',
    vector: [0, 0, 0, 0],
    category: 'skill',
    importance: 0.7,
    parentId: null,
    metadata: JSON.stringify({
      capsuleVersion: 2,
      skillName: VALID_SKILL.name,
      triggerConditions: VALID_SKILL.triggers,
      executionSteps: VALID_SKILL.steps,
      status: 'active',
    }),
  });
  const calls = [];
  engine.statusManagerRef = {
    async changeStatus(request) {
      calls.push(request);
      if (request.memoryId === old.id) {
        return { ok: false, error: 'injected supersede failure' };
      }
      const created = store.entries.find(entry => entry.id === request.memoryId);
      const metadata = JSON.parse(created.metadata);
      metadata.status = request.toStatus;
      created.metadata = JSON.stringify(metadata);
      return { ok: true };
    },
  };

  await assert.rejects(
    engine.saveSkill({ ...VALID_SKILL, summary: 'Newest release process.' }),
    /failed to supersede skill/,
  );

  const active = store.entries.filter(entry => JSON.parse(entry.metadata).status === 'active');
  assert.deepEqual(active.map(entry => entry.id), [old.id]);
  assert.equal(calls.at(-1).toStatus, 'trashed');
  assert.equal(calls.at(-1).reason, 'saveSkill_supersede_rollback');
});

test('search returns index-only active v2 results and excludes v1 data', async () => {
  const { engine, store } = makeEngine();
  store.entries.push({
    id: '10000000-0000-4000-8000-000000000000',
    text: 'Legacy result',
    metadata: JSON.stringify({
      skillName: 'legacy',
      triggerConditions: ['release'],
      executionSteps: ['legacy step'],
      status: 'active',
    }),
    category: 'skill',
    importance: 0.7,
    createdAt: 1,
    updatedAt: 1,
  });
  await engine.saveSkill(VALID_SKILL);

  const results = await engine.searchSkills('release');

  assert.deepEqual(store.searchFilters, { capsuleVersion: 2, status: 'active' });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, VALID_SKILL.name);
  assert.equal(Object.hasOwn(results[0], 'executionSteps'), false);
  assert.equal(Object.hasOwn(results[0], 'steps'), false);
  assert.deepEqual(await engine.listSkills(), results);
});

test('hybrid skill search filters v1 before applying the result limit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-skill-search-'));
  const store = new MemoryStore(path.join(root, 'ssd'), path.join(root, 'ram'), 4);
  store.hybridVectorSearch = async () => [
    {
      entry: {
        id: '40000000-0000-4000-8000-000000000000',
        text: 'Legacy skill',
        metadata: JSON.stringify({ skillName: 'legacy', status: 'active' }),
        importance: 0.7,
        category: 'skill',
        createdAt: 1,
        updatedAt: 1,
      },
    },
    {
      entry: {
        id: '50000000-0000-4000-8000-000000000000',
        text: VALID_SKILL.summary,
        metadata: JSON.stringify({
          capsuleVersion: 2,
          skillName: VALID_SKILL.name,
          triggerConditions: VALID_SKILL.triggers,
          executionSteps: VALID_SKILL.steps,
          status: 'active',
        }),
        importance: 0.7,
        category: 'skill',
        createdAt: 2,
        updatedAt: 2,
      },
    },
  ];

  try {
    const results = await store.hybridSkillCapsuleSearch(
      'release',
      1,
      { capsuleVersion: 2, status: 'active' },
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].skillName, VALID_SKILL.name);
  } finally {
    bestEffortRmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function makeDecayStore(rows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-skill-decay-'));
  const store = new MemoryStore(
    path.join(root, 'ssd'),
    path.join(root, 'ram'),
    4,
    {
      initialScore: 100,
      coreCategories: [],
      coreImportanceThreshold: 0.8,
      skillDecayFactor: 0.25,
    },
  );
  store.ramTable = {
    query() {
      return {
        limit() {
          return { async toArray() { return rows; } };
        },
      };
    },
  };
  return { root, store };
}

test('decay applies the slow curve only to active v2 skills', async () => {
  const twentyHoursAgo = Date.now() - 20 * 60 * 60 * 1000;
  const health = {
    healthScore: 2,
    lastAccessedAt: twentyHoursAgo,
    lastDecayedAt: twentyHoursAgo,
    accessCount: 0,
    decayCount: 0,
  };
  const rows = [
    {
      id: '20000000-0000-4000-8000-000000000000',
      text: 'active v2',
      category: 'skill',
      importance: 0.7,
      metadata: JSON.stringify({ capsuleVersion: 2, status: 'active', health }),
      createdAt: twentyHoursAgo,
    },
    {
      id: '30000000-0000-4000-8000-000000000000',
      text: 'superseded v2',
      category: 'skill',
      importance: 0.7,
      metadata: JSON.stringify({ capsuleVersion: 2, status: 'superseded', health }),
      createdAt: twentyHoursAgo,
    },
  ];
  const { root, store } = makeDecayStore(rows);

  try {
    const result = await store.decayMemories(5, 0, { dryRun: true });
    assert.equal(result.wouldDecay, 1);
    assert.equal(result.wouldDelete, 1);
    assert.equal(result.deleteCandidateSummary.firstId, rows[1].id);
  } finally {
    bestEffortRmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('decay is time-driven and active v2 skills lose about one quarter HP', async () => {
  const now = 1710000000000;
  const elapsedAt = now - 80 * 60 * 60 * 1000;
  const rows = [
    {
      id: '40000000-0000-4000-8000-000000000000',
      text: 'normal memory',
      category: 'other',
      importance: 0.1,
      metadata: JSON.stringify({
        health: {
          healthScore: 100,
          lastAccessedAt: elapsedAt,
          lastDecayedAt: elapsedAt,
          accessCount: 0,
          decayCount: 0,
        },
      }),
      createdAt: elapsedAt,
    },
    {
      id: '50000000-0000-4000-8000-000000000000',
      text: 'active v2 skill',
      category: 'skill',
      importance: 0.1,
      metadata: JSON.stringify({
        capsuleVersion: 2,
        status: 'active',
        health: {
          healthScore: 100,
          lastAccessedAt: elapsedAt,
          lastDecayedAt: elapsedAt,
          accessCount: 0,
          decayCount: 0,
        },
      }),
      createdAt: elapsedAt,
    },
  ];
  const { root, store } = makeDecayStore(rows);
  const originalNow = Date.now;
  store.batchUpdateMemories = async updates => {
    for (const update of updates) {
      rows.find(row => row.id === update.id).metadata = update.metadata;
    }
  };
  store.ramTable.optimize = async () => {};
  store.ssdTable = { optimize: async () => {} };

  try {
    Date.now = () => now;
    await store.decayMemories();
    const firstScores = rows.map(row => JSON.parse(row.metadata).health.healthScore);

    await store.decayMemories();
    const secondScores = rows.map(row => JSON.parse(row.metadata).health.healthScore);

    assert.deepEqual(firstScores, [88, 97]);
    assert.deepEqual(secondScores, firstScores);
    assert.equal(100 - firstScores[1], (100 - firstScores[0]) / 4);
  } finally {
    Date.now = originalNow;
    bestEffortRmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('onSessionEnd does not throw when cleanup engine is not registered', () => {
  const { engine } = makeEngine();
  engine.cleanupEngineRef = null;

  assert.doesNotThrow(() => engine.onSessionEnd({ sessionId: 'session-1' }));
});
