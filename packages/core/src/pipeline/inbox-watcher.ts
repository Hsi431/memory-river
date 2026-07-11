/**
 * InboxWatcher - 記憶 inbox 觀察者 + River Capsule 處理器
 * memory-river
 * * 改造要點：
 * - inbox 路徑從構造函數參數傳入（不再 hardcode）
 * - import 改為來自同目錄的本地模組
 * - 保留 writeInbox() static 方法給 CapsuleBridge 呼叫
 * - processRiverCapsule() 方法處理 river_capsule_*.txt 檔
 */

import fs from "node:fs";
import path from "node:path";
import { MemoryStore } from "../store/store-v4.js";
import { StatusManager } from "../store/status-manager.js";
import { Embedder } from "../providers/embedder-v5.js";
import { CausalEngine } from "../cognition/causal-engine.js";
import { HooksEngine } from "../cognition/hooks-engine.js";
import { ConflictDetector } from "../cognition/conflict-detector.js";
import { GraphStore } from "../store/graph-store.js";
import { judgeAbstractness } from "../retrieval/abstractness-judge.js";
import type { MemoryCategory } from "../types.js";
import type { LlmClient } from "../ports.js";
import { setBoundedMapEntry } from "../util/bounded-map.js";
import { resolveSessionIdentity } from "../util/session-identity.js";
import {
  isCompactRequestFilename,
  readCompactRequest,
  type AsyncCompactRequest,
  type CompactRequestInboxItem,
} from "./compact-request.js";

const DEBUG = true;

// ============================================================================
// Retry Utility — 指數退避重試，避免 API/LanceDB 瞬斷卡死系統
// ============================================================================

interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableErrors?: ((err: any) => boolean);
  label?: string;
}

