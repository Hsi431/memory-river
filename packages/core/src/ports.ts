// ── LLM：所有「丟 prompt 拿文字」的呼叫唯一入口 ─────────────────
export interface LlmClient {
  /** 回傳純文字。實作端自行負責 fallback / rate limit / circuit breaker。 */
  generate(prompt: string, opts?: { purpose?: string; maxTokens?: number }): Promise<string>;
}

// ── Embedding ───────────────────────────────────────────────
export interface EmbeddingProvider {
  embed(text: string, mode?: 'store' | 'query'): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  getDimensions(): number;
  healthCheck?(): Promise<boolean>;
}

// ── 觀測 / 通知 ──────────────────────────────────────────────
export interface Logger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}
export interface Notifier {
  /** 夜間日報、降級告警。沒提供就靜默跳過。 */
  notify(message: string): Promise<void>;
}

// ── 宿主回呼（adapter 實作；core 不認識任何框架） ─────────────
export interface SessionFileAccess {
  /** 宿主若有「session 對話檔」概念才需要實作；沒有就回 null，compact 功能自動停用。 */
  resolveSessionFile(identity: { sessionKey?: string; sessionId?: string }): string | null;
}
