/**
 * rehydrate.ts — Memory Rehydrate System
 *
 * 根據濃縮時記錄的 sourceEntryIds，從 transcript JSONL 撈回原始對話。
 * 使用 .idx sidecar 做 O(1) byte offset seek，避免全檔 scan。
 *
 * Fallback：當 entryId 查不到（舊檔或 .idx 損壞），走 line-scan 並打日誌。
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------
// 型別
// ---------------------------------------------------------------

export interface TranscriptEntry {
  entryId: number;
  sessionId: string;
  user: string;
  assistant: string;
  timestamp: number; // Unix ms
}

// ---------------------------------------------------------------
// .idx sidecar 管理
// ---------------------------------------------------------------

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

function getTranscriptPaths(jsonlPath: string): string[] {
  const dir = path.dirname(jsonlPath);
  const base = path.basename(jsonlPath, '.jsonl');
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
  return [jsonlPath, ...rotated.map((file) => file.filePath)];
}

// ---------------------------------------------------------------
// 核心工具：從 byte offset 讀取一行 JSONL
// ---------------------------------------------------------------

function readLineAt(fd: number, offset: number): string | null {
  const MAX_LINE_LENGTH = 100_000; // 防止極端行的無限迴圈
  const buf = Buffer.alloc(MAX_LINE_LENGTH);
  const bytesRead = fs.readSync(fd, buf, 0, MAX_LINE_LENGTH, offset);
  if (bytesRead === 0) return null;

  const content = buf.toString('utf-8', 0, bytesRead);
  const eol = content.indexOf('\n');
  if (eol === -1) return content.trim() || null;
  return content.substring(0, eol).trim() || null;
}

// ---------------------------------------------------------------
// rehydrate：根據 entryIds 撈原文（O(1) seek via .idx）
// ---------------------------------------------------------------

/**
 * 根據 entry IDs 撈原文，前後各擴 bleed 筆記錄。
 * 使用 .idx sidecar 做 byte offset seek（O(1) 查詢）。
 *
 * @param jsonlPath  transcript JSONL 檔案路徑
 * @param entryIds    要撈的 entry ID 陣列
 * @param bleed      往前後各擴多少筆記錄（預設 2）
 * @returns TranscriptEntry[] — 不論找到多少筆都回傳（可為空陣列）
 */
export async function rehydrate(
  jsonlPath: string,
  entryIds: number[],
  bleed: number = 2
): Promise<TranscriptEntry[]> {
  if (!entryIds || entryIds.length === 0) return [];
  const transcriptPaths = getTranscriptPaths(jsonlPath);
  if (!transcriptPaths.some((transcriptPath) => fs.existsSync(transcriptPath))) return [];

  const found = new Map<number, TranscriptEntry>(); // entryId → entry
  const foundPaths = new Map<number, string>();
  const indexes = new Map<string, IdxMap>();

  // ── O(1) seek via .idx ──────────────────────────────
  for (const transcriptPath of transcriptPaths) {
    const idx = loadIdx(transcriptPath);
    indexes.set(transcriptPath, idx);
    const missingIds = entryIds.filter((eid) => !found.has(eid));
    if (missingIds.length === 0 || Object.keys(idx).length === 0) continue;

    let fd: number | null = null;
    try {
      fd = fs.openSync(transcriptPath, 'r');

      for (const eid of missingIds) {
        const offset = idx[eid];
        if (offset === undefined) {
          continue;
        }

        const line = readLineAt(fd, offset);
        if (!line) continue;

        try {
          const raw = JSON.parse(line);
          found.set(eid, {
            entryId: typeof raw.entryId === 'number' ? raw.entryId : eid,
            sessionId: raw.sessionId || '',
            user: raw.user || '',
            assistant: raw.assistant || '',
            timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : 0,
          });
          foundPaths.set(eid, transcriptPath);
        } catch {
          console.warn(`[rehydrate] JSON parse failed for entryId=${eid}`);
        }
      }
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  // ── Legacy fallback：所有輪替代的 .idx 都 miss 後才 line scan ──────────────
  const missingIds = entryIds.filter((eid) => !found.has(eid));
  if (missingIds.length > 0) {
    console.warn(`[rehydrate] legacy_transcript_fallback: path=${jsonlPath}, ids=${missingIds.join(',')}`);
    for (const transcriptPath of transcriptPaths) {
      const legacyEntries = await legacyLineScan(transcriptPath, missingIds, bleed);
      for (const entry of legacyEntries) {
        if (missingIds.includes(entry.entryId)) {
          found.set(entry.entryId, entry);
          foundPaths.set(entry.entryId, transcriptPath);
        }
      }
    }
  }

  const entryMap = new Map<number, TranscriptEntry>(found);
  for (const transcriptPath of transcriptPaths) {
    const entries = Array.from(found.entries())
      .filter(([entryId]) => foundPaths.get(entryId) === transcriptPath)
      .map(([, entry]) => entry);
    if (entries.length === 0) continue;
    for (const entry of await expandBleed(transcriptPath, entries, bleed, indexes.get(transcriptPath) ?? {})) {
      entryMap.set(entry.entryId, entry);
    }
  }

  return Array.from(entryMap.values()).sort((a, b) => a.entryId - b.entryId);
}

// ---------------------------------------------------------------
// rehydrateByTime：時間窗救援（完全沒拿到 entryIds 時的 fallback）
// ---------------------------------------------------------------

/**
 * Fallback：LLM 完全沒給 ID 時，用時間窗救援（走 legacy line-scan）。
 *
 * @param jsonlPath      transcript JSONL 檔案路徑
 * @param centerTimestamp  中心時間（ISO string 或 Unix ms）
 * @param windowMinutes   時間窗分鐘數（預設 30）
 */
export async function rehydrateByTime(
  jsonlPath: string,
  centerTimestamp: string,
  windowMinutes: number = 30
): Promise<TranscriptEntry[]> {
  const transcriptPaths = getTranscriptPaths(jsonlPath);
  if (!transcriptPaths.some((transcriptPath) => fs.existsSync(transcriptPath))) return [];

  const centerMs = isNaN(Number(centerTimestamp))
    ? new Date(centerTimestamp).getTime()
    : Number(centerTimestamp);

  if (isNaN(centerMs)) {
    console.warn(`[rehydrateByTime] invalid timestamp: ${centerTimestamp}`);
    return [];
  }

  const halfWindowMs = windowMinutes * 60 * 1000;
  const since = centerMs - halfWindowMs;
  const until = centerMs + halfWindowMs;

  const results: TranscriptEntry[] = [];

  for (const transcriptPath of transcriptPaths) {
    try {
      const raw = fs.readFileSync(transcriptPath, 'utf-8');
      const lines = raw.split('\n').filter(l => l.trim());

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as { entryId?: number; timestamp?: number; user?: string; assistant?: string; sessionId?: string };
          if (!entry.timestamp) continue;
          if (entry.timestamp >= since && entry.timestamp <= until) {
            results.push({
              entryId: entry.entryId ?? -1,
              sessionId: entry.sessionId || '',
              user: entry.user || '',
              assistant: entry.assistant || '',
              timestamp: entry.timestamp,
            });
          }
        } catch {}
      }
    } catch {
      continue;
    }
  }

  return results.sort((a, b) => a.timestamp - b.timestamp);
}

