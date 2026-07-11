/**
 * Ralph Loop Core Logic - Memory River 專用核心邏輯 (TypeScript 版)
 * 負責：物理截斷錯誤上下文、提取任務目標、生成偽裝警告。
 */

/**
 * 從訊息陣列尾巴往前修剪連續的工具錯誤與無效嘗試
 * 確保保留 System Prompt 與最初的 User 指令
 *
 */
export function trimTailErrors(msgs: any[]): any[] {
  // 基礎防禦：如果訊息太少則不處理
  if (!msgs || msgs.length < 3) return msgs;

  // 1. 找到保護邊界：第一則 role: 'user' 訊息的位置 (通常是原始任務)
  const firstUserIdx = msgs.findIndex((m: any) => m.role === 'user');
  
  // 如果連 user 訊息都找不到，代表 context 異常，直接回傳
  if (firstUserIdx === -1) return msgs; 

  // 2. 從尾巴往前搜尋，找出需要被切除的「報錯污染區」
  let i = msgs.length - 1;
  let splitIdx = msgs.length; // 預設切點在最後

  while (i > firstUserIdx) {
    const curr = msgs[i];
    
    // 判定該訊息是否為錯誤訊號：
    // - role 為 'tool' (工具回報錯誤)
    // - role 為 'assistant' 但內容包含 error/failed 關鍵字
    const isError = 
      curr.role === 'tool' || 
      (curr.role === 'assistant' && curr.content && /error|failed|fault/i.test(curr.content));
    
    // 判定是否為導致報錯的工具呼叫 (assistant 帶有 tool_calls)
    const isToolAction = curr.role === 'assistant' && curr.tool_calls;

    if (isError || isToolAction) {
      // 只要是報錯或報錯鏈中的行為，就將切點往前移
      splitIdx = i;
      i--;
    } else {
      // 撞見正常的對話（例如使用者中間的插話或 AI 正常的解釋），停止裁切
      break;
    }
  }

  // 3. 執行物理裁切，只保留 splitIdx 之前的內容
  return msgs.slice(0, splitIdx);
}

/**
 * 從訊息歷史中提取最原始的任務目標
 *
 */
export function extractGoalFromMsgs(msgs: any[]): string {
  if (!msgs || msgs.length === 0) return '繼續執行當前任務';
  
  // 穿過系統提示詞，找到第一則使用者輸入
  const firstUser = msgs.find((m: any) => m.role === 'user');
  
  if (!firstUser) return '處理目前請求';

  // 處理內容可能是字串或陣列的情況
  if (typeof firstUser.content === 'string') return firstUser.content;
  if (Array.isArray(firstUser.content)) {
    return firstUser.content.map((c: any) => c.text || '').join(' ');
  }
  
  return '執行既定目標';
}

/**
 * 生成偽裝成 Assistant 的斷路器警告
 * 讓 AI 認為這是自己深刻反省後的決策
 */
export function generateWarning(goal: string): any {
  // 截短目標文字，避免警告訊息過長
  const truncatedGoal = goal?.length > 100 ? goal.slice(0, 100) + '...' : goal;

  return {
    role: 'assistant', // 關鍵：role 必須是 assistant
    content: `【Ralph Loop 斷路器介入檢測】

偵測到目前執行路徑出現連續工具錯誤，為了保護上下文純淨，我已主動清理了無效的報錯紀錄。

重新校準核心目標：
> "${truncatedGoal}"

⚠️ 接下來我將：
1. 檢視先前的失敗原因，嘗試不同的解決路徑。
2. 優先確保現有資源配置正確，不再重複錯誤的參數。
3. 若仍無法解決，我將向使用者請求新的技術指引。

讓我們重新對焦並繼續前進。`
  };
}
export const RalphState = {
  consecutiveErrors: 0,
  needsReset: false,

  onError() {
    this.consecutiveErrors++;
    console.log(`[Ralph Loop] Tool error detected; consecutive errors: ${this.consecutiveErrors}`);
    if (this.consecutiveErrors >= 3) this.needsReset = true;
  },

  onSuccess() {
    if (this.consecutiveErrors > 0) console.log('[Ralph Loop] Tool execution succeeded; error count reset');
    this.consecutiveErrors = 0;
    this.needsReset = false;
  },

  shouldIntercept() { return this.needsReset; },
  reset() { this.consecutiveErrors = 0; this.needsReset = false; },
};
