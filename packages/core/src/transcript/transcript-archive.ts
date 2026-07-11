/**
 * transcript-archive.ts
 *
 * Raw transcript 持久化層 — memory-river 濃縮失敗的底層保障。
 * Append-only JSONL，5MB 上限自動 rotation（留最多 10 個輪替檔）。
 *
 * 與 streaming-recovery/scripts/transcriptStore.ts 共用相同的 rotation 模式，
 * 但專注於「即將被蒸餾的原始訊息」的快照，不依賴任何外部 library。
 *
 * [Rehydrate System]
 * - 每筆 entry 自帶 entryId（單調遞增），寫入 .idx sidecar 做 O(1) seek
 * - transcript.counter 持久化 counter 狀態
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { ContextMessage } from '../types.js';

// ---------------------------------------------------------------
// 常數
// ---------------------------------------------------------------

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_ROTATE_FILES = 10;
const MAX_CACHE_SIZE_PER_SESSION = 5 * 1024 * 1024; // 5MB
const DEDUP_TAIL_LINES = 1000;

/**
 * 由 sessionIdentity 衍生的 archive 識別子。
 *
 * - canonicalKey：對外統一 key，用於 in-memory cache（Phase 4-2 起）
 * - sessionKey：用於磁碟檔名（Q6 漸進路徑，新檔仍走 sessionKey 命名）
 * - sessionId：4-4 disk read fallback 用（sessionKey-named 找不到時試 sessionId-named）
 *
 * 結構上等同 SessionIdentity 子集；caller 可以直接把 SessionIdentity 傳進來。
 */
export interface TranscriptIdentity {
  canonicalKey: string;
  sessionKey: string | null;
  sessionId?: string | null;
}

// ---------------------------------------------------------------
// 型別定義
// ---------------------------------------------------------------

export interface RawTranscriptEntry {
  entryId: number;
  user: string;
  assistant: string;
  timestamp: number;
}

interface PendingTranscriptEntry {
  user: string;
  assistant: string;
  timestamp: number;
}

export interface ArchiveSnapshotResult {
  ok: boolean;
  appendedEntries: number;
  dedupSkipped: number;
}

export function createTranscriptArchive(transcriptsDir: string) {
/**
 * canonicalKey → RawTranscriptEntry[] 的 LRU cache
 * Map 保持插入順序，天然 LRU
 */
const transcriptCache = new Map<string, RawTranscriptEntry[]>();
let inMemoryCounter = 0;
let counterLoaded = false;

/** 給 plugin start 清狀態用（Phase 4-7） */
function clearTranscriptCache(): void {
  transcriptCache.clear();
}

// ---------------------------------------------------------------
// 目錄工具
// ---------------------------------------------------------------

function getBasePath(): string {
  return transcriptsDir;
}

function ensureTranscriptDir(): string {
  const basePath = getBasePath();
  if (!fs.existsSync(basePath)) {
    fs.mkdirSync(basePath, { recursive: true, mode: 0o700 });
  }
  return basePath;
}

function getTranscriptPath(sessionKey: string): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(sessionKey) || sessionKey.includes('..')) {
    throw new Error('invalid sessionKey');
  }
  const dir = ensureTranscriptDir();
  const resolvedDir = path.resolve(dir);
  const transcriptPath = path.resolve(resolvedDir, `${sessionKey}.jsonl`);
  const dirPrefix = resolvedDir.endsWith(path.sep) ? resolvedDir : `${resolvedDir}${path.sep}`;
  if (!transcriptPath.startsWith(dirPrefix)) {
    throw new Error('invalid sessionKey');
  }
  return transcriptPath;
}

// ---------------------------------------------------------------
// Counter 持久化（Rehydrate System）
// ---------------------------------------------------------------

function getCounterPath(): string {
  return path.join(getBasePath(), 'transcript.counter');
}

interface CounterStore { counter: number }

function loadCounter(): void {
  if (counterLoaded) return;
  const counterPath = getCounterPath();
  try {
    if (fs.existsSync(counterPath)) {
      const raw = fs.readFileSync(counterPath, 'utf-8');
      const parsed = JSON.parse(raw) as CounterStore;
      inMemoryCounter = typeof parsed.counter === 'number' ? parsed.counter : 0;
    }
  } catch {
    inMemoryCounter = 0;
  }
  counterLoaded = true;
}

