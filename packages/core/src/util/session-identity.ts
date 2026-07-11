/**
 * session-identity.ts
 *
 * 統一的 session 身分解析模組（P0-2）。
 *
 * 替代既有 resolveTrackingSessionKey / extractSessionIdentity 雙鏈，把
 * 「從 payload 抽 session 身分」與「決定對外 canonicalKey」收斂到同一條路徑。
 *
 * - 對外只暴露 canonicalKey；所有 in-memory state map / Set 都應該以它為 key。
 * - canonicalKey 優先序：sessionKey -> session.key -> session.id -> sessionId
 *   （與磁碟序列化最重的 transcript archive 既有 sessionKey 命名一致）。
 * - 原始 sessionKey / sessionId 仍保留在 record 裡，給磁碟讀寫拼檔名用。
 *
 * 純函式（除 console / fs 觀測點），不可在這裡碰任何 state map。
 */

import * as fs from 'fs';
import * as path from 'node:path';

export type SessionIdentitySource =
  | 'sessionKey'
  | 'session.key'
  | 'session.id'
  | 'sessionId'
  | 'guess'
  | 'fallback'
  | 'global';

export interface SessionIdentity {
  /** 對外統一識別子，所有 state map key 都用這個 */
  canonicalKey: string;
  /** 原始 sessionKey（如果 payload 有） */
  sessionKey: string | null;
  /** 原始 sessionId（如果 payload 有） */
  sessionId: string | null;
  /** canonicalKey 是從哪個欄位拿到的 */
  source: SessionIdentitySource;
  /** 是否走到 'global' fallback（payload 完全沒有 session 身分） */
  isFallback: boolean;
}

export const GLOBAL_FALLBACK_KEY = 'global';

/* ──────────────────────────────────────────────────────────────────────
 * Fallback warning 去重（LRU 1000 unique payload signature）
 *
 * Phase 4-5：log 走 dedupe 避免 spam；observer 每次 fallback 都觸發，
 * 上層可拿來寫 concentrator_stats 等持久觀測。
 * ──────────────────────────────────────────────────────────────────── */

const FALLBACK_LOG_MAX = 1000;
const fallbackSignatureSeen = new Set<string>();

export type FallbackObserver = (info: { signature: string; ctx: string }) => void;
let fallbackObserver: FallbackObserver | null = null;

/** 註冊全域 fallback observer；傳 null 取消。 */
export function setFallbackObserver(fn: FallbackObserver | null): void {
  fallbackObserver = fn;
}

function payloadSignature(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return `<${typeof payload}>`;
  const keys = Object.keys(payload as Record<string, unknown>).sort();
  return keys.length === 0 ? '<empty-object>' : keys.join(',');
}

