/**
 * Ralph Loop v2 — 斷路器接入層
 * 負責監聽 OpenClaw 事件並維護狀態
 */
import {
  trimTailErrors,
  generateWarning,
  extractGoalFromMsgs,
  RalphState,
} from '@memory-river/core/cognition/ralph-core';

export { RalphState };

export function createRalphLoop() {
  return {
    name: 'ralph-loop',
    register(api: any) { // 加入 : any 解決 TS7006
      console.log('[Ralph Loop] 🟢 V2 斷路器已掛載至 Plugin API');

      // 監聽工具錯誤
      api.on('after_tool_call', async (event: any) => {
        const hasError = !!(event.error || (event.result?.error));
        if (hasError) RalphState.onError();
        else RalphState.onSuccess();
      });

      // 攔截 Agent 啟動，進行物理截斷
      api.on('before_agent_start', async (event: any) => {
        if (!RalphState.shouldIntercept()) return;
        console.log('🚨 [Ralph Loop] 啟動電擊去顫（物理截斷）！');
        
        // 取得目前訊息
        const msgs = Array.isArray(event.messages) ? event.messages : [];
        const goal = extractGoalFromMsgs(msgs);
        
        // 呼叫 core 裡面的重活
        const trimmedMsgs = trimTailErrors(msgs);
        const warning = generateWarning(goal);

        // 強制替換 OpenClaw 的傳址陣列
        if (Array.isArray(event.messages)) {
          event.messages.length = 0;
          event.messages.push(...trimmedMsgs, warning);
        }
      });

      // 確保 Session 結束時歸零
      api.on('agent_end', async () => {
        RalphState.reset();
      });
    }
  };
}

export default createRalphLoop;
