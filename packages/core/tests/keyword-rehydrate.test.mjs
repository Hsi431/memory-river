import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryRiver } from '../dist/api.js';
import { resolvePaths } from '../dist/paths.js';
import {
  buildKeywordSearchTerms,
  matchesKeywordSearch,
  rankKeywordMatches,
} from '../dist/transcript/keyword-search.js';

function createRiver(root) {
  const config = {
    dataDir: path.join(root, 'data'),
    ramDir: path.join(root, 'ram'),
    autoRecall: false,
  };
  const river = createMemoryRiver(config, {
    embedder: {
      embed: async () => [0, 0, 0, 0],
      embedBatch: async texts => texts.map(() => [0, 0, 0, 0]),
      getDimensions: () => 4,
      healthCheck: async () => true,
    },
    llm: {
      generate: async () => '{}',
    },
  });
  return { config, river };
}

function candidate(value, text, timestamp) {
  return { value, text, timestamp };
}

test('ranked keyword matching returns partial Chinese multi-token matches', () => {
  const results = rankKeywordMatches([
    candidate('correct', '姑姑從鹿港寄來一罐桂雨烏龍', 100),
    candidate('unrelated', '今天去了市場', 200),
  ], '茶 寄來');

  assert.deepEqual(results, ['correct']);
  assert.equal(matchesKeywordSearch('姑姑從鹿港寄來一罐桂雨烏龍', '茶 寄來'), true);
});

test('single-token keyword keeps substring behavior', () => {
  assert.equal(matchesKeywordSearch('alphabet soup', 'pha'), true);
  assert.equal(matchesKeywordSearch('alphabet soup', 'zzz'), false);
});

test('two-token matches rank above newer one-token matches', () => {
  const results = rankKeywordMatches([
    candidate('one-token-newer', '只有寄來', 200),
    candidate('two-token-older', '茶已經寄來', 100),
  ], '茶 寄來');

  assert.deepEqual(results, ['two-token-older', 'one-token-newer']);
});

test('ultra-common single-CJK and single-ASCII tokens do not match', () => {
  assert.deepEqual(buildKeywordSearchTerms('的 了 a'), []);
  assert.deepEqual(
    rankKeywordMatches([candidate('broad', '他的資料在這裡了 a', 100)], '的 了 a'),
    [],
  );
});

test('English multi-token partial matches use the same ranking', () => {
  const results = rankKeywordMatches([
    candidate('partial', 'The deployment completed yesterday', 200),
    candidate('full', 'The river deployment completed', 100),
  ], 'river deployment');

  assert.deepEqual(results, ['full', 'partial']);
});

test('core keyword rehydrate route returns the partial match instead of empty', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keyword-rehydrate-'));
  const { config, river } = createRiver(root);
  const transcriptDir = resolvePaths(config).transcriptsDir;
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, 'conversation.jsonl'), [
    JSON.stringify({
      entryId: 1,
      sessionId: 'conversation',
      user: '姑姑送了什麼？',
      assistant: '姑姑從鹿港寄來一罐桂雨烏龍',
      timestamp: 100,
    }),
  ].join('\n') + '\n');

  try {
    const results = await river.rehydrate({
      mode: 'keyword',
      keyword: '茶 寄來',
      sessionKey: 'conversation',
      limit: 10,
    });
    assert.deepEqual(results.map(entry => entry.entryId), [1]);
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${root}:`, error?.code ?? error);
    }
  }
});