function notifyFallback(payload: unknown, ctx: string): void {
  const sig = payloadSignature(payload);

  // observer：每次 fallback 都觸發（上層拿來寫 stats）
  if (fallbackObserver) {
    try {
      fallbackObserver({ signature: sig, ctx });
    } catch (err) {
      // observer 錯誤不能影響本流程
      console.warn('[sessionIdentity] fallbackObserver threw:', err);
    }
  }

  // log：用 LRU dedupe 避免 spam，只 log payload keys 不 log value
  if (fallbackSignatureSeen.has(sig)) return;
  if (fallbackSignatureSeen.size >= FALLBACK_LOG_MAX) {
    const oldest = fallbackSignatureSeen.values().next().value;
    if (oldest !== undefined) fallbackSignatureSeen.delete(oldest);
  }
  fallbackSignatureSeen.add(sig);
  console.warn(
    `[sessionIdentity] global fallback ctx=${ctx} payloadKeys=[${sig}]`
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * 主要 API
 * ──────────────────────────────────────────────────────────────────── */

interface RawSessionFields {
  sessionKey: string | null;
  sessionDotKey: string | null;
  sessionDotId: string | null;
  sessionId: string | null;
}

function pickString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function extractRawFields(payload: unknown): RawSessionFields {
  if (!payload || typeof payload !== 'object') {
    return { sessionKey: null, sessionDotKey: null, sessionDotId: null, sessionId: null };
  }
  const obj = payload as Record<string, unknown>;
  const session = (obj.session && typeof obj.session === 'object')
    ? (obj.session as Record<string, unknown>)
    : null;
  return {
    sessionKey: pickString(obj.sessionKey),
    sessionDotKey: session ? pickString(session.key) : null,
    sessionDotId: session ? pickString(session.id) : null,
    sessionId: pickString(obj.sessionId),
  };
}

function chooseCanonical(
  raw: RawSessionFields,
): { canonicalKey: string; source: SessionIdentitySource; isFallback: boolean } {
  if (raw.sessionKey)    return { canonicalKey: raw.sessionKey,    source: 'sessionKey',  isFallback: false };
  if (raw.sessionDotKey) return { canonicalKey: raw.sessionDotKey, source: 'session.key', isFallback: false };
  if (raw.sessionDotId)  return { canonicalKey: raw.sessionDotId,  source: 'session.id',  isFallback: false };
  if (raw.sessionId)     return { canonicalKey: raw.sessionId,     source: 'sessionId',   isFallback: false };
  return { canonicalKey: GLOBAL_FALLBACK_KEY, source: 'global', isFallback: true };
}

/**
 * 從單一 payload 解析 sessionIdentity。
 * 同時拿 sessionKey 與 sessionId 兩個原始欄位（如果存在），以便磁碟讀寫拼檔名。
 */
export function resolveSessionIdentity(payload: unknown): SessionIdentity {
  const raw = extractRawFields(payload);
  const { canonicalKey, source, isFallback } = chooseCanonical(raw);

  if (isFallback) {
    notifyFallback(payload, 'resolveSessionIdentity');
  }

  return {
    canonicalKey,
    sessionKey: raw.sessionKey ?? raw.sessionDotKey,
    sessionId: raw.sessionId ?? raw.sessionDotId,
    source,
    isFallback,
  };
}

/**
 * 從 variadic args 解析（assemble、register hook 場景）。
 * 走訪每個 arg，取第一個能解出非 fallback identity 的；若全部 fallback，回傳 global。
 *
 * 與 resolveTrackingSessionKey 的 variadic 行為等價，但同步把 sessionKey/sessionId 一起帶出。
 */
export function resolveSessionIdentityFromArgs(...args: unknown[]): SessionIdentity {
  // 第一輪：找第一個能解出 canonicalKey 的 arg；同時把所有 args 的 sessionKey/sessionId 合併
  let chosen: SessionIdentity | null = null;
  let mergedSessionKey: string | null = null;
  let mergedSessionId: string | null = null;

  for (const arg of args) {
    const raw = extractRawFields(arg);
    const skHere = raw.sessionKey ?? raw.sessionDotKey;
    const sidHere = raw.sessionId ?? raw.sessionDotId;
    if (!mergedSessionKey && skHere) mergedSessionKey = skHere;
    if (!mergedSessionId && sidHere) mergedSessionId = sidHere;

    if (chosen) continue;
    const { canonicalKey, source, isFallback } = chooseCanonical(raw);
    if (!isFallback) {
      chosen = {
        canonicalKey,
        sessionKey: skHere,
        sessionId: sidHere,
        source,
        isFallback: false,
      };
    }
  }

  if (chosen) {
    // merged 結果可能比單一 arg 多帶一個原始欄位，補進 record 方便下游磁碟讀寫
    if (!chosen.sessionKey && mergedSessionKey) chosen.sessionKey = mergedSessionKey;
    if (!chosen.sessionId && mergedSessionId) chosen.sessionId = mergedSessionId;
    return chosen;
  }

  // 全 fallback → 用第一個 arg 的 signature 做 dedupe，避免每個 arg 都 spam
  notifyFallback(args[0] ?? null, 'resolveSessionIdentityFromArgs');

  return {
    canonicalKey: GLOBAL_FALLBACK_KEY,
    sessionKey: mergedSessionKey,
    sessionId: mergedSessionId,
    source: 'global',
    isFallback: true,
  };
}

/**
 * 已知 canonicalKey 反查 SessionIdentity。
 * 給 cleanup / scheduler / inbox-watcher 等沒有原始 payload 的場景用。
 *
 * source 標 'fallback' 是為了與 'global' 區分：'global' 表示 payload 不帶任何 session
 * 身分，'fallback' 表示我們已經有 canonicalKey 但沒走過 payload resolve 流程。
 */
export function makeSessionIdentity(
  canonicalKey: string,
  hints?: { sessionKey?: string; sessionId?: string },
): SessionIdentity {
  return {
    canonicalKey,
    sessionKey: pickString(hints?.sessionKey),
    sessionId: pickString(hints?.sessionId),
    source: 'fallback',
    isFallback: canonicalKey === GLOBAL_FALLBACK_KEY,
  };
}

/* ──────────────────────────────────────────────────────────────────────
 * guess-based fallback（Discord DM / memory_rehydrate without sessionKey）
 *
 * 這條路完全不看 live payload，只看 transcripts 目錄中 mtime 最新的檔名。
 * 保留 mtime 邏輯（與既有 guessCurrentSessionKey 同），但每次呼叫 log 一條 info，
 * 不再藏在 utility 角落。
 * ──────────────────────────────────────────────────────────────────── */

/**
 * 從磁碟猜當前 session（mtime 最新的 transcript .jsonl）。
 * 找不到回 null。每次呼叫 log 一條 info，方便觀測有多少流量走這條 fallback。
 */
export function resolveSessionIdentityByGuess(
  transcriptsDir: string,
  ctx: string = 'unknown',
): SessionIdentity | null {
  try {
    const dir = transcriptsDir;
    if (!fs.existsSync(dir)) {
      console.info(`[sessionIdentity] guess miss (no transcript dir) ctx=${ctx}`);
      return null;
    }
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl') && !f.endsWith('.idx'))
      .map((f) => ({
        name: f.replace('.jsonl', ''),
        mtime: fs.statSync(path.join(dir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    const top = files[0]?.name;
    if (!top) {
      console.info(`[sessionIdentity] guess miss (no transcripts) ctx=${ctx}`);
      return null;
    }
    console.info(`[sessionIdentity] guess hit ctx=${ctx} canonicalKey=${top}`);
    return {
      canonicalKey: top,
      sessionKey: top, // transcript 檔名等同 sessionKey
      sessionId: null,
      source: 'guess',
      isFallback: false,
    };
  } catch (err) {
    console.warn(`[sessionIdentity] guess failed ctx=${ctx}:`, err);
    return null;
  }
}

/* ──────────────────────────────────────────────────────────────────────
 * Test seam（可選，目前 codebase 無 test infra，僅留 hook）
 * ──────────────────────────────────────────────────────────────────── */

/** 重置 fallback dedupe 狀態，僅供測試使用。 */
export function __resetFallbackDedupeForTests(): void {
  fallbackSignatureSeen.clear();
}
