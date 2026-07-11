import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { InboxWatcher } from '../dist/pipeline/inbox-watcher.js';

class CapturingStore {
  constructor(events = []) {
    this.events = events;
    this.memories = [];
    this.oldMemory = {
      id: 'parent-1',
      text: 'old memory',
      metadata: '{}',
    };
  }

  async hybridVectorSearch() {
    return [];
  }

  async getById(id) {
    return id === this.oldMemory.id ? this.oldMemory : null;
  }

  async store(entry) {
    this.events.push('store');
    const stored = {
      id: `memory-${this.memories.length + 1}`,
      ...entry,
    };
    this.memories.push(stored);
    return stored;
  }
}

function makeWatcher(store, events = [], relation = { action: 'CREATE', parentId: undefined }) {
  const embedder = { embed: async () => [0.1, 0.2, 0.3, 0.4] };
  const causalEngine = { determineRelation: async () => relation };
  const statusManager = { changeStatus: async () => {} };
  const watcher = new InboxWatcher(
    store,
    embedder,
    causalEngine,
    null,
    null,
    { generate: async () => '' },
    '/unused-inbox',
    2000,
    undefined,
    statusManager,
    async () => {},
  );
  return watcher;
}

async function processItem(item, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-name-order-'));
  const procPath = path.join(root, 'pending_test.json');
  const events = [];
  const store = new CapturingStore(events);
  const watcher = makeWatcher(
    store,
    events,
    options.relation ?? { action: 'CREATE', parentId: undefined },
  );

  try {
    fs.writeFileSync(procPath, JSON.stringify(item), 'utf-8');
    await watcher._processMemoryEntry(procPath);
    assert.equal(store.memories.length, 1);
    return {
      events,
      stored: store.memories[0],
      metadata: JSON.parse(store.memories[0].metadata),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('capsule skillName is persisted in memories metadata before UPDATE store', async () => {
  const { metadata } = await processItem(
    {
      text: '[CAPSULE_META] {"skillName":"HybridSearchSkill","triggerConditions":["metadata.skillName"],"executionSteps":["search path A"],"confidence":0.9}\nUse metadata skillName for hybrid skill capsule search.',
      category: 'skill',
      importance: 0.5,
      capsuleType: 'skill_capsule',
    },
    { relation: { action: 'UPDATE', parentId: 'parent-1' } },
  );

  assert.equal(metadata.skillName, 'HybridSearchSkill');
  assert.equal(metadata.capsuleType, 'skill_capsule');
  assert.deepEqual(metadata.triggerConditions, ['metadata.skillName']);
  assert.deepEqual(metadata.executionSteps, ['search path A']);
});

test('normal memories without a skillName do not gain metadata skillName', async () => {
  const { metadata } = await processItem({
    text: 'A normal memory with no capsule metadata.',
    category: 'fact',
    importance: 0.5,
  });

  assert.equal(metadata.skillName, undefined);
  assert.equal(Object.hasOwn(metadata, 'skillName'), false);
});

test('existing inbox metadata skillName is preserved', async () => {
  const { events, metadata } = await processItem({
    text: 'River capsule text already normalized into inbox metadata.',
    category: 'fact',
    importance: 0.8,
    metadata: {
      skillName: 'RiverMetadataSkill',
      source: 'river_capsule',
    },
  });

  assert.equal(metadata.skillName, 'RiverMetadataSkill');
  assert.equal(metadata.source, 'river_capsule');
  assert.deepEqual(events, ['store']);
});
