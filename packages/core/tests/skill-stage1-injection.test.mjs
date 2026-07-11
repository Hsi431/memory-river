import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryRiverEngine } from '../dist/engine.js';

function makeEngine(skillResults) {
  let updateCalls = 0;
  const store = {
    async hybridSkillCapsuleSearch(_query, limit, filters) {
      assert.equal(limit, 2);
      assert.deepEqual(filters, { capsuleVersion: 2, status: 'active' });
      return skillResults;
    },
    async update() {
      updateCalls += 1;
      throw new Error('stage-1 injection must not update skill metadata');
    },
  };
  const retriever = {
    getStore: () => store,
    async hybridSearch() {
      return { results: [], hookOriginIds: [], hookOriginKeywords: {}, queryHash: 'q' };
    },
    async hybridSearchWithoutBoost() {
      throw new Error('unexpected fallback');
    },
  };
  const engine = new MemoryRiverEngine({}, {
    paths: {},
    transcriptArchive: {},
    deriveSessionFile: () => null,
    ollamaUrl: '',
    geminiApiKey: '',
    deepseekApiKey: '',
  });
  engine.pluginInitPromise = Promise.resolve();
  engine.isAutoRecallEnabled = true;
  engine.retrieverRef = retriever;
  engine.memoryStoreRef = store;

  return {
    engine,
    getUpdateCalls: () => updateCalls,
  };
}

function user(content) {
  return { role: 'user', content };
}

test('autoRecall injects stage-1 skill indexes without execution steps or usage writes', async () => {
  const skill = {
    id: 'skill-1',
    skillName: 'git-release',
    triggerConditions: ['發版', 'tag'],
    executionSteps: ['Run checks.', 'Push the tag.'],
    summary: '打 tag 推 release 的固定流程',
    usageCount: 7,
    status: 'active',
  };
  const ctx = makeEngine([skill]);

  const result = await ctx.engine.assemble([user('請幫我發版並建立 tag')]);
  const injected = result.messages.find(message => message.role === 'system')?.content ?? '';

  assert.match(injected, /^\[可用技能\]\n/);
  assert.match(
    injected,
    /- 【git-release】觸發: 發版, tag \| 摘要: 打 tag 推 release 的固定流程 → 完整步驟用 skill_load\("git-release"\)/,
  );
  assert.doesNotMatch(injected, /Run checks|Push the tag|執行步驟/);
  assert.equal(skill.usageCount, 7);
  assert.equal(ctx.getUpdateCalls(), 0);
});

test('autoRecall omits the skill block when stage-1 search has no matches', async () => {
  const ctx = makeEngine([]);

  const result = await ctx.engine.assemble([user('這是一段足夠長的查詢')]);
  const context = result.messages.map(message => String(message.content ?? '')).join('\n');

  assert.doesNotMatch(context, /\[可用技能\]/);
  assert.equal(ctx.getUpdateCalls(), 0);
});
