import test from 'node:test';
import assert from 'node:assert/strict';

import { HooksEngine } from '../dist/cognition/hooks-engine.js';

function makeMemory(keyword) {
  return {
    id: `memory-${keyword}`,
    text: `memory for ${keyword}`,
    category: 'fact',
    importance: 0.8,
    metadata: {
      hooks: [{ keyword, weight: 'high', weightScore: 1 }],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeEngine(keyword, embed) {
  const store = {
    queryHookBearing: async () => [makeMemory(keyword)],
    onShutdown: () => {},
  };
  const calls = [];
  const embedder = {
    embed: async (text, mode) => {
      calls.push({ text, mode });
      return embed(text, mode);
    },
  };

  return {
    engine: new HooksEngine(store, embedder, { cooldownMs: 0 }),
    calls,
  };
}

function makeEngineWithMemories(memories, embed) {
  const store = {
    queryHookBearing: async () => memories,
    queryAll: async () => memories.slice(0, 100),
    onShutdown: () => {},
  };
  const calls = [];
  const embedder = {
    embed: async (text, mode) => {
      calls.push({ text, mode });
      return embed(text, mode);
    },
  };

  return {
    engine: new HooksEngine(store, embedder, { cooldownMs: 0 }),
    calls,
  };
}

test('semantically similar English query triggers a Chinese hook keyword', async () => {
  const hookKeyword = '資料庫效能優化';
  const query = 'How can I improve database performance?';
  const semanticQueryText = `${query} can improve database performance`;
  const { engine, calls } = makeEngine(hookKeyword, async (text) => {
    if (text === semanticQueryText) return [1, 0];
    return [0.82, Math.sqrt(1 - 0.82 ** 2)];
  });

  const result = await engine.triggerHooks(query);

  assert.equal(result.triggered, true);
  assert.equal(result.relatedMemories[0].viaHook, hookKeyword);
  assert.deepEqual(calls, [
    { text: semanticQueryText, mode: 'query' },
    { text: hookKeyword, mode: 'store' },
  ]);
});

test('semantic matching stays enabled for high-weight candidates in a large hook pool', async () => {
  const targetHook = '資料庫效能優化';
  const memories = Array.from({ length: 60 }, (_, index) => ({
    ...makeMemory(`decoy-keyword-${index}`),
    metadata: {
      hooks: [{ keyword: `decoy-keyword-${index}`, weight: 'medium', weightScore: 0.6 }],
    },
  }));
  memories.push(makeMemory(targetHook));

  const query = 'How should I improve database performance?';
  const semanticQueryText = `${query} should improve database performance`;
  const { engine, calls } = makeEngineWithMemories(memories, async (text, mode) => {
    if (mode === 'query' && text === semanticQueryText) return [1, 0];
    if (mode === 'store' && text === targetHook) return [0.82, Math.sqrt(1 - 0.82 ** 2)];
    return [0, 1];
  });

  const result = await engine.triggerHooks(query);

  assert.equal(result.triggered, true);
  assert.equal(result.relatedMemories[0].viaHook, targetHook);
  assert.equal(calls.filter(call => call.mode === 'query').length, 1);
  assert.equal(calls.filter(call => call.mode === 'store').length, 50);
});

test('semantic query embedding includes graph-expanded keywords', async () => {
  const hookKeyword = '海洋生物學家 研究地點';
  const query = 'Where did Diana move?';
  const semanticQueryText = `${query} diana move 沖繩 珊瑚礁`;
  const { engine, calls } = makeEngine(hookKeyword, async (text) => {
    if (text === semanticQueryText) return [1, 0];
    return [0.82, Math.sqrt(1 - 0.82 ** 2)];
  });
  engine.setGraphStore({
    semanticExpand: async () => ({ expandedKeywords: ['沖繩', '珊瑚礁', '沖繩'] }),
  });

  const result = await engine.triggerHooks(query);

  assert.equal(result.triggered, true);
  assert.equal(result.relatedMemories[0].viaHook, hookKeyword);
  assert.deepEqual(calls, [
    { text: semanticQueryText, mode: 'query' },
    { text: hookKeyword, mode: 'store' },
  ]);
});

test('triggerHooks scans hook-bearing candidates beyond the old 100 row cap', async () => {
  const memories = Array.from({ length: 125 }, (_, index) => makeMemory(`hook-${index}`));
  memories[124] = makeMemory('late database hook');
  const { engine } = makeEngineWithMemories(memories, async (_text, mode) => {
    return mode === 'query' ? [1, 0] : [0, 1];
  });

  const result = await engine.triggerHooks('late database hook');

  assert.equal(result.triggered, true);
  assert.equal(result.relatedMemories[0].memory.id, 'memory-late database hook');
  assert.equal(result.relatedMemories[0].viaHook, 'late database hook');
});

test('unrelated query with low cosine does not trigger', async () => {
  const hookKeyword = '資料庫效能優化';
  const query = 'planning a beach vacation';
  const semanticQueryText = `${query} planning beach vacation`;
  const { engine } = makeEngine(hookKeyword, async (text) => {
    if (text === semanticQueryText) return [1, 0];
    return [0.3, Math.sqrt(1 - 0.3 ** 2)];
  });

  const result = await engine.triggerHooks(query);

  assert.equal(result.triggered, false);
  assert.deepEqual(result.relatedMemories, []);
});

test('exact literal match triggers without calling the embedder', async () => {
  const { engine, calls } = makeEngine('database migration', async () => {
    throw new Error('embedder unavailable');
  });

  const result = await engine.triggerHooks('database migration');

  assert.equal(result.triggered, true);
  assert.equal(result.relatedMemories[0].viaHook, 'database migration');
  assert.equal(calls.length, 0);
});

test('English stopword "of" does not trigger a literal match', async () => {
  const { engine } = makeEngine('of', async () => {
    throw new Error('embedder unavailable');
  });

  const result = await engine.triggerHooks('history of systems');

  assert.equal(result.triggered, false);
});

test('stopword-only query does not false-positive match', async () => {
  const { engine, calls } = makeEngine('the', async () => [1, 0]);

  const result = await engine.triggerHooks('the of and');

  assert.equal(result.triggered, false);
  assert.equal(calls.length, 0);
});