// ---------------------------------------------------------------
// 內部工具
// ---------------------------------------------------------------

/**
 * 對已排序的 entry 陣列，往前向後擴充 bleed 筆記錄。
 */
async function expandBleed(
  jsonlPath: string,
  entries: TranscriptEntry[],
  bleed: number,
  index: Record<number, number>
): Promise<TranscriptEntry[]> {
  if (entries.length === 0 || bleed <= 0) return entries;

  const hitIds = new Set(entries.map(e => e.entryId));
  const minId = Math.min(...hitIds) - bleed;
  const maxId = Math.max(...hitIds) + bleed;

  const entryMap = new Map<number, TranscriptEntry>();
  entries.forEach(e => entryMap.set(e.entryId, e));

  const fd = fs.openSync(jsonlPath, 'r');
  try {
    for (let id = minId; id <= maxId; id++) {
      if (entryMap.has(id)) continue; // 已有的跳過
      const offset = index[id];
      if (offset == null) continue; // 不存在的 ID 跳過
      const buf = Buffer.alloc(8192);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, offset);
      const nlIdx = buf.indexOf(0x0a);
      const lineEnd = nlIdx === -1 ? bytesRead : nlIdx;
      const line = buf.slice(0, lineEnd).toString('utf8');
      try {
        const parsed = JSON.parse(line);
        entryMap.set(parsed.entryId, parsed);
      } catch { /* 壞行跳過 */ }
    }
  } finally {
    fs.closeSync(fd);
  }

  return [...entryMap.values()].sort((a, b) => a.entryId - b.entryId);
}

/**
 * Legacy line-scan：當 .idx 不存在或找不到 ID 時使用。
 * 按 entryId 找目標 + 附近鄰居。
 */
async function legacyLineScan(
  jsonlPath: string,
  targetIds: number[],
  bleed: number
): Promise<TranscriptEntry[]> {
  const targetSet = new Set(targetIds);
  const found: TranscriptEntry[] = [];
  const allEntries: TranscriptEntry[] = [];

  try {
    const raw = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { entryId?: number; sessionId?: string; user?: string; assistant?: string; timestamp?: number };
        allEntries.push({
          entryId: entry.entryId ?? -1,
          sessionId: entry.sessionId || '',
          user: entry.user || '',
          assistant: entry.assistant || '',
          timestamp: entry.timestamp || 0,
        });
      } catch {}
    }
  } catch (err) {
    console.error(`[rehydrate] legacyLineScan failed:`, err);
    return [];
  }

  if (allEntries.length === 0) return [];

  // 對有 targetId 的精確找，沒有 targetId 就取所有（因為 legacy 檔根本沒 entryId）
  if (targetIds.length > 0 && targetIds[0] !== -1) {
    for (const entry of allEntries) {
      if (targetSet.has(entry.entryId)) {
        found.push(entry);
      }
    }
    // 沒有精確匹配：說明是舊檔（沒 entryId），全部返回
    if (found.length === 0) {
      console.warn(`[rehydrate] legacy_transcript_fallback: no entryId match, returning all entries (${allEntries.length})`);
      return allEntries.slice(-20); // 最多取最近 20 筆
    }
    return found;
  } else {
    // 沒有 targetId → 全量返回（最多 20 筆）
    return allEntries.slice(-20);
  }
}