function saveCounter(): void {
  fs.writeFileSync(getCounterPath(), JSON.stringify({ counter: inMemoryCounter }), { encoding: 'utf-8', mode: 0o600 });
}

function nextEntryId(): number {
  loadCounter();
  return ++inMemoryCounter;
}

// ---------------------------------------------------------------
// .idx sidecar 管理（Rehydrate System）
// ---------------------------------------------------------------

interface IdxEntry { entryId: number; offset: number }
type IdxMap = Record<number, number>; // entryId → byte offset

function getIdxPath(jsonlPath: string): string {
  return jsonlPath + '.idx';
}

function loadIdx(jsonlPath: string): IdxMap {
  const idxPath = getIdxPath(jsonlPath);
  try {
    if (fs.existsSync(idxPath)) {
      const raw = fs.readFileSync(idxPath, 'utf-8');
      return JSON.parse(raw) as IdxMap;
    }
  } catch {}
  return {};
}

function appendIdx(jsonlPath: string, entryId: number, offset: number): void {
  const idxPath = getIdxPath(jsonlPath);
  const idx = loadIdx(jsonlPath);
  idx[entryId] = offset;
  try {
    fs.writeFileSync(idxPath, JSON.stringify(idx), { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    console.error('[transcript-archive] appendIdx failed:', err);
  }
}

function appendJsonlWithFsync(filePath: string, content: string): void {
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeFileSync(fd, content, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeIdxWithFsync(jsonlPath: string, idx: IdxMap): void {
  const idxPath = getIdxPath(jsonlPath);
  const fd = fs.openSync(idxPath, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(idx), 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------
// Rotation 邏輯（直接參考 transcriptStore.ts — 已驗證可用）
// ---------------------------------------------------------------

function rotateIfNeeded(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;

    const stats = fs.statSync(filePath);
    if (stats.size < MAX_FILE_SIZE_BYTES) return;

    const dir = path.dirname(filePath);
    const base = path.basename(filePath, '.jsonl');
    let maxIndex = 0;

    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (f.startsWith(`${base}.`) && f.endsWith('.jsonl')) {
        const idx = parseInt(f.replace(`${base}.`, '').replace('.jsonl', ''), 10);
        if (!isNaN(idx) && idx > maxIndex) maxIndex = idx;
      }
    }

    // 刪除最舊的輪替檔（保留 MAX_ROTATE_FILES 個）
    const oldestIndex = maxIndex + 1 - MAX_ROTATE_FILES;
    if (oldestIndex > 0) {
      const oldestPath = path.join(dir, `${base}.${oldestIndex}.jsonl`);
      if (fs.existsSync(oldestPath)) {
        fs.unlinkSync(oldestPath);
      }
      // 同時刪除對應的 .idx sidecar
      const oldestIdxPath = oldestPath + '.idx';
      if (fs.existsSync(oldestIdxPath)) {
        fs.unlinkSync(oldestIdxPath);
      }
    }

    // 將主檔 rotate 為 .1, .2, ...
    const nextIndex = maxIndex + 1;
    const rotatedPath = path.join(dir, `${base}.${nextIndex}.jsonl`);
    fs.renameSync(filePath, rotatedPath);

    // rotation 完成後，清除對應的 in-memory cache（避免孤島）。
    // Phase 4-2 起 cache key 為 canonicalKey；舊行為下檔名等同 sessionKey，
    // 大多數情境 canonicalKey === sessionKey，這裡仍以檔名為線索做 best-effort 清除。
    const baseKey = path.basename(filePath, '.jsonl');
    if (transcriptCache.has(baseKey)) {
      transcriptCache.delete(baseKey);
      console.log(`[transcript-archive] Cache cleared after rotation: ${baseKey}`);
    }

    // 同時 rotate .idx sidecar
    const idxPath = getIdxPath(filePath);
    if (fs.existsSync(idxPath)) {
      fs.renameSync(idxPath, getIdxPath(rotatedPath));
    }
  } catch (err) {
    console.error(`[transcript-archive] rotateIfNeeded failed:`, err);
  }
}

function getTranscriptPaths(filePath: string): string[] {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, '.jsonl');
  let rotated: Array<{ index: number; filePath: string }> = [];
  try {
    rotated = fs.readdirSync(dir)
      .filter((file) => file.startsWith(`${base}.`) && file.endsWith('.jsonl'))
      .map((file) => ({
        index: Number.parseInt(file.slice(base.length + 1, -'.jsonl'.length), 10),
        filePath: path.join(dir, file),
      }))
      .filter((file) => Number.isFinite(file.index))
      .sort((a, b) => b.index - a.index);
  } catch {}
  return [filePath, ...rotated.map((file) => file.filePath)];
}

// ---------------------------------------------------------------
// 內部工具：從 ContextMessage 提取可見文字
// ---------------------------------------------------------------

// 🛡️ 過濾 session initialization 訊息（這些是 OpenClaw inject 的系統訊息，不是真的 user 話）
const SESSION_INIT_PATTERNS = [
  'A new session was started via /new or /reset',
  'Run your Session Startup sequence',
];
function isSessionInitMessage(text: string): boolean {
  return SESSION_INIT_PATTERNS.some(p => text.includes(p));
}

function enforceCacheLimit(canonicalKey: string): void {
  const entries = transcriptCache.get(canonicalKey);
  if (!entries) return;

  const approxSize = new TextEncoder().encode(JSON.stringify(entries)).length;
  if (approxSize > MAX_CACHE_SIZE_PER_SESSION) {
    // 砍掉最舊的 20%
    const cutIndex = Math.floor(entries.length * 0.2);
    transcriptCache.set(canonicalKey, entries.slice(cutIndex));
  }
}

function normalizeDedupText(text: string): string {
  return text.trim().replace(/[\s\u3000]+/g, ' ');
}

function buildDedupKey(user: string, assistant: string, timestamp: number): string {
  return `${timestamp}\u001f${normalizeDedupText(user)}\u001f${normalizeDedupText(assistant)}`;
}

function hashDedupKey(key: string): string {
  return createHash('sha1').update(key).digest('hex');
}

function readTailLines(filePath: string, maxLines: number): string[] {
  if (!fs.existsSync(filePath) || maxLines <= 0) return [];

  const stat = fs.statSync(filePath);
  if (stat.size === 0) return [];

  const fd = fs.openSync(filePath, 'r');
  const chunkSize = 64 * 1024;
  let position = stat.size;
  let collected = '';
  let newlineCount = 0;

  try {
    while (position > 0 && newlineCount <= maxLines) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const buffer = Buffer.alloc(readSize);
      fs.readSync(fd, buffer, 0, readSize, position);
      collected = buffer.toString('utf-8') + collected;
      newlineCount = (collected.match(/\n/g) || []).length;
    }
  } finally {
    fs.closeSync(fd);
  }

  return collected.split('\n').filter((line) => line.trim()).slice(-maxLines);
}

function loadRecentDedupKeys(filePath: string, maxLines: number): Set<string> {
  const keys = new Set<string>();

  for (const line of readTailLines(filePath, maxLines)) {
    try {
      const entry = JSON.parse(line) as RawTranscriptEntry;
      if (typeof entry.timestamp !== 'number') continue;
      keys.add(buildDedupKey(entry.user || '', entry.assistant || '', entry.timestamp));
    } catch {
      // 忽略壞行；dedup 安全網不能因單行毀損阻斷 archive
    }
  }

  return keys;
}

/**
 * 從 ContextMessage.content 提取「乾淨的文字」。
 * - string content → 直接取
 * - array content  → 取 type='text' 的 text，去除 type='thinking'/'thinkingSignature' blocks
 * - tool calls / metadata / role labels → 全數移除
 */
function extractVisibleText(msg: ContextMessage): string {
  const raw = msg.content;
  if (typeof raw === 'string') return raw.trim();
  if (!Array.isArray(raw)) return '';

  const parts: string[] = [];
  for (const block of raw as Array<Record<string, unknown>>) {
    if (!block || typeof block !== 'object') continue;
    const t = (block.type as string) ?? '';
    if (t === 'thinking' || t === 'thinkingSignature') continue;
    if (t === 'text' && typeof block.text === 'string') {
      parts.push(block.text.trim());
    }
  }
  return parts.join('\n').trim();
}

// ---------------------------------------------------------------
// 核心 API
// ---------------------------------------------------------------

/**
 * 將即將被蒸餾的訊息陣列寫入 append-only raw transcript。
 *
 * 處理邏輯：
 * - 遍歷訊息，按 user→assistant 配對，只保留 content 文字
 * - 去除 role label、tool calls、thinking blocks、metadata
 * - 寫入 JSONL，並在達到 5MB 時自動 rotate（留最多 10 個輪替檔）
 * - 每筆記錄附加 entryId（單調遞增），寫入 .idx sidecar 做 O(1) seek
 *
 * Phase 4-2：disk path 仍由 sessionKey 衍生（與舊行為一致），
 * in-memory cache 改用 canonicalKey；若 sessionKey 缺席則跳過寫入
 * （與 maintain() 端的 sessionKey gate 行為一致）。
 *
 * @param identity  - 由 sessionIdentity 解析得到的 canonical/原始 key
 * @param messages  - 即將被蒸餾的 ContextMessage 陣列
 */
function archiveSnapshot(identity: TranscriptIdentity, messages: ContextMessage[]): ArchiveSnapshotResult {
  try {
    if (!identity.sessionKey) {
      console.warn(
        `[transcript-archive] archiveSnapshot skipped: sessionKey missing canonicalKey=${identity.canonicalKey}`
      );
      return { ok: false, appendedEntries: 0, dedupSkipped: 0 };
    }
    const filePath = getTranscriptPath(identity.sessionKey);
    const cacheKey = identity.canonicalKey;

    const pendingEntries: PendingTranscriptEntry[] = [];
    let pendingUser: string | null = null;
    let pendingTimestamp: number = Date.now();

    for (const msg of messages) {
      const text = extractVisibleText(msg);
      if (!text || isSessionInitMessage(text)) continue;

      if (msg.role === 'user') {
        pendingUser = text;
        pendingTimestamp = msg.timestamp ?? Date.now();
      } else if (msg.role === 'assistant' && pendingUser !== null) {
        pendingEntries.push({
          user: pendingUser,
          assistant: text,
          timestamp: pendingTimestamp,
        });
        pendingUser = null;
      }
    }

    // 如果最後是孤單的 user 訊息（沒有後續 assistant），仍然寫入一筆記錄
    if (pendingUser !== null) {
      pendingEntries.push({
        user: pendingUser,
        assistant: '',
        timestamp: pendingTimestamp,
      });
    }

    if (pendingEntries.length === 0) return { ok: true, appendedEntries: 0, dedupSkipped: 0 };

    // 先檢查是否需要 rotation，避免 offset 計算到舊檔
    rotateIfNeeded(filePath);

    const seenKeys = loadRecentDedupKeys(filePath, DEDUP_TAIL_LINES);
    const newEntries: RawTranscriptEntry[] = [];
    let dedupSkipped = 0;
    let firstSkippedHash: string | null = null;

    for (const entry of pendingEntries) {
      const key = buildDedupKey(entry.user, entry.assistant, entry.timestamp);
      if (seenKeys.has(key)) {
        dedupSkipped++;
        firstSkippedHash ||= hashDedupKey(key).slice(0, 8);
        continue;
      }

      seenKeys.add(key);
      newEntries.push({
        entryId: nextEntryId(),
        user: entry.user,
        assistant: entry.assistant,
        timestamp: entry.timestamp,
      });
    }

    if (dedupSkipped > 0) {
      console.log(`[archive] dedup skipped ${dedupSkipped} duplicate pairs (canonical=${identity.canonicalKey})`);
      if (firstSkippedHash) {
        console.log(`[archive] first skipped key hash=${firstSkippedHash} (canonical=${identity.canonicalKey})`);
      }
    }

    if (newEntries.length === 0) return { ok: true, appendedEntries: 0, dedupSkipped };

    // 寫入磁碟（append），紀錄每筆記錄的 byte offset
    let offset: number;
    try {
      const stats = fs.statSync(filePath);
      offset = stats.size;
    } catch {
      offset = 0;
    }

    const idx = loadIdx(filePath);
    const lines: string[] = [];
    for (const entry of newEntries) {
      const line = JSON.stringify(entry);
      lines.push(line);
      idx[entry.entryId] = offset;
      offset += Buffer.byteLength(line, 'utf-8') + 1; // +1 for \n
    }
    const content = lines.join('\n') + '\n';
    saveCounter();
    appendJsonlWithFsync(filePath, content);
    writeIdxWithFsync(filePath, idx);

    // 更新 cache（write-through）— Phase 4-2 起以 canonicalKey 為 key
    const existing = transcriptCache.get(cacheKey) || [];
    transcriptCache.set(cacheKey, [...existing, ...newEntries]);

    // LRU 上限檢查
    enforceCacheLimit(cacheKey);
    return { ok: true, appendedEntries: newEntries.length, dedupSkipped };
  } catch (err) {
    console.error(`[transcript-archive] archiveSnapshot failed:`, err);
    // 磁碟寫入失敗時不更新 cache（保持一致性）
    return { ok: false, appendedEntries: 0, dedupSkipped: 0 };
  }
}

/**
 * 查詢 raw transcript，支援時間範圍過濾。
 *
 * Phase 4-2：cache lookup 改走 canonicalKey；磁碟讀取仍用 sessionKey。
 * Phase 4-4 會加上 sessionId fallback path。
 *
 * @param identity   - 由 sessionIdentity 解析得到的 key 集合
 * @param since      - 只取 timestamp >= since 的項目（可選）
 * @param limit      - 最多取 limit 筆記錄（可選，預設全部）
 * @returns RawTranscriptEntry[] - 時間正序陣列
 */
function getRawTranscript(
  identity: TranscriptIdentity,
  since?: number,
  limit?: number
): RawTranscriptEntry[] {
  const cacheKey = identity.canonicalKey;
  try {
    // 優先查 cache（canonicalKey）
    if (transcriptCache.has(cacheKey)) {
      let entries = transcriptCache.get(cacheKey)!;
      const oldestTimestamp = Math.min(...entries.map((entry) => entry.timestamp));
      if (since === undefined || (entries.length > 0 && since >= oldestTimestamp)) {
        if (since !== undefined) entries = entries.filter(e => e.timestamp >= since);
        return entries.slice(limit ? -limit : undefined);
      }
    }

    // cache miss → 讀磁碟。Phase 4-4 漸進路徑：
    //   1) 優先 sessionKey 對應檔（與寫入端一致）
    //   2) sessionKey 不存在時試 sessionId 對應檔（過渡期相容）
    //   兩者都有：以 sessionKey 為準。sessionId fallback 命中時記一條 warning。
    const sessionKey = identity.sessionKey;
    const sessionId = identity.sessionId;
    let filePath: string | null = null;
    if (sessionKey) {
      const skPath = getTranscriptPath(sessionKey);
      if (getTranscriptPaths(skPath).some((transcriptPath) => fs.existsSync(transcriptPath))) {
        filePath = skPath;
      }
    }
    if (!filePath && sessionId) {
      const sidPath = getTranscriptPath(sessionId);
      if (getTranscriptPaths(sidPath).some((transcriptPath) => fs.existsSync(transcriptPath))) {
        filePath = sidPath;
        console.warn(
          `[transcript-archive] read fallback to sessionId-named file: canonicalKey=${cacheKey} sessionId=${sessionId}`
        );
      }
    }
    if (!filePath) {
      if (!sessionKey && !sessionId) {
        console.warn(
          `[transcript-archive] getRawTranscript: sessionKey/sessionId both missing canonicalKey=${cacheKey}; cannot search disk`
        );
      }
      return [];
    }

    const entries: RawTranscriptEntry[] = [];
    for (const transcriptPath of getTranscriptPaths(filePath)) {
      try {
        const raw = fs.readFileSync(transcriptPath, 'utf-8');
        for (const line of raw.split('\n').filter(l => l.trim())) {
          try {
            entries.push(JSON.parse(line) as RawTranscriptEntry);
          } catch {
            // Legacy 格式（無 entryId）→ 補一個假的 entryId = -1
            console.warn(`[transcript-archive] legacy_transcript_fallback: canonicalKey=${cacheKey}, no entryId`);
            const legacy = JSON.parse(line) as { user: string; assistant: string; timestamp: number };
            entries.push({ entryId: -1, ...legacy } as RawTranscriptEntry);
          }
        }
      } catch {
        continue;
      }
    }
    entries.sort((a, b) => a.timestamp - b.timestamp);

    // 寫入 cache（canonicalKey）
    transcriptCache.set(cacheKey, entries);
    enforceCacheLimit(cacheKey);

    // 時間過濾
    let result = since !== undefined ? entries.filter(e => e.timestamp >= since) : entries;
    return result.slice(limit ? -limit : undefined);
  } catch (err) {
    console.error(`[transcript-archive] getRawTranscript failed:`, err);
    return [];
  }
}

return {
  archiveSnapshot,
  clearTranscriptCache,
  getRawTranscript,
  getTranscriptPath,
};
}

export type TranscriptArchive = ReturnType<typeof createTranscriptArchive>;
