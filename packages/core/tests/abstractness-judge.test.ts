import test from 'node:test';
import assert from 'node:assert/strict';

import { judgeAbstractness } from '../src/retrieval/abstractness-judge.ts';

test('rejects abstract Q1 samples', () => {
  for (const text of [
    '用戶正在根據 AI 的建議調整工具的傳遞方式以解決錯誤',
    'AI 已成功理解並執行了所有指令,完成了記憶蒸餾任務',
    'Agent 類型被選用於需要根據工具描述進行推理的場景',
    '用戶根據 AI 的建議調整工具',
  ]) {
    assert.equal(judgeAbstractness(text).isAbstract, true, text);
  }
});

test('keeps concrete Q1 and recon samples', () => {
  for (const text of [
    'xiaomi-coding/mimo-v2.5-pro(104萬context,32K output,text only)',
    '新韌體100%在跑:init OK, FLUSH呼叫, tick活潑',
    'OpenClaw 訊息注入:直接在 Hook 中寫邏輯,在 agent:bootstrap 事件中',
    'Threads radar cron 修正:05:30 雷達跑完,dispatch 改 06:30',
    'Skill Evolution Brain 的 Dashboard 運行於 port 8766',
    '老闆的貓 Maru,黑色長毛貓,今年 5 歲',
  ]) {
    assert.equal(judgeAbstractness(text).isAbstract, false, text);
  }
});

test('skips short text', () => {
  assert.equal(judgeAbstractness('OK').isAbstract, false);
  assert.equal(judgeAbstractness('已完成').isAbstract, false);
});

test('handles hook tags', () => {
  const result = judgeAbstractness('用戶正在調整工具 [#ai_輔助 #策略]');
  assert.equal(result.isAbstract, true);
  assert.ok(result.reasons.includes('meta_narration'));
});