/**
 * 带 Exponential Backoff 的重試裝甲
 * - baseDelayMs 起跳，指数增长，上限 maxDelayMs
 * - retryableErrors: callback，判斷這個錯誤是否值得重試（不回傳 true 就立即放行，不重試）
 * - 所有重試耗盡才拋出最後一個錯誤
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 50,
    maxDelayMs = 2000,
    retryableErrors = () => false,
    label = 'operation',
  } = opts;

  let lastError: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;

      // 不值得重試的錯誤，立即放行
      if (!retryableErrors(err)) throw err;

      if (attempt === maxAttempts) {
        console.warn(`[withRetry] ${label} failed after ${maxAttempts} attempts: ${err?.message ?? err}`);
        throw err;
      }

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      console.warn(`[withRetry] ${label} failed (attempt ${attempt}/${maxAttempts}); retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// 判斷錯誤是否值得重試（網路瞬斷 / LanceDB 瞬斷）
function isRetryableError(err: any): boolean {
  if (!err) return false;
  const msg = String(err?.message ?? err).toLowerCase();
  // 網路相關
  if (err.name === 'FetchError' || err.name === 'TypeError') return true; // fetch 底層錯誤
  if (msg.includes('timeout') || msg.includes('timed out')) return true;
  if (msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('enotfound')) return true;
  if (msg.includes('network') || msg.includes('fetch')) return true;
  // Gemini / API 503 / 429
  if (err?.status === 503 || err?.status === 429) return true;
  if (msg.includes('503') || msg.includes('service unavailable')) return true;
  if (msg.includes('429') || msg.includes('rate limit')) return true;
  // LanceDB 瞬斷
  if (msg.includes('lance') && (msg.includes('io error') || msg.includes('locked') || msg.includes('commit'))) return true;
  if (msg.includes('lance') && (msg.includes('timeout') || msg.includes('busy'))) return true;
  return false;
}

export class InboxWatcher {
  private static readonly RIVER_CAPSULE_FAILURE_THRESHOLD = 5;
  private static readonly RIVER_CAPSULE_FAILURE_LRU_MAX = 500;
  private intervalId: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private processingStartedAt = 0;
  private started = false;
  private fatalErrorCount = 0;
  private riverCapsuleFailureCounts = new Map<string, number>();
  // 每個 parentId 的寫入鎖，防止同時對同一個記憶發出兩次 UPDATE
  private parentIdLocks = new Map<string, Promise<void>>();

  private async withParentLock<T>(parentId: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.parentIdLocks.get(parentId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    this.parentIdLocks.set(parentId, next);
    try {
      await existing;
      return await fn();
    } finally {
      release();
      // 只在沒有後繼等待者時才清除，避免 Map 洩漏
      if (this.parentIdLocks.get(parentId) === next) {
        this.parentIdLocks.delete(parentId);
      }
    }
  }

  private parseMetadata(metaStr: string | undefined): Record<string, any> {
    if (!metaStr) return {};
    try { return JSON.parse(metaStr); } catch { return {}; }
  }

  constructor(
    private store: MemoryStore,
    private embedder: Embedder,
    private causalEngine: CausalEngine,
    private hooksEngine: HooksEngine | null,
    private graphStore: GraphStore | null,
    private llm: LlmClient,
    private inboxPath: string,
    private pollIntervalMs: number = 2000,
    private conflictDetector: ConflictDetector | undefined,
    private statusManager: StatusManager,
    private compactRequestProcessor: (req: AsyncCompactRequest) => Promise<void>,
  ) {}

  setDependencies(hooksEngine: HooksEngine, graphStore: GraphStore): void {
    this.hooksEngine = hooksEngine;
    this.graphStore = graphStore;
  }

  private countPendingFiles(): number {
    if (!fs.existsSync(this.inboxPath)) return 0;
    try {
      const files = fs.readdirSync(this.inboxPath);
      const pendingJson = files.filter(f => f.endsWith(".json") && !f.startsWith("reflection_task")).length;
      const riverCapsules = files.filter(f => f.startsWith("river_capsule_") && f.endsWith(".txt")).length;
      return pendingJson + riverCapsules;
    } catch {
      return 0;
    }
  }

  private runProcessInbox(trigger: 'start' | 'interval'): void {
    void this.processInbox(trigger).catch(err => {
      console.error(`[InboxWatcher] ${trigger} processInbox uncaught error:`, err);
    });
  }

  private recordFatalError(fileName: string, errMsg: string): void {
    this.fatalErrorCount += 1;
    if (this.fatalErrorCount >= 3) {
      console.error(`[InboxWatcher] Fatal error alarm: count=${this.fatalErrorCount} latestFile=${fileName} latestError=${errMsg}`);
    }
  }

  private setRiverCapsuleFailureCount(sessionKey: string, count: number): void {
    setBoundedMapEntry(
      this.riverCapsuleFailureCounts,
      sessionKey,
      count,
      InboxWatcher.RIVER_CAPSULE_FAILURE_LRU_MAX,
    );
  }

  private classifyRiverCapsuleReason(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();
    if (lower.includes("timeout") || lower.includes("timed out")) return "embed_timeout";
    if (lower.includes("lance") || lower.includes("commit conflict")) return "lancedb_write_error";
    if (lower.includes("enoent")) return "capsule_file_missing";
    if (lower.includes("capsule_meta")) return "capsule_meta_parse_error";
    if (lower.includes("json")) return "capsule_meta_parse_error";
    if (lower.includes("writeinbox")) return "inbox_write_error";
    return "river_capsule_process_error";
  }

  private async recordRiverCapsuleStat(stat: {
    sessionKey: string;
    outcome: "success" | "failure";
    reason: string | null;
    durationMs: number | null;
    meta: string;
  }): Promise<void> {
    try {
      await this.store.recordConcentratorStat({
        canonicalKey: stat.sessionKey?.trim() || "unknown",
        sessionId: null,
        provider: "all_failed",
        outcome: stat.outcome,
        attemptedProviders: "[]",
        inputTokens: 0,
        outputTokens: null,
        durationMs: stat.durationMs ?? 0,
        failureReason: stat.outcome === "failure" ? "other" : null,
        createdAt: Date.now(),
      });
    } catch (err) {
      console.warn("[InboxWatcher] Failed to write concentrator_stats:", err);
    }
  }

  private async moveRiverCapsuleToError(filePath: string): Promise<void> {
    const errorDir = path.join(path.dirname(filePath), "error");
    if (!fs.existsSync(errorDir)) fs.mkdirSync(errorDir, { recursive: true });
    const targetPath = path.join(errorDir, path.basename(filePath));
    fs.renameSync(filePath, targetPath);
  }

  /**
   * 從 river capsule meta 推導 stat / failure counter 用的 key。
   *
   * 與 sessionIdentity 主鏈不同：river capsule 的 metadata 可能巢狀
   * （capsuleMeta.metadata.sessionKey），且最後保底是 filename，不是 'global'。
   * 因此先把巢狀欄位攤平成標準 payload，再交給 sessionIdentity 解析；
   * 若 isFallback（payload 完全沒有 session 身分）才退到 filename。
   */
  private getRiverCapsuleSessionKey(capsuleMeta: Record<string, any>, filePath: string): string {
    const normalized = {
      sessionKey: capsuleMeta.sessionKey ?? capsuleMeta.metadata?.sessionKey,
      sessionId: capsuleMeta.sessionId ?? capsuleMeta.metadata?.sessionId,
    };
    const identity = resolveSessionIdentity(normalized);
    return identity.isFallback ? path.basename(filePath) : identity.canonicalKey;
  }

  start(): void {
    if (this.started) {
      console.log('[InboxWatcher] start() skipped: watcher already started');
      return;
    }
    this.started = true;

    if (DEBUG) console.log('\x1b[35m[MemoryRiver Watcher] Watcher started and ready to process inbox items\x1b[0m');

    if (!fs.existsSync(this.inboxPath)) {
      fs.mkdirSync(this.inboxPath, { recursive: true });
    }

    this.intervalId = setInterval(() => {
      this.runProcessInbox('interval');
    }, this.pollIntervalMs);

    // 啟動即收割，處理遺留紙條
    this.runProcessInbox('start');
  }

  stop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.started = false;
  }

  private async processCompactRequest(filePath: string): Promise<{ ok: boolean; reason?: string }> {
    const processingPath = filePath + '.processing';
    const fileName = path.basename(filePath);

    try {
      await fs.promises.rename(filePath, processingPath);
    } catch {
      return { ok: true, reason: 'already-picked' };
    }

    try {
      await withRetry(
        async () => {
          const item = await readCompactRequest(processingPath);
          await this.executeCompactRequest(item);
        },
        {
          maxAttempts: 3,
          baseDelayMs: 50,
          maxDelayMs: 2000,
          retryableErrors: isRetryableError,
          label: `compact request for ${fileName}`,
        }
      );

      await fs.promises.unlink(processingPath);
      console.log(`[inbox-watcher] compact_request processed: ${fileName}`);
      return { ok: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errorDir = path.join(this.inboxPath, 'error');
      const errorPath = path.join(errorDir, fileName);
      await fs.promises.mkdir(errorDir, { recursive: true });
      try {
        await fs.promises.rename(processingPath, errorPath);
      } catch (moveErr) {
        console.error(`[inbox-watcher] compact_request dead-letter move failed: ${fileName}`, moveErr);
      }
      console.error(`[inbox-watcher] compact_request dead-lettered: ${fileName}`, errMsg);
      return { ok: false, reason: errMsg };
    }
  }

  private async executeCompactRequest(item: CompactRequestInboxItem): Promise<void> {
    await this.compactRequestProcessor({
      trackingKey: item.trackingKey,
      sessionId: item.sessionId,
      sessionKey: item.sessionKey,
      originalTokens: item.originalTokens,
      compressedTokens: item.compressedTokens,
      timestamp: item.createdAt,
    });
  }

  private async processInbox(trigger: 'start' | 'interval' = 'interval'): Promise<void> {
    const pendingCount = this.countPendingFiles();
    if (pendingCount > 0 || this.isProcessing) {
      console.log(`[InboxWatcher] tick: pending=${pendingCount} isProcessing=${this.isProcessing} startedAt=${this.processingStartedAt || 0} trigger=${trigger}`);
    }

    // 防止 fetch 永久阻塞：若上次 isProcessing 超過 5 分鐘，強制解鎖
    if (this.isProcessing) {
      if (this.processingStartedAt > 0 && Date.now() - this.processingStartedAt > 5 * 60 * 1000) {
        console.warn('[InboxWatcher] isProcessing exceeded 5 minutes; forcing unlock');
        this.isProcessing = false;
        this.processingStartedAt = 0;
      } else {
        return;
      }
    }
    this.isProcessing = true;
    this.processingStartedAt = Date.now();

    try {
      if (!fs.existsSync(this.inboxPath)) return;
      const allFiles = fs.readdirSync(this.inboxPath).sort();

      // C6: 孤兒 .processing 檔案搶救（系統崩潰後恢復）
      const FIVE_MIN_MS = 5 * 60 * 1000;
      const nowMs = Date.now();
      const orphaned = allFiles.filter(f => f.endsWith('.processing'));
      const oldOrphans = orphaned.filter(f => {
        try {
          const stat = fs.statSync(path.join(this.inboxPath, f));
          return nowMs - stat.mtimeMs > FIVE_MIN_MS;
        } catch { return false; }
      });
      if (oldOrphans.length > 0) {
        console.log(`[InboxWatcher] Found ${oldOrphans.length} orphaned files older than 5 minutes; recovering...`);
        for (const fname of oldOrphans) {
          try {
            const fpath = path.join(this.inboxPath, fname);
            const jsonName = fname.endsWith('.json.processing')
              ? fname.replace(/\.processing$/, '')
              : fname.replace(/\.processing$/, '.json');
            const jsonPath = path.join(this.inboxPath, jsonName);
            if (!fs.existsSync(jsonPath)) {
              fs.renameSync(fpath, jsonPath);
              console.log(`[InboxWatcher] Orphan recovered: ${fname} -> ${jsonName}`);
            } else {
              fs.unlinkSync(fpath);
              console.log(`[InboxWatcher] Orphan removed because target already exists: ${fname}`);
            }
          } catch { /* ignore */ }
        }
      }

      const compactRequestFiles = allFiles.filter(f => isCompactRequestFilename(f));

      // 🌟 寬鬆過濾：只要是 JSON 且不是反思任務，就視為記憶精華
      const pendingFiles = allFiles.filter(f =>
        f.endsWith(".json") && !f.startsWith("reflection_task") && !isCompactRequestFilename(f)
      );

      const riverFiles = allFiles.filter(f => f.startsWith("river_capsule_") && f.endsWith(".txt"));
      const totalWork = compactRequestFiles.length + pendingFiles.length + riverFiles.length;
      if (totalWork > 0) {
        console.log(`[InboxWatcher] processing ${totalWork} files`);
      }

      // C-8：並發處理，上限 INBOX_CONCURRENCY 個同時
      // 單一檔案 stall（timeout）只影響同批其他槽位，不卡死整個佇列
      const INBOX_CONCURRENCY = 3;

      for (let i = 0; i < compactRequestFiles.length; i += INBOX_CONCURRENCY) {
        const batch = compactRequestFiles.slice(i, i + INBOX_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(file => this.processCompactRequest(path.join(this.inboxPath, file)))
        );
        results.forEach((result, index) => {
          const filePath = path.join(this.inboxPath, batch[index]);
          const detail = result.status === 'fulfilled'
            ? (result.value?.ok ? 'ok' : `error=${result.value?.reason ?? 'unknown'}`)
            : `error=${result.reason instanceof Error ? result.reason.message : String(result.reason)}`;
          if (detail !== 'ok') {
            console.log(`[InboxWatcher] compact_request processed: path=${filePath} result=${detail}`);
          }
        });
      }

      for (let i = 0; i < pendingFiles.length; i += INBOX_CONCURRENCY) {
        const batch = pendingFiles.slice(i, i + INBOX_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(file => this.processFile(path.join(this.inboxPath, file)))
        );
        results.forEach((result, index) => {
          const filePath = path.join(this.inboxPath, batch[index]);
          const detail = result.status === 'fulfilled'
            ? (result.value?.ok ? 'ok' : `error=${result.value?.reason ?? 'unknown'}`)
            : `error=${result.reason instanceof Error ? result.reason.message : String(result.reason)}`;
          if (detail !== 'ok') {
            console.log(`[InboxWatcher] file processed: path=${filePath} result=${detail}`);
          }
        });
      }

      for (let i = 0; i < riverFiles.length; i += INBOX_CONCURRENCY) {
        const batch = riverFiles.slice(i, i + INBOX_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(file => this.processRiverCapsule(path.join(this.inboxPath, file)))
        );
        results.forEach((result, index) => {
          const filePath = path.join(this.inboxPath, batch[index]);
          if (result.status === 'fulfilled') {
            if (result.value.ok) {
              console.log(`[InboxWatcher] river_capsule processed: path=${filePath} sessionKey=${result.value.sessionKey ?? 'unknown'} result=ok`);
            } else {
              console.log(`[InboxWatcher] river_capsule processed: path=${filePath} sessionKey=${result.value.sessionKey ?? 'unknown'} result=error=${result.value.reason ?? 'unknown'}`);
            }
          } else {
            console.log(`[InboxWatcher] river_capsule processed: path=${filePath} result=error=${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
          }
        });
      }

      // 清理無用佔位符
      allFiles.filter(f => f.startsWith("reflection_task")).forEach(f => {
        fs.unlinkSync(path.join(this.inboxPath, f));
      });

    } catch (err) {
      console.error("Inbox watcher error:", err);
    } finally {
      this.isProcessing = false;
      this.processingStartedAt = 0;
    }
  }

  async processRiverCapsule(filePath: string): Promise<{ ok: boolean; reason?: string; sessionKey?: string }> {
    const startedAt = Date.now();
    let sessionKey: string | undefined;
    try {
      const rawText = fs.readFileSync(filePath, "utf-8");
      console.log(`[inbox-watcher] Processing river_capsule: ${filePath.split('/').pop()}`);

      // 解析 CAPSULE_META comment，extract 所有結構化欄位
      // 格式：\x3C!-- CAPSULE_META:{...json...} --\x3E
      const capsuleMetaMatch = rawText.match(/\x3C!-- CAPSULE_META:([\s\S]*?) --\x3E/);
      let capsuleMeta: Record<string, any> = {};
      let textContent = rawText;

      if (capsuleMetaMatch) {
        try {
          capsuleMeta = JSON.parse(capsuleMetaMatch[1]);
          console.log(`[inbox-watcher] CAPSULE_META parsed: type=${capsuleMeta.capsuleType}, mode=${capsuleMeta.category}, skill=${capsuleMeta.skillName || '(none)'}`);
          // 去掉 CAPSULE_META comment 行，保留正文（可能是多行）
          textContent = rawText.replace(capsuleMetaMatch[0], '').trim();
        } catch (err) {
          sessionKey = path.basename(filePath);
          throw new Error(`CAPSULE_META parse failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      sessionKey = this.getRiverCapsuleSessionKey(capsuleMeta, filePath);

      // 萃取所有欄位（智慧相容大腦的 JSON 結構）
      const capsuleType: string = capsuleMeta.capsuleType || capsuleMeta.metadata?.type || 'working_memory';
      
      // 🎯 優先去多個可能的位置抓取 category，如果真的都沒有，預設給 'fact' 而不是 'relationship'
      const conversationMode = capsuleMeta.category || capsuleMeta.metadata?.category || 'fact';
      
      const skillName = capsuleMeta.skillName || capsuleMeta.metadata?.skillName;
      const triggerConditions: string[] = capsuleMeta.triggerConditions || capsuleMeta.metadata?.triggerConditions || [];
      const executionSteps: string[] = capsuleMeta.executionSteps || capsuleMeta.metadata?.executionSteps || [];
      const confidence: number = capsuleMeta.confidence || 0;
      const originalTurnCount = capsuleMeta.turnCount;
      const originalTokens = capsuleMeta.originalTokens;
      const parentId: string | undefined = capsuleMeta.parentId;
      const capsuleMetadata: Record<string, unknown> = {
        ...((capsuleMeta.metadata && typeof capsuleMeta.metadata === 'object') ? capsuleMeta.metadata : {}),
        ...capsuleMeta,
      };
      delete (capsuleMetadata as any).metadata;

      // 🎯 優先抓取大腦賦予的重要性，找不到再給 0.8 (滿血小紙條標準)，拒絕 0.3 垃圾權重
      const parsedImportance = capsuleMeta.importance ?? capsuleMeta.metadata?.importance ?? 0.8;
      const importance = capsuleType === 'skill_capsule' ? 0.9 : parsedImportance;

      console.log(`[inbox-watcher] Written to pending inbox: ${textContent.slice(0, 40)}... (parentId=${parentId || '(none)'})`);
      
      // 🩺 醫生修復區：補回遺失的 writeInbox 函數呼叫
      await InboxWatcher.writeInbox(this.inboxPath, {
        text: textContent,
        category: conversationMode,
        importance,
        capsuleType,
        skillName,
        triggerConditions,
        executionSteps,
        confidence,
        parentId,
        metadata: {
          ...capsuleMetadata,
          turnCount: originalTurnCount,
          originalTokens,
          skillName,
          triggerConditions,
          executionSteps,
          confidence,
          parentId,
        }
      });

      fs.unlinkSync(filePath);
      this.riverCapsuleFailureCounts.delete(sessionKey);
      await this.recordRiverCapsuleStat({
        sessionKey,
        outcome: "success",
        reason: null,
        durationMs: Date.now() - startedAt,
        meta: JSON.stringify({
          fileName: path.basename(filePath),
          capsuleType,
          category: conversationMode,
        }),
      });
      return { ok: true, sessionKey };
    } catch (err) { 
      const reason = this.classifyRiverCapsuleReason(err);
      sessionKey = sessionKey ?? path.basename(filePath);
      const nextFailureCount = (this.riverCapsuleFailureCounts.get(sessionKey) ?? 0) + 1;
      this.setRiverCapsuleFailureCount(sessionKey, nextFailureCount);

      if (nextFailureCount >= InboxWatcher.RIVER_CAPSULE_FAILURE_THRESHOLD) {
        try {
          await this.moveRiverCapsuleToError(filePath);
          console.error(`[InboxWatcher] river_capsule moved to error/: sessionKey=${sessionKey} failures=${nextFailureCount} reason=${reason}`);
          this.riverCapsuleFailureCounts.delete(sessionKey);
        } catch (moveErr) {
          console.error(`[InboxWatcher] Failed to move river_capsule to error/: ${path.basename(filePath)}`, moveErr);
        }
      }

      console.error("River capsule failed:", err);
      await this.recordRiverCapsuleStat({
        sessionKey,
        outcome: "failure",
        reason,
        durationMs: Date.now() - startedAt,
        meta: JSON.stringify({
          fileName: path.basename(filePath),
          consecutiveFailures: nextFailureCount,
        }),
      });
      return { ok: false, reason, sessionKey };
    }
  }

  private async processFile(filePath: string): Promise<{ ok: boolean; reason?: string }> {
    const fileName = path.basename(filePath);

    // 空的或格式無效的 → 直接砍掉，不進 error
    try {
      const stats = fs.statSync(filePath);
      if (stats.size === 0) {
        fs.unlinkSync(filePath);
        return { ok: true, reason: 'deleted-empty' };
      }
      const item = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (!item.text || !item.category) {
        fs.unlinkSync(filePath);
        return { ok: true, reason: 'deleted-invalid' };
      }
    } catch {
      // JSON parse 失敗或 stat 失敗 → 進 error
    }

    // 改為 .processing 檔名，隔離搶食 & 避免重試時重複處理
    const procPath = filePath.replace(/(\.json)$/, '.processing');
    try {
      fs.renameSync(filePath, procPath);
    } catch (renameErr) {
      // 已被其他 processFile 實例撿走，直接略過
      return { ok: true, reason: 'already-picked' };
    }

    try {
      // ════════════════════════════════════════════════════════
      // 重試區：整條 pipeline 包進 withRetry，指數退避
      // ════════════════════════════════════════════════════════
      await withRetry(
        () => this._processMemoryEntry(procPath),
        {
          maxAttempts: 3,
          baseDelayMs: 50,
          maxDelayMs: 2000,
          retryableErrors: isRetryableError,
          label: `memory pipeline for ${fileName}`,
        }
      );

      // 成功：砍掉 processing 檔
      try { fs.unlinkSync(procPath); } catch { /* already gone */ }
      if (DEBUG) console.log(`\x1b[32m[MemoryRiver] Item processed successfully: ${fileName}\x1b[0m`);
      return { ok: true };

    } catch (err) {
      // 所有重試耗盡 → 進 error/，不再卡死系統
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`Processing failed for ${fileName} after all retries:`, errMsg);
      const errorDir = path.join(path.dirname(procPath), "error");
      if (!fs.existsSync(errorDir)) fs.mkdirSync(errorDir, { recursive: true });
      const errorFileName = path.basename(procPath).replace('.processing', '.json');
      try {
        fs.renameSync(procPath, path.join(errorDir, errorFileName));
      } catch (moveErr) {
        console.error(`[InboxWatcher] Failed to move failed file to error/: ${fileName}`, moveErr);
      }
      this.recordFatalError(fileName, errMsg);
      return { ok: false, reason: errMsg };
    }
  }

  /**
   * _processMemoryEntry — 濃縮膠囊寫入記憶庫的核心 pipeline
   * 不處理檔案狀態（由 processFile 統一管理 rename/delete）
   */
  private async _processMemoryEntry(procPath: string): Promise<void> {
    const fileName = path.basename(procPath);
    const item = JSON.parse(fs.readFileSync(procPath, "utf-8"));
    let importanceVal = item.importance ?? 1.0;

    // ── 自然語言膠囊生成 ────────────────────────────────────────
    const hasCapsuleMeta = item.text.includes('[CAPSULE_META]') || item.category === 'skill';
    let capsuleSkillName: string | undefined;
    let capsuleTriggerConditions: string[] = [];
    let capsuleExecutionSteps: string[] = [];
    let capsuleConfidence = 100;
    const capsuleType = item.capsuleType ?? 'working_memory';

    // ── Structured Slot 抽取（Phase 1）────────────────────────
    // confidence >= 0.8 → 建立 Slot；0.5–0.8 → 待審核池；< 0.5 → 純 free-text
    let slotData: { slotKey: string; slotValue: number | string | boolean; confidence: number; extractionDomain: "technical" | "identity" | "preference" | "free_text"; isStructured: boolean } | null = null;
    try {
      slotData = await this.extractSlot(item.text, item.category);
      if (slotData?.isStructured) {
        console.log(`[inbox-watcher] Slot extracted: key=${slotData.slotKey} value=${slotData.slotValue} confidence=${slotData.confidence}`);
      }
    } catch (slotErr) {
      console.warn('[inbox-watcher] Slot extraction failed; falling back to free text:', slotErr);
    }

    if (hasCapsuleMeta) {
      const capsuleMetaMatch = item.text.match(/\[CAPSULE_META\]\s*\{([^}]+)\}/);
      if (capsuleMetaMatch) {
        try {
          const parsed = JSON.parse('{' + capsuleMetaMatch[1] + '}');
          capsuleSkillName = parsed.skillName;
          capsuleTriggerConditions = parsed.triggerConditions ?? [];
          capsuleExecutionSteps = parsed.executionSteps ?? [];
          capsuleConfidence = parsed.confidence ?? 100;
        } catch { /* ignore */ }
      }
      if (!capsuleSkillName && item.text.length > 0) {
        const summary = item.text.replace(/\[CAPSULE_META\]\s*\{[^}]*\}/g, '').trim().slice(0, 80);
        capsuleSkillName = await this.extractSkillNameFromText(summary, item.text);
        capsuleTriggerConditions = this.extractTriggersFromText(item.text);
      }
      console.log(`[inbox-watcher] Natural-language capsule: name=${capsuleSkillName}`);
    }

    // ── 向量化（含空向量重試）───────────────────────────────
    let vector: number[] = [];
    const EMBED_RETRIES = 3;
    for (let attempt = 1; attempt <= EMBED_RETRIES; attempt++) {
      vector = await this.embedder.embed(item.text, 'store');
      if (vector && Array.isArray(vector) && vector.length > 0) break;
      if (attempt < EMBED_RETRIES) {
        console.warn(`[InboxWatcher] Empty vector; retrying embedding in 2s... (${attempt}/${EMBED_RETRIES})`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // 🛑 重試後仍然空向量 → 交給 processFile 保留並 dead-letter
    if (!vector || !Array.isArray(vector) || vector.length === 0) {
      throw new Error('empty_embedding');
    }

    // ── 重複檢查 ───────────────────────────────────────────────
    try {
      const similar = await this.store.hybridVectorSearch(item.text, 3);
      if (similar.length > 0) {
        const dist = similar[0].rawDistance;
        if (dist < 0.15) {
          console.log(`[InboxWatcher] Skipping duplicate memory dist=${dist.toFixed(3)}`);
          return; // 不刪檔，由 processFile 統一處理
        }
      }
    } catch (dupErr) {
      console.warn("[InboxWatcher] Duplicate check failed; continuing write:", dupErr);
    }

    // ── 因果關係判斷（可能 API 瞬斷）────────────────────────────
    const relation = await this.causalEngine.determineRelation(item.text, undefined, item.category);

    // ── Hook 生成 ──────────────────────────────────────────────
    let hooks: any[] = [];
    let entities: any[] = [];
    if (this.hooksEngine) {
      hooks = await this.hooksEngine.generateHooks(item.text, item.category);
      entities = await this.hooksEngine.generateEntities(item.text);
    }

    // 優先使用 metadata 裡明確指定的 health（例如 concentrator 大膠囊標記的 30）
    const metadataHealth = item.metadata?.health;
    const healthScore = typeof metadataHealth === 'number' ? metadataHealth : Math.round(importanceVal * 100);
    const metadataObj: Record<string, any> = {
      ...(item.metadata ?? {}),
      hooks, entities, importance: importanceVal,
      health: { healthScore, accessCount: 0, lastAccessedAt: Date.now() },
      ...(item.tool_result !== undefined ? { tool_result: item.tool_result } : {}),
    };
    if (hasCapsuleMeta && capsuleSkillName) {
      metadataObj.capsuleType = capsuleType;
      metadataObj.skillName = capsuleSkillName;
      metadataObj.triggerConditions = capsuleTriggerConditions;
      metadataObj.executionSteps = capsuleExecutionSteps;
      // 膠囊資訊已存在 metadataObj 中，隨主記憶一起寫入 memories table
      console.log(`[inbox-watcher] Skill capsule tagged: ${capsuleSkillName} (written with primary memory)`);
    }

    const abstractness = judgeAbstractness(item.text);

    if (abstractness.isAbstract) {
      importanceVal = 0.1;
      metadataObj.importance = importanceVal;
      metadataObj.abstractness = abstractness.abstractness;
      metadataObj.abstractRejected = true;
      metadataObj.abstractReasons = abstractness.reasons;

      console.log(
        `[InboxWatcher] Soft abstractness rejection: ${abstractness.reasons.join(',')} ` +
        `(score=${abstractness.abstractness.toFixed(2)}) "${item.text.slice(0, 50)}..."`
      );

      if (typeof (this.store as any).recordSubsystemEffectiveness === 'function') {
        void this.store.recordSubsystemEffectiveness({
          subsystem: 'inbox',
          event: 'abstract_rejected',
          entityId: '',
          outcome: 'soft_rejected',
          score: abstractness.abstractness,
          count: 1,
          metadata: {
            reasons: abstractness.reasons,
            ruleHits: abstractness.ruleHits,
            textPreview: item.text.slice(0, 80),
            category: item.category,
            originalImportance: item.importance ?? 1.0,
          },
        } as any).catch((err: any) => {
          console.warn('[PR-E9A] abstract_rejected event failed:', err?.message);
        });
      }
    } else {
      metadataObj.abstractness = abstractness.abstractness;
      metadataObj.abstractRejected = false;
    }

    const hooksText = hooks?.length > 0 ? hooks.map((h: any) => '#' + h.keyword).join(' ') : "";
    const finalStoreText = hooksText ? `${item.text} [${hooksText}]` : item.text;

    // ── 寫入記憶庫（UPDATE path）───────────────────────────────
    let storedEntryId = '';

    // Slot routing：低 confidence（< 0.5）不走 slot 邏輯
    const isSlotEligible = slotData?.isStructured === true && (slotData.confidence ?? 0) >= 0.5;

    if (relation.action === "UPDATE" && relation.parentId) {
      // 加寫鎖：防止兩筆記憶同時 UPDATE 同一個 parentId 造成 race condition
      // Slot supersedes 鏈：若新 entry 有 slotKey → 查找並標記同 key 的舊 active 記錄
      let supersedesIds: string[] = [];
      if (isSlotEligible && slotData?.slotKey) {
        try {
          const superseded = await this.checkSupersedes(slotData.slotKey, '');
          supersedesIds = superseded.filter(id => id !== relation.parentId);
        } catch (err) {
          console.warn('[inbox-watcher] checkSupersedes failed:', err);
        }
      }

      await this.withParentLock(relation.parentId, async () => {
        const stored = await this.store.store({
          text: finalStoreText, vector, importance: importanceVal,
          category: item.category as MemoryCategory,
          metadata: JSON.stringify(metadataObj), parentId: relation.parentId,
          creationAuditSource: 'inbox-watcher.new',
          ...(isSlotEligible && slotData ? {
            slotKey: slotData.slotKey,
            slotValue: slotData.slotValue,
            extractionDomain: slotData.extractionDomain,
            confidence: slotData.confidence,
            ...(supersedesIds.length > 0 ? { supersedes: supersedesIds } : {}),
          } : {}),
        } as any);
        storedEntryId = stored.id;

        const oldMemory = await this.store.getById(relation.parentId!, true);
        if (oldMemory) {
          await this.statusManager.changeStatus({
            memoryId: relation.parentId!,
            toStatus: 'deprecated',
            reason: 'causal_update',
            source: 'inbox-watcher.update',
          });

          if ((oldMemory as any).slotKey) {
            console.log(`[inbox-watcher] UPDATE superseding old slot: ${(oldMemory as any).slotKey}`);
          }
        }
      });
    } else {
      // Slot supersedes 鏈：若新 entry 有 slotKey → 查找並標記同 key 的舊 active 記錄
      let supersedesIds: string[] = [];
      if (isSlotEligible && slotData?.slotKey) {
        try {
          supersedesIds = await this.checkSupersedes(slotData.slotKey, '');
          if (supersedesIds.length > 0) {
            console.log(`[inbox-watcher] Slot supersedes: ${slotData.slotKey} supersedes ${supersedesIds.length} previous versions`);
          }
        } catch (err) {
          console.warn('[inbox-watcher] checkSupersedes failed:', err);
        }
      }

      const stored = await this.store.store({
        text: finalStoreText, vector, importance: importanceVal,
        category: item.category as MemoryCategory,
        parentId: relation.parentId, metadata: JSON.stringify(metadataObj),
        creationAuditSource: 'inbox-watcher.new',
        ...(isSlotEligible && slotData ? {
          slotKey: slotData.slotKey,
          slotValue: slotData.slotValue,
          extractionDomain: slotData.extractionDomain,
          confidence: slotData.confidence,
          ...(supersedesIds.length > 0 ? { supersedes: supersedesIds } : {}),
        } : {}),
      } as any);
      storedEntryId = stored.id;

      // 將舊版本標記為 deprecated（新記憶成功寫入後才執行）
      for (const oldId of supersedesIds) {
        try {
          await this.statusManager.changeStatus({
            memoryId: oldId,
            toStatus: 'deprecated',
            reason: 'slot_supersedes',
            source: 'inbox-watcher.slot',
            supersededBy: '',
          });
        } catch { /* ignore */ }
      }

    }
    // ── 知識圖譜寫入（三元組，non-critical）───────────────────
    if (this.graphStore && entities.length > 0) {
      try {
        await this.graphStore.addTriples(entities, storedEntryId);
        console.log(`[inbox-watcher] Graph write: ${entities.length} triples (memoryId=${storedEntryId.slice(0, 8)})`);
      } catch (err) {
        console.warn('[inbox-watcher] Graph write failed (non-fatal):', err);
      }
    }

    // ── 衝突偵測（non-critical，失敗不重試）────────────────────
    if (this.conflictDetector) {
      try {
        const conflict = await this.conflictDetector.detectAndResolve(
          storedEntryId, item.text, item.category
        );
        if (conflict.hasConflict) {
          console.log(`[InboxWatcher] Conflict resolved: ${conflict.resolution}`);
        }
      } catch (err) {
        console.warn('[InboxWatcher] Conflict detection failed (non-fatal):', err);
      }
    }

  }

  static async writeInbox(inboxPath: string, item: {
    text: string;
    category: string;
    importance?: number;
    parentId?: string;
    capsuleType?: string;
    skillName?: string;
    triggerConditions?: string[];
    executionSteps?: string[];
    confidence?: number;
    metadata?: Record<string, unknown>;
    tool_result?: Record<string, unknown> | null;
  }): Promise<string> {
    if (!fs.existsSync(inboxPath)) fs.mkdirSync(inboxPath, { recursive: true });
    const filename = `pending_${Date.now()}_${Math.random().toString(36).slice(2, 5)}.json`;
    const filePath = path.join(inboxPath, filename);
    const tempPath = `${filePath}.tmp`;
    await fs.promises.writeFile(tempPath, JSON.stringify(item, null, 2));
    await fs.promises.rename(tempPath, filePath);
    return filename;
  }

  // ========================================================================
  // 🌟 技能發現系統
  // ========================================================================

  /**
   * 從記憶文字萃取技能名稱（簡單關鍵詞法，fallback）
   */
  private async extractSkillNameFromText(summary: string, fullText: string): Promise<string> {
    // 嘗試用 LLM 萃取
    try {
      const prompt = `從以下文字萃取技能名稱（最多15字，纯中文）:\n${summary}`;
      const name = (await this.llm.generate(prompt, {
        purpose: 'skill-name-extraction',
        maxTokens: 20,
      })).trim();
      if (name) return name.slice(0, 15);
    } catch (err) {
      console.warn('[SkillDiscovery] extractSkillNameFromText fetch failed (timeout or network error):', (err as Error).message);
      /* fall through to fallback */
    }

    // Fallback: 取第一個語素詞
    const words = summary.replace(/[^\w\u4e00-\u9fa5]/g, ' ').split(/\s+/).filter(Boolean);
    return (words[0] || '未命名技能').slice(0, 15);
  }

  /**
   * 從記憶文字抽取觸發關鍵詞（簡單枚舉法）
   */
  private extractTriggersFromText(text: string): string[] {
    // 去除 CAPSULE_META 區塊
    const clean = text.replace(/\[CAPSULE_META\]\s*\{[^}]*\}/g, '');
    // 簡單關鍵詞抽取：技術術語、常見命令等
    const keywords: string[] = [];
    const techPatterns = [
      /git\s+\w+/gi, /docker\s+\w*/gi, /npm\s+\w+/gi, /yarn\s+\w+/gi,
      /curl\s+[^ ]+/gi, /ssh\s+[^ ]+/gi, /grep\s+[^ ]+/gi,
      /[A-Z][a-z]+(?:\.[a-z]+){1,3}/g,  // 函式名如 OpenClaw.handle
      /\b\w+@\w+\.\w+\b/g,              // email
      /\x60[^\x60]+\x60/g,              // code backtick (改用 hex \x60 防 UI 崩潰)
    ];
    for (const pattern of techPatterns) {
      const matches = clean.match(pattern);
      if (matches) {
        for (const m of matches) {
          const kw = m.replace(/[\x60]/g, '').trim();
          if (kw && kw.length > 2 && !keywords.includes(kw)) {
            keywords.push(kw.slice(0, 30));
          }
        }
      }
    }
    return [...new Set(keywords)].slice(0, 10);
  }

  // ========================================================================
  // 🎯 Structured Slot 系統（Phase 1）
  // ========================================================================

  /**
   * extractSlot — LLM 結構化抽取
   * 輸入文字 → 判斷是否可結構化 → 輸出 slotKey / slotValue / confidence / extractionDomain
   *
   * confidence 等級：
   * >= 0.8：高可信，建立 Slot，自動 supersedes 檢查
   * 0.5–0.8：中可信，寫入待審核池（Night Consolidation 處理）
   * < 0.5：低可信，純 free-text，不建 Slot
   */
  private async extractSlot(
    text: string,
    category: string,
  ): Promise<{
    slotKey: string;
    slotValue: number | string | boolean;
    confidence: number;
    extractionDomain: "technical" | "identity" | "preference" | "free_text";
    isStructured: boolean;
  } | null> {
    const prompt = `你是結構化資訊抽取 AI。分析以下文字，判斷是否包含可結構化的關鍵事實參數。

文字：${text.slice(0, 800)}

 Slot Key 命名規範：{namespace}:{param_name}
 namespace 自由命名但同類事實要穩定（如 user:、memory:、project:）；extractionDomain 才是四選一：technical | identity | preference | free_text

 範例：
   - "drift threshold 調到 0.78" → slotKey="memory:drift_threshold", slotValue=0.78, domain="technical"
   - "老闆喜歡喝手沖咖啡" → slotKey="user:coffee_preference", slotValue="手沖咖啡", domain="preference"
   - "我是三重人" → slotKey="identity:location", slotValue="三重", domain="identity"
   - "今天天氣很好" → 無結構化資訊

 輸出嚴格 JSON：
 {
   "slotKey": "namespace:param_name 或空字串",
   "slotValue": "具體數值或字串或布林值，或 null",
   "confidence": 0.0-1.0（抽取可靠性）,
   "extractionDomain": "technical | identity | preference | free_text",
   "isStructured": true或false
 }

 ⚠️ 【防呆警告：欄位型別嚴格限制】⚠️
 1. "confidence" 欄位只能是 0.0 到 1.0 之間的「數字」！
 2. 絕對不准輸出陣列（如 []）或字串形式的數字！如果真的無法評估，請一律輸出 0。
 3. "slotValue" 如果為空請寫 null，嚴禁使用空陣列 []。

 若文字不包含可結構化的參數，輸出：{"slotKey":"","slotValue":null,"confidence":0,"extractionDomain":"free_text","isStructured":false}`;

    try {
      const raw = await this.llm.generate(prompt, {
        purpose: 'slot-extraction',
        maxTokens: 800,
      });
      if (!raw) return null;

      // 👇 括號天平演算法 (Brace Balancer)：完美抵禦廢話與 Markdown 👇
      let parsed: any = {};
      const cleanRaw = raw.replace(/\x60\x60\x60(?:json)?\n?/i, '').replace(/\x60\x60\x60\n?$/, '').trim();
      try {
        parsed = JSON.parse(cleanRaw);
      } catch (e) {
        let start = cleanRaw.indexOf('{');
        if (start !== -1) {
          let depth = 0, end = -1;
          for (let i = start; i < cleanRaw.length; i++) {
            if (cleanRaw[i] === '{') depth++;
            else if (cleanRaw[i] === '}') depth--;
            if (depth === 0) { end = i; break; }
          }
          if (end !== -1) {
            try { 
              parsed = JSON.parse(cleanRaw.substring(start, end + 1)); 
            } catch (err2) { 
              console.warn('[inbox-watcher] extractSlot still failed after bracket balancing');
              return null; 
            }
          } else {
            console.warn('[inbox-watcher] extractSlot LLM failed: complete JSON structure not found');
            return null;
          }
        } else {
          return null;
        }
      }

      // 過濾：confidence < 0.5 → 不視為結構化
      if ((parsed.confidence ?? 0) < 0.5) {
        parsed.isStructured = false;
      }

      return {
        slotKey: parsed.slotKey ?? '',
        slotValue: parsed.slotValue ?? null,
        confidence: parsed.confidence ?? 0,
        extractionDomain: parsed.extractionDomain ?? 'free_text',
        isStructured: parsed.isStructured === true,
      };
    } catch (err) {
      console.warn('[inbox-watcher] extractSlot LLM failed:', err);
      return null;
    }
  }

  /**
   * checkSupersedes — 查詢同 slotKey 的所有 active 舊版本
   * @returns 被取代的舊 entry id 清單
   */
  private async checkSupersedes(slotKey: string, _newId: string): Promise<string[]> {
    if (!slotKey) return [];
    try {
      const existing = await this.store.searchBySlotKey(slotKey);
      // 只回傳 status = 'active' 的舊版本（排除已 deprecated）
      return existing
        .filter(e => {
          try {
            const meta = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : (e.metadata || {});
            // status 為 'active' 或未設定時視為有效
            return meta.status === 'active' || meta.status == null;
          } catch {
            return true; // parse 失敗時保守視為有效
          }
        })
        .map(e => e.id);
    } catch (err) {
      console.warn('[inbox-watcher] searchBySlotKey failed:', err);
      return [];
    }
  }
}
