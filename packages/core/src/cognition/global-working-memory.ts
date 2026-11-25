/**
 * Global Working Memory (GWM) — 全局工作記憶引擎
 * 
 * 功能：
 * - 追蹤當前任務主題，計算 embedding drift
 * - 當用戶對話偏離主題超過 5 輪，inject 工作記憶提醒
 * - 支援 gwm_on/off/status/update 工具命令
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Embedder } from '../providers/embedder-v5.js';

export interface GwmState {
  active: boolean;
  taskName: string;
  taskDescription: string;
  keywords: string[];
  embedding: number[];
  driftRoundCount: number;
  createdAt: number;
}

export interface DriftResult {
  isDrifting: boolean;
  similarity: number;
}

interface GwmSessionMemory {
  state: GwmState | null;
  pendingInject: boolean;
  lastDriftText: string;
  lastDriftVector: number[] | null;
}

// ─── Cosine Similarity ──────────────────────────────────────────────────────
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const d = Math.sqrt(normA) * Math.sqrt(normB);
  return d === 0 ? 0 : dotProduct / d;
}

// ─── Keyword Extractor ───────────────────────────────────────────────────────
function extractKeywords(text: string): string[] {
  const stopwords = new Set([
    '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一個', '上', '也', '很', '到', '說', '要', '去', '你',
    '會', '著', '沒有', '看', '好', '自己', '這', '什麼', '還', '這個', '那個', '然後', '如果', '所以', '但是', '可以', '因為',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'in', 'to', 'for', 'with', 'on', 'at', 'by', 'from', 'as', 'or', 'and',
    'it', 'that', 'this', 'i', 'you', 'we', 'they', 'he', 'she', 'my', 'your', 'our', 'their',
  ]);
  const raw = text
    .split(/[\s,，、。.!！?？:：;；""''（）\(\)\[\]]+/)
    .filter((w: string) => w.length > 1 && !stopwords.has(w.toLowerCase()));
  // 去重
  return Array.from(new Set<string>(raw)).slice(0, 5);
}

// ─── GlobalWorkingMemory ────────────────────────────────────────────────────
export class GlobalWorkingMemory {
  private embedder: Embedder;
  private sessionMemory = new Map<string, GwmSessionMemory>();
  private driftThreshold: number;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(
    embedder: Embedder,
    private readonly stateFile: string,
    driftThreshold: number = 0.65,
  ) {
    this.embedder = embedder;
    this.driftThreshold = driftThreshold;
  }

  private memoryFor(sessionKey?: string): GwmSessionMemory {
    const key = typeof sessionKey === 'string' ? sessionKey.trim() : '';
    let memory = this.sessionMemory.get(key);
    if (!memory) {
      memory = { state: null, pendingInject: false, lastDriftText: '', lastDriftVector: null };
      this.sessionMemory.set(key, memory);
    }
    return memory;
  }

  // ── State I/O ──────────────────────────────────────────────────────────────
  private save(): Promise<void> {
    this.saveQueue = this.saveQueue.catch(() => {}).then(async () => {
      const sessions: Record<string, GwmState> = Object.create(null);
      for (const [sessionKey, memory] of this.sessionMemory) {
        if (memory.state) sessions[sessionKey] = memory.state;
      }
      if (Object.keys(sessions).length === 0) {
        try {
          await fs.promises.unlink(this.stateFile);
        } catch { /* file may not exist */ }
        return;
      }
      const dir = path.dirname(this.stateFile);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(this.stateFile, JSON.stringify({ formatVersion: 2, sessions }, null, 2), 'utf-8');
    });
    return this.saveQueue;
  }

  async load(): Promise<GwmState | null> {
    try {
      const data = await fs.promises.readFile(this.stateFile, 'utf-8');
      const parsed = JSON.parse(data);
      if (parsed?.formatVersion === 2 && parsed.sessions && typeof parsed.sessions === 'object') {
        for (const [sessionKey, state] of Object.entries(parsed.sessions)) {
          if (state && typeof state === 'object') this.memoryFor(sessionKey).state = state as GwmState;
        }
      } else if (parsed && typeof parsed === 'object' && 'active' in parsed) {
        // Legacy files contain a single GwmState and represent the unkeyed session.
        this.memoryFor().state = parsed as GwmState;
      }
      return this.memoryFor().state;
    } catch {
      return null;
    }
  }

  // ── GWM Tools ──────────────────────────────────────────────────────────────
  async gwmOn(taskName: string, taskDescription: string, keywords?: string[], sessionKey?: string): Promise<string> {
    const memory = this.memoryFor(sessionKey);
    const kw = keywords && keywords.length > 0
      ? keywords
      : extractKeywords(taskDescription);

    const embedding = await this.embedder.embed(taskDescription, 'store');

    memory.state = {
      active: true,
      taskName,
      taskDescription,
      keywords: kw,
      embedding,
      driftRoundCount: 0,
      createdAt: Date.now(),
    };

    await this.save();
    return `[✅ GWM 啟動] 任務：${taskName}，關鍵字：${kw.join(', ')}`;
  }

  async gwmOff(sessionKey?: string): Promise<string> {
    const memory = this.memoryFor(sessionKey);
    memory.state = null;
    memory.pendingInject = false;
    await this.save();
    return '[✅ GWM 已關閉]';
  }

  gwmStatus(sessionKey?: string): string {
    const state = this.memoryFor(sessionKey).state;
    if (!state || !state.active) {
      return '[📋 GWM 狀態] 目前未啟動';
    }
    return [
      '[📋 GWM 狀態]',
      `任務：${state.taskName}`,
      `描述：${state.taskDescription}`,
      `關鍵字：${state.keywords.join(', ')}`,
      `Drift 輪數：${state.driftRoundCount}/5`,
      `啟動時間：${new Date(state.createdAt).toLocaleString('zh-TW')}`,
    ].join('\n');
  }

  async gwmUpdate(updates: { taskName?: string; taskDescription?: string; keywords?: string[] }, sessionKey?: string): Promise<string> {
    const memory = this.memoryFor(sessionKey);
    if (!memory.state) return '[❌ GWM 未啟動]';

    if (updates.taskName) memory.state.taskName = updates.taskName;
    if (updates.taskDescription) {
      memory.state.taskDescription = updates.taskDescription;
      // re-embed if description changed
      memory.state.embedding = await this.embedder.embed(updates.taskDescription, 'store');
    }
    if (updates.keywords) memory.state.keywords = updates.keywords;

    await this.save();
    return '[✅ GWM 已更新]';
  }

  // ── Drift Detection ────────────────────────────────────────────────────────
  async detectDrift(userMessages: { role: string; content: string | any[] }[], sessionKey?: string): Promise<DriftResult> {
    const memory = this.memoryFor(sessionKey);
    const state = memory.state;
    if (!state || !state.active) {
      return { isDrifting: false, similarity: 1 };
    }

    // 取出最近 1 筆 user message
    let lastUserText = '';
    for (let i = userMessages.length - 1; i >= 0; i--) {
      const m = userMessages[i];
      if (m.role === 'user') {
        if (typeof m.content === 'string') {
          lastUserText = m.content;
        } else if (Array.isArray(m.content)) {
          lastUserText = m.content.map((c: any) => c.type === 'text' ? c.text : '').join(' ');
        }
        break;
      }
    }

    if (!lastUserText) return { isDrifting: false, similarity: 1 };

    // 🛡️ 短句保護：< 10 字的回覆（如「好」「繼續」）不計入 drift
    if (lastUserText.trim().length < 10) {
      return { isDrifting: state.driftRoundCount >= 2, similarity: 1 };
    }

    // 🛠️ Embedding 快取：同一句話不重複呼叫 Ollama
    let msgEmbedding: number[];
    if (lastUserText === memory.lastDriftText && memory.lastDriftVector) {
      msgEmbedding = memory.lastDriftVector;
    } else {
      msgEmbedding = await this.embedder.embed(lastUserText, 'store');
      memory.lastDriftText = lastUserText;
      memory.lastDriftVector = msgEmbedding;
    }

    const similarity = cosineSimilarity(msgEmbedding, state.embedding);

    if (similarity < this.driftThreshold) {
      state.driftRoundCount += 1;
    } else {
      state.driftRoundCount = Math.max(0, state.driftRoundCount - 1); // 慢慢恢復，不直接歸零
    }

    await this.save();

    const isDrifting = state.driftRoundCount >= 2; // 2 輪就觸發（原本 5 輪太晚）
    if (isDrifting) {
      this.requestInject(sessionKey);
    }
    return { isDrifting, similarity };
  }

  // ── Check & consume inject (injectOnce 模式) ──────────────────────────────
  shouldInject(sessionKey?: string): boolean {
    const memory = this.memoryFor(sessionKey);
    return memory.pendingInject && memory.state?.active === true;
  }

  async markInjected(sessionKey?: string): Promise<void> {
    const memory = this.memoryFor(sessionKey);
    memory.pendingInject = false;
    if (memory.state) {
      // 不歸零，只減 1 — 持續施壓，如果下一輪還是漂移就會立刻再次提醒
      memory.state.driftRoundCount = Math.max(0, memory.state.driftRoundCount - 1);
      await this.save();
    }
  }

  requestInject(sessionKey?: string): void {
    this.memoryFor(sessionKey).pendingInject = true;
  }

  // ── Reminder Message ───────────────────────────────────────────────────────
  getReminderMessage(sessionKey?: string): string {
    const state = this.memoryFor(sessionKey).state;
    if (!state) return '';
    return [
      `⚠️【重要指令】你的當前任務是「${state.taskName}」。`,
      `任務描述：${state.taskDescription}`,
      `關鍵字：${state.keywords.join(', ')}`,
      ``,
      `❗ 如果你現在做的事情與上述任務無關，請立即停下並回到主線。`,
      `如果你認為當前工作是完成任務的必要步驟，請在回覆中明確說明關聯性。`,
    ].join('\n');
  }

  isActive(sessionKey?: string): boolean {
    return this.memoryFor(sessionKey).state?.active === true;
  }

  getState(sessionKey?: string): GwmState | null {
    return this.memoryFor(sessionKey).state;
  }
}

export default GlobalWorkingMemory;
