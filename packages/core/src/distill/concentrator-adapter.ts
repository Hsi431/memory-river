/**
 * ConcentratorAdapter — memory-river 的濃縮膠囊 class wrapper (V8 終極重構版 + 幽靈清掃機)
 *
 * 【四步完美閉環架構】：
 * 1. 60% 動態水位線精準觸發
 * 2. 徹底解除 800 字物理腰斬，保持 MUD 遊戲情報原汁原味
 * 3. 雙軌並行提煉：短期前情提要 (大膠囊, health: 30) + 長期精確記憶 (小紙條)
 * 4. 完美回注與幽靈清理：注入 Context 頂端，並自動拔除斷片的 Tool Result
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { ContextMessage, type ConcentratorFailureReason, type ConcentratorProvider } from '../types.js';
import { CapsuleBridge } from '../pipeline/capsule-bridge.js';
import { sharedLLMRateLimiter } from '../util/rate-limiter.js';
import type { RawTranscriptEntry, TranscriptArchive } from '../transcript/transcript-archive.js';
import type { SessionIdentity } from '../util/session-identity.js';
import type { MemoryStore } from '../store/store-v4.js';
import type { LlmClient } from '../ports.js';

/**
 * concentrate() 可選 context；目前用來把 sessionIdentity 傳到 writeSessionSummary，
 * 避免從 rawMessages[0].sessionId 這種側通道猜 sessionId。
 */
export interface ConcentrateContext {
  sessionIdentity?: SessionIdentity;
  exhaustive?: boolean;
}

export interface SessionSummary {
  sessionId: string;
  concentratedAt: number;
  capsule: string;
  notes: Array<{
    text: string;
    category: string;
    importance: number;
    tags: string[];
    // Optional shallow structured enrichment (all may be omitted). Stored in note
    // metadata as-is — NOT a filter on what to extract. `text` stays authoritative.
    subject?: string;
    predicate?: string;
    value?: string | number | boolean;
    unit?: string;
    when?: {
      start?: string;
      end?: string;
      precision?: 'datetime' | 'date' | 'month' | 'year' | 'range' | 'unknown';
      sourceText?: string;
      source?: 'explicit' | 'relative_anchored' | 'contextual' | 'unknown';
      anchor?: string;
    };
  }>;
  primaryRequest: string;
  pendingTasks: string;
  nextStep: string;
}

const CONCRETE_FACT_NOTE_CATEGORIES = new Set([
  'fact',
  'decision',
  'entity',
  'preference',
  'constraint',
  'identity',
  'knowledge',
  'history',
  'business',
]);

function getConcentratorNoteImportanceThreshold(category: unknown): number {
  return typeof category === 'string' && CONCRETE_FACT_NOTE_CATEGORIES.has(category) ? 0.2 : 0.4;
}

export function passesConcentratorNoteImportanceFilter(item: {
  category?: unknown;
  importance?: unknown;
}): boolean {
  return typeof item.importance === 'number'
    && item.importance >= getConcentratorNoteImportanceThreshold(item.category);
}

type SourceEntryIdsMatchReason =
  | 'archive_lag'
  | 'count_mismatch'
  | 'order_mismatch'
  | 'text_mismatch';

interface ComparableTranscriptPair {
  user: string;
  assistant: string;
  timestamp: number;
  entryId?: number;
  mergedFromEntryIds?: number[];
}

interface SourceEntryIdsProbeResult {
  summarizePairCount: number;
  candidateCount: number;
  matched: boolean;
  matchedEntryIds: number[];
  sourceEntryIds: number[];
  reason?: SourceEntryIdsMatchReason;
}

interface BoundaryHeuristicResult {
  triggered: boolean;
  originalCandidateCount: number;
  candidateEntries: ComparableTranscriptPair[];
  droppedCandidate?: ComparableTranscriptPair;
}

interface StringDiffDetail {
  field: 'user' | 'assistant';
  index: number;
  summarizeChar: string;
  summarizeCharCode: number | null;
  candidateChar: string;
  candidateCharCode: number | null;
}

export interface ProbeTextMismatchDetail {
  mismatchIndex: number;
  summarizePair: ComparableTranscriptPair;
  candidatePair: ComparableTranscriptPair;
  diff: StringDiffDetail;
}

// ─── Regex 過濾 helper ────────────────────────────────────────────────

function isSystemExecInjection(msg: ContextMessage): boolean {
  if (msg.role !== 'user') return false;
  const raw = msg.content as unknown;
  if (typeof raw === 'string') return /^System:\s*\[.*?\]\s*Exec/i.test(raw);
  if (Array.isArray(raw)) {
    return (raw as Array<{ type?: string; text?: string }>).some((part) =>
      part?.type === 'text' && typeof part.text === 'string' && /^System:\s*\[.*?\]\s*Exec/i.test(part.text)
    );
  }
  return false;
}

const CONCENTRATION_FRAMEWORK_PATTERNS = [
  'A new session was started via /new or /reset',
  'Run your Session Startup sequence',
  '✅ New session started · model:',
];

const SESSION_INIT_PATTERNS = [
  'A new session was started via /new or /reset',
  'Run your Session Startup sequence',
];

export function extractTextForConcentrationContent(content: ContextMessage['content']): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (part.type !== 'text' || typeof part.text !== 'string') return '';
      return part.text.trim();
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function isFrameworkMetadataForConcentration(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trimStart();

  if (CONCENTRATION_FRAMEWORK_PATTERNS.some((pattern) => trimmed.includes(pattern))) {
    return true;
  }

  return (
    trimmed.startsWith('Conversation info (untrusted metadata)') ||
    trimmed.startsWith('[Inter-session message]') ||
    trimmed.startsWith('Note: The previous agent run was aborted') ||
    trimmed.startsWith('[media attached:') ||
    trimmed.startsWith('(system)') ||
    trimmed.startsWith('[metadata]')
  );
}

export function stripFrameworkMetadataForConcentration(text: string): string {
  if (!text) return '';

  let stripped = text.trim();

  if (stripped.startsWith('[Inter-session message]')) {
    const interSessionPrefix = stripped.match(
      /^\[Inter-session message\]\s+sourceSession=.*?\s+sourceChannel=.*?\s+sourceTool=.*?(?=\s+\[)/i
    );

    if (interSessionPrefix) {
      stripped = stripped.slice(interSessionPrefix[0].length).trimStart();
    } else {
      stripped = stripped.replace(/^\[Inter-session message\][\s\S]*$/i, '').trim();
    }
  }

  if (stripped.startsWith('Conversation info (untrusted metadata)')) {
    stripped = stripped.replace(/^Conversation info \(untrusted metadata\)[\s\S]*?\n\n/i, '').trim();
  }

  if (stripped.startsWith('Sender (untrusted metadata):')) {
    stripped = stripped
      .replace(/^Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/i, '')
      .replace(/^Sender \(untrusted metadata\):\s*\{[\s\S]*?\}\s*/i, '')
      .trim();
  }

  return stripped;
}

function normalizeComparableText(text: string): string {
  return stripFrameworkMetadataForConcentration(text).replace(/\s+/g, ' ').trim();
}

function isSessionInitMessageForProbe(text: string): boolean {
  return SESSION_INIT_PATTERNS.some((pattern) => text.includes(pattern));
}

export function buildComparableTranscriptPairs(messages: ContextMessage[]): ComparableTranscriptPair[] {
  const pairs: ComparableTranscriptPair[] = [];
  let pendingUser: string | null = null;
  let pendingTimestamp = Date.now();

  for (const msg of messages) {
    const text = normalizeComparableText(extractTextForConcentrationContent(msg.content));
    if (!text || isSessionInitMessageForProbe(text)) continue;

    if (msg.role === 'user') {
      pendingUser = text;
      pendingTimestamp = msg.timestamp ?? Date.now();
      continue;
    }

    if (msg.role === 'assistant' && pendingUser !== null) {
      pairs.push({
        user: pendingUser,
        assistant: text,
        timestamp: pendingTimestamp,
      });
      pendingUser = null;
    }
  }

  return pairs;
}

function isSystemExecTranscriptCandidate(userText: string): boolean {
  return isSystemExecInjection({
    role: 'user',
    content: userText,
    timestamp: 0,
  });
}

export function buildComparableTranscriptCandidates(entries: RawTranscriptEntry[]): ComparableTranscriptPair[] {
  const normalizedEntries = entries
    .map((entry) => ({
      entryId: entry.entryId,
      user: normalizeComparableText(entry.user),
      assistant: normalizeComparableText(entry.assistant),
      timestamp: entry.timestamp,
    }))
    .filter((entry) => !isSystemExecTranscriptCandidate(entry.user));

  const mergedEntries: ComparableTranscriptPair[] = [];
  let pendingUserPrefix = '';
  let pendingEntryIds: number[] = [];

  for (const entry of normalizedEntries) {
    if (entry.assistant.trim().length === 0) {
      pendingUserPrefix = pendingUserPrefix
        ? `${pendingUserPrefix} ${entry.user}`.trim()
        : entry.user;
      if (typeof entry.entryId === 'number' && entry.entryId > 0) {
        pendingEntryIds.push(entry.entryId);
      }
      continue;
    }

    const mergedUser = pendingUserPrefix
      ? `${pendingUserPrefix} ${entry.user}`.trim()
      : entry.user;
    const mergedFromEntryIds = [
      ...pendingEntryIds,
      ...(typeof entry.entryId === 'number' && entry.entryId > 0 ? [entry.entryId] : []),
    ];

    mergedEntries.push({
      ...entry,
      user: mergedUser,
      mergedFromEntryIds: mergedFromEntryIds.length > 1 ? mergedFromEntryIds : undefined,
    });

    pendingUserPrefix = '';
    pendingEntryIds = [];
  }

  return mergedEntries;
}

export function applyBoundaryHeuristicForProbe(
  candidateEntries: ComparableTranscriptPair[],
  summarizePairCount: number,
): BoundaryHeuristicResult {
  if (candidateEntries.length === summarizePairCount + 1 && candidateEntries.length > 0) {
    return {
      triggered: true,
      originalCandidateCount: candidateEntries.length,
      candidateEntries: candidateEntries.slice(0, -1),
      droppedCandidate: candidateEntries[candidateEntries.length - 1],
    };
  }

  return {
    triggered: false,
    originalCandidateCount: candidateEntries.length,
    candidateEntries,
  };
}

function charCodeOrNull(char: string): number | null {
  if (!char) return null;
  return char.codePointAt(0) ?? null;
}

function findFirstStringDiff(
  field: 'user' | 'assistant',
  summarizeText: string,
  candidateText: string,
): StringDiffDetail | null {
  const maxLength = Math.max(summarizeText.length, candidateText.length);
  for (let index = 0; index < maxLength; index++) {
    const summarizeChar = summarizeText[index] ?? '';
    const candidateChar = candidateText[index] ?? '';
    if (summarizeChar !== candidateChar) {
      return {
        field,
        index,
        summarizeChar,
        summarizeCharCode: charCodeOrNull(summarizeChar),
        candidateChar,
        candidateCharCode: charCodeOrNull(candidateChar),
      };
    }
  }
  return null;
}

function previewText(text: string): string {
  return JSON.stringify(text.slice(0, 200));
}

function previewAlignmentText(text: string, limit: number): string {
  return JSON.stringify(text.slice(0, limit));
}

export function findProbeTextMismatchDetail(
  summarizePairs: ComparableTranscriptPair[],
  candidateEntries: ComparableTranscriptPair[],
): ProbeTextMismatchDetail | null {
  const maxLength = Math.min(summarizePairs.length, candidateEntries.length);
  for (let index = 0; index < maxLength; index++) {
    const summarizePair = summarizePairs[index];
    const candidatePair = candidateEntries[index];
    if (!candidatePair) continue;
    if (summarizePair.user !== candidatePair.user) {
      const diff = findFirstStringDiff('user', summarizePair.user, candidatePair.user);
      if (!diff) continue;
      return { mismatchIndex: index, summarizePair, candidatePair, diff };
    }
    if (summarizePair.assistant !== candidatePair.assistant) {
      const diff = findFirstStringDiff('assistant', summarizePair.assistant, candidatePair.assistant);
      if (!diff) continue;
      return { mismatchIndex: index, summarizePair, candidatePair, diff };
    }
  }
  return null;
}

export function logProbeTextMismatchDetail(detail: ProbeTextMismatchDetail): void {
  console.log(`[P0-1 probe] text_mismatch detail: index=${detail.mismatchIndex} entryId=${detail.candidatePair.entryId ?? 'unknown'}`);
  console.log(`[P0-1 probe] summarize.user[0..200]: ${previewText(detail.summarizePair.user)}`);
  console.log(`[P0-1 probe] candidate.user[0..200]: ${previewText(detail.candidatePair.user)}`);
  console.log(`[P0-1 probe] summarize.user.length=${detail.summarizePair.user.length} candidate.user.length=${detail.candidatePair.user.length}`);
  console.log(`[P0-1 probe] summarize.assistant[0..200]: ${previewText(detail.summarizePair.assistant)}`);
  console.log(`[P0-1 probe] candidate.assistant[0..200]: ${previewText(detail.candidatePair.assistant)}`);
  console.log(`[P0-1 probe] summarize.assistant.length=${detail.summarizePair.assistant.length} candidate.assistant.length=${detail.candidatePair.assistant.length}`);
  console.log(
    `[P0-1 probe] first diff at ${detail.diff.field} index ${detail.diff.index}: summarize=${JSON.stringify(detail.diff.summarizeChar)}(${detail.diff.summarizeCharCode ?? 'null'}) candidate=${JSON.stringify(detail.diff.candidateChar)}(${detail.diff.candidateCharCode ?? 'null'})`
  );
}

function logProbeAlignmentDump(
  summarizePairs: ComparableTranscriptPair[],
  candidateEntries: ComparableTranscriptPair[],
): void {
  const sharedLength = Math.min(summarizePairs.length, candidateEntries.length);

  for (let index = 0; index < sharedLength; index++) {
    const summarizePair = summarizePairs[index];
    const candidatePair = candidateEntries[index];
    const isMatch = summarizePair.user === candidatePair.user && summarizePair.assistant === candidatePair.assistant;
    const mergedSuffix = candidatePair.mergedFromEntryIds?.length
      ? ` (merged from [${candidatePair.mergedFromEntryIds.join(', ')}])`
      : '';

    console.log(
      `[P0-1 probe] align[${index}]: match=${isMatch ? 'yes' : 'no'} candEntryId=${candidatePair.entryId ?? 'unknown'}${mergedSuffix} candTs=${candidatePair.timestamp}`
    );
    console.log(`  s.user[0..80]=${previewAlignmentText(summarizePair.user, 80)}`);
    console.log(`  c.user[0..80]=${previewAlignmentText(candidatePair.user, 80)}`);
    console.log(`  s.assist[0..40]=${previewAlignmentText(summarizePair.assistant, 40)}`);
    console.log(`  c.assist[0..40]=${previewAlignmentText(candidatePair.assistant, 40)}`);
  }

  if (summarizePairs.length > candidateEntries.length) {
    for (let index = candidateEntries.length; index < summarizePairs.length; index++) {
      const summarizePair = summarizePairs[index];
      console.log(`[P0-1 probe] align[${index}]: summarize-tail`);
      console.log(`  s.user[0..80]=${previewAlignmentText(summarizePair.user, 80)}`);
      console.log(`  s.assist[0..40]=${previewAlignmentText(summarizePair.assistant, 40)}`);
    }
  }

  if (candidateEntries.length > summarizePairs.length) {
    for (let index = summarizePairs.length; index < candidateEntries.length; index++) {
      const candidatePair = candidateEntries[index];
      const mergedSuffix = candidatePair.mergedFromEntryIds?.length
        ? ` (merged from [${candidatePair.mergedFromEntryIds.join(', ')}])`
        : '';
      console.log(
        `[P0-1 probe] align[${index}]: candidate-tail candEntryId=${candidatePair.entryId ?? 'unknown'}${mergedSuffix} candTs=${candidatePair.timestamp}`
      );
      console.log(`  c.user[0..80]=${previewAlignmentText(candidatePair.user, 80)}`);
      console.log(`  c.assist[0..40]=${previewAlignmentText(candidatePair.assistant, 40)}`);
    }
  }
}

function buildSourceEntryIds(candidateEntries: ComparableTranscriptPair[]): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();

  for (const entry of candidateEntries) {
    const entryIds = entry.mergedFromEntryIds?.length
      ? entry.mergedFromEntryIds
      : [entry.entryId];

    for (const entryId of entryIds) {
      if (typeof entryId !== 'number' || entryId <= 0 || seen.has(entryId)) continue;
      seen.add(entryId);
      ids.push(entryId);
    }
  }

  return ids;
}

function probeSourceEntryIdMatch(
  transcriptArchive: TranscriptArchive,
  messagesToSummarize: ContextMessage[],
  sessionIdentity: SessionIdentity | undefined,
  firstTimestamp: number,
  lastTimestamp: number,
): SourceEntryIdsProbeResult | null {
  if (!sessionIdentity) return null;

  const summarizePairs = buildComparableTranscriptPairs(messagesToSummarize);
  const rawCandidateEntries = buildComparableTranscriptCandidates(
    transcriptArchive.getRawTranscript(sessionIdentity, firstTimestamp)
      .filter((entry) => entry.timestamp <= lastTimestamp)
  );
  const boundaryHeuristic = applyBoundaryHeuristicForProbe(rawCandidateEntries, summarizePairs.length);
  if (boundaryHeuristic.triggered) {
    console.log(
      `[P0-1 probe] boundary heuristic: drop last candidate (entryId=${boundaryHeuristic.droppedCandidate?.entryId ?? 'unknown'}, ts=${boundaryHeuristic.droppedCandidate?.timestamp ?? 'unknown'}, summarizePairs=${summarizePairs.length}, candidateCount=${boundaryHeuristic.originalCandidateCount})`
    );
  }
  const candidateEntries = boundaryHeuristic.candidateEntries;

  if (candidateEntries.length < summarizePairs.length) {
    return {
      summarizePairCount: summarizePairs.length,
      candidateCount: candidateEntries.length,
      matched: false,
      matchedEntryIds: [],
      sourceEntryIds: [],
      reason: 'archive_lag',
    };
  }

  if (candidateEntries.length > summarizePairs.length) {
    return {
      summarizePairCount: summarizePairs.length,
      candidateCount: candidateEntries.length,
      matched: false,
      matchedEntryIds: [],
      sourceEntryIds: [],
      reason: 'count_mismatch',
    };
  }

  const sameOrder = summarizePairs.every((pair, index) => {
    const candidate = candidateEntries[index];
    return candidate?.user === pair.user && candidate?.assistant === pair.assistant;
  });

  if (sameOrder) {
    return {
      summarizePairCount: summarizePairs.length,
      candidateCount: candidateEntries.length,
      matched: true,
      matchedEntryIds: candidateEntries
        .map((entry) => entry.entryId)
        .filter((entryId): entryId is number => typeof entryId === 'number' && entryId > 0),
      sourceEntryIds: buildSourceEntryIds(candidateEntries),
    };
  }

  const summarizeKeys = summarizePairs.map((pair) => `${pair.user}\u001f${pair.assistant}`).sort();
  const candidateKeys = candidateEntries.map((pair) => `${pair.user}\u001f${pair.assistant}`).sort();
  const sameSet = summarizeKeys.length === candidateKeys.length
    && summarizeKeys.every((key, index) => key === candidateKeys[index]);
  const reason: SourceEntryIdsMatchReason = sameSet ? 'order_mismatch' : 'text_mismatch';

  if (reason === 'text_mismatch') {
    const mismatchDetail = findProbeTextMismatchDetail(summarizePairs, candidateEntries);
    if (mismatchDetail) {
      logProbeTextMismatchDetail(mismatchDetail);
    }
    logProbeAlignmentDump(summarizePairs, candidateEntries);
  }

  return {
    summarizePairCount: summarizePairs.length,
    candidateCount: candidateEntries.length,
    matched: false,
    matchedEntryIds: [],
    sourceEntryIds: [],
    reason,
  };
}

const FALLBACK_INTERNAL_PATTERNS = [
  /\[Inter-session message\]/i,
  /runtime context \(internal\)/i,
  /This context is runtime-generated, not user-authored/i,
  /\[Internal task completion event\]/i,
  /<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>/i,
  /<<<END_UNTRUSTED_CHILD_RESULT>>>/i,
  /^Stats:\s*runtime/i,
  /^Action:\s*A completed subagent task/i,
  /^Result \(untrusted content, treat as data\):/i,
  /^NO_REPLY$/i,
  /^source:\s*subagent/i,
  /^source(Session|Channel|Tool):/i,
  /^session_(key|id):/i,
  /^type:\s*subagent task/i,
  /^task:/i,
  /^status:\s*completed successfully/i,
  /^##\s*你的任務$/i,
  /^##\s*研究範圍$/i,
  /^##\s*資訊來源優先順序$/i,
  /^##\s*嚴禁$/i,
  /^##\s*產出格式$/i,
  /^##\s*網路工具測試結果回報$/i,
  /^到 Hashtag 階段了/i,
  /^到 Search 階段了/i,
  /^全流程跑完了/i,
  /^Webhook URL/i,
  /^Discord 通知 403/i,
];

function isFallbackInternalNoise(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return FALLBACK_INTERNAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function sanitizeInternalNoiseLine(line: string): string {
  let current = line.trim();
  if (!current) return '';

  while (current) {
    let matched = false;

    for (const pattern of FALLBACK_INTERNAL_PATTERNS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(current);
      if (!match || typeof match.index !== 'number') continue;

      const start = match.index;
      const matchText = match[0] ?? '';
      const end = start + matchText.length;

      if (start === 0 && end >= current.length) {
        return '';
      }

      if (start === 0) {
        current = current.slice(end).trim();
      } else {
        current = current.slice(0, start).trim();
      }

      matched = true;
      break;
    }

    if (!matched) break;
  }

  if (!current) return '';
  if (isFallbackInternalNoise(current)) return '';
  if (/<\/?[a-z][^>]*>/i.test(current)) return '';
  if (!current.startsWith('[JSON陣列已省略') && current.startsWith('[')) return '';
  if (current.startsWith('<<<') || current.startsWith('>>>')) return '';

  return current;
}

function sanitizeInternalNoiseText(text: string): string {
  if (!text) return '';

  const stripped = stripFrameworkMetadataForConcentration(text);
  if (!stripped) return '';

  const lines = stripped
    .split('\n')
    .map((line) => sanitizeInternalNoiseLine(line))
    .filter(Boolean);

  const joined = lines.join('\n').trim();
  return isFallbackInternalNoise(joined) ? '' : joined;
}

function sanitizeForFallbackSummary(text: string): string {
  return sanitizeInternalNoiseText(text);
}

function selectRecentFallbackWindow(items: Array<{ role: ContextMessage['role']; text: string }>): Array<{ role: ContextMessage['role']; text: string }> {
  if (items.length === 0) return [];
  const conversationalItems = items.filter((item) => item.role === 'user' || item.role === 'assistant');
  if (conversationalItems.length === 0) return [];

  let anchor = -1;
  for (let i = conversationalItems.length - 1; i >= 0; i--) {
    if (conversationalItems[i].role === 'user' && conversationalItems[i].text.trim().length >= 8) {
      anchor = i;
      break;
    }
  }

  if (anchor === -1) {
    return conversationalItems.slice(-6);
  }

  const window = conversationalItems.slice(anchor, Math.min(conversationalItems.length, anchor + 8));
  return window.length > 0 ? window : conversationalItems.slice(-6);
}

// ─── 終極深層防爆破截斷器 V2 (防禦「蟲群」陣列攻擊) ───
function truncateGiantStrings(msg: ContextMessage): ContextMessage {
  const MAX_STRING_LENGTH = 15000;
  const MAX_ARRAY_LENGTH = 50; 
  const MAX_OBJECT_KEYS = 50;  

  function truncateDeep(obj: any): any {
    if (typeof obj === 'string') {
      return obj.length > MAX_STRING_LENGTH 
        ? obj.substring(0, MAX_STRING_LENGTH) + "\n...[字串過長已截斷]..." 
        : obj;
    }
    if (Array.isArray(obj)) {
      if (obj.length > MAX_ARRAY_LENGTH) {
        const sliced = obj.slice(0, MAX_ARRAY_LENGTH).map(item => truncateDeep(item));
        sliced.push(`\n...[系統保護：陣列資料過多，原本 ${obj.length} 筆，已強制截斷剩前 ${MAX_ARRAY_LENGTH} 筆]...`);
        return sliced;
      }
      return obj.map(item => truncateDeep(item));
    }
    if (typeof obj === 'object' && obj !== null) {
      const newObj: any = {};
      let keyCount = 0;
      for (const key in obj) {
        if (keyCount >= MAX_OBJECT_KEYS) {
          newObj["_SYSTEM_WARNING_"] = `...[系統保護：物件 Key 過多，已強制截斷]...`;
          break;
        }
        newObj[key] = truncateDeep(obj[key]);
        keyCount++;
      }
      return newObj;
    }
    return obj;
  }

  return truncateDeep(msg);
}

function stripThinkingBlocks(msg: ContextMessage): ContextMessage {
  if (msg.role !== 'assistant') return msg;
  const cleaned = JSON.parse(JSON.stringify(msg));

  if (typeof cleaned.content === 'string') {
    cleaned.content = cleaned.content
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<antThinking>[\s\S]*?<\/antThinking>/gi, '')
      .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
      .replace(/<\/reasoning>/gi, '')
      .replace(/\[Reasoning:\s*\][\s\S]*?\[\/Reasoning\]/gi, '')
      .replace(/\[Reasoning\][\s\S]*?\[\/Reasoning\]/gi, '')
      .replace(/\[Reasoning:[^\]]*\][\s\S]*?\[\/Reasoning\]/gi, '')
      .replace(/\[Reasoning:[^\]]*\]/gi, '')
      .replace(/\[\/Reasoning\]/gi, '')
      .trim();
} else if (Array.isArray(cleaned.content)) {
    (cleaned.content as any[]).forEach(part => {
      if (part && part.type === 'text' && typeof part.text === 'string') {
        // 🛠️ 補齊所有思考區塊的過濾網！
        part.text = part.text
          .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
          .replace(/<think>[\s\S]*?<\/think>/gi, '')
          .replace(/<antThinking>[\s\S]*?<\/antThinking>/gi, '')
          .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
          .replace(/<\/reasoning>/gi, '')
          .replace(/\[Reasoning:\s*\][\s\S]*?\[\/Reasoning\]/gi, '')
          .replace(/\[Reasoning\][\s\S]*?\[\/Reasoning\]/gi, '')
          .replace(/\[Reasoning:[^\]]*\][\s\S]*?\[\/Reasoning\]/gi, '')
          .replace(/\[Reasoning:[^\]]*\]/gi, '')
          .replace(/\[\/Reasoning\]/gi, '')
          .trim(); 
      }
    });
  }
  delete (cleaned as any).tool_calls;
  return cleaned;
}

// ─── 濃縮前置過濾器 (Claude 究極四層降噪濾網版 - UI 防崩潰 Hex 編碼) ───
function preFilterForConcentration(messages: ContextMessage[]): ContextMessage[] {
  const seenCodeBlocks = new Set<string>();
  let beforeLength = 0;
  let afterLength = 0;

  // 用於記錄訊息結構診斷 Log
  const stats: Record<string, { count: number, length: number }> = {};

  const filtered = messages.map(msg => {
    let cleanMsg = JSON.parse(JSON.stringify(msg));
    const role = cleanMsg.role || 'unknown';

    // 估算原始長度與統計
    const msgStr = extractTextForConcentrationContent(cleanMsg.content);
    const currentLen = msgStr.length;
    beforeLength += currentLen;

    if (!stats[role]) stats[role] = { count: 0, length: 0 };
    stats[role].count++;
    stats[role].length += currentLen;

    // ==========================================
    // 🛡️ 第 1 層：完全移除 tool/function/tool_result/toolResult
    // ==========================================
    if (['tool', 'function', 'tool_result', 'toolResult'].includes(role)) {
      return null;
    }

    // 處理 assistant 中的 tool_call JSON (替換為省略標記)
    if (role === 'assistant') {
      if (cleanMsg.tool_calls || cleanMsg.function_call) {
        delete cleanMsg.tool_calls;
        delete cleanMsg.function_call;
        if (typeof cleanMsg.content === 'string') {
          cleanMsg.content += '\n[工具呼叫已省略]';
        } else if (Array.isArray(cleanMsg.content)) {
          cleanMsg.content.push({ type: 'text', text: '\n[工具呼叫已省略]' });
        } else if (!cleanMsg.content) {
          cleanMsg.content = '[工具呼叫已省略]';
        }
      }
    }

    // 若 content 是陣列，先清理裡面的 tool 區塊
    if (Array.isArray(cleanMsg.content)) {
      cleanMsg.content = cleanMsg.content.filter((part: any) =>
        part.type !== 'tool_result' && part.type !== 'tool_use'
      );
      if (cleanMsg.content.length === 0) return null;
      const normalized = extractTextForConcentrationContent(cleanMsg.content);
      if (!normalized) return null;
      cleanMsg.content = sanitizeInternalNoiseText(normalized);
      if (!cleanMsg.content) return null;
    }

    if (typeof cleanMsg.content === 'string') {
      cleanMsg.content = sanitizeInternalNoiseText(cleanMsg.content);
      if (!cleanMsg.content) return null;
      if (isFrameworkMetadataForConcentration(cleanMsg.content)) {
        return null;
      }

      // ==========================================
      // 🛡️ 第 2 層：Code block 去重 + 截斷到 300 字
      // 這裡使用 \x60 取代反引號，防止聊天室 UI 解析崩潰！
      // ==========================================
      cleanMsg.content = cleanMsg.content.replace(/\x60\x60\x60[\s\S]*?\x60\x60\x60/g, (match: string) => {
        const signature = match.substring(0, 100);
        if (seenCodeBlocks.has(signature)) {
          return '\n[重複代碼已省略]\n';
        }
        seenCodeBlocks.add(signature);

        if (match.length > 300) {
          return match.substring(0, 300) + '\n...\n[代碼過長已截斷]\n\x60\x60\x60';
        }
        return match;
      });

      // ==========================================
      // 🛡️ 第 3 層：大型 JSON 物件/陣列 (>500字) — 結構特徵判定
      // 不用 JSON.parse（截斷過的 JSON 永遠 parse 失敗），改用長度+引號特徵
      // ==========================================
      cleanMsg.content = cleanMsg.content.replace(/\{[\s\S]{500,}?\}/g, (match: string) => {
        if (match.includes('"') && (match.includes('":') || match.includes('" :'))) {
          return `[JSON物件已省略(${match.length}字)]`;
        }
        return match;
      });
      cleanMsg.content = cleanMsg.content.replace(/\[[\s\S]{500,}?\]/g, (match: string) => {
        if (match.includes('"') || match.includes('{')) {
          return `[JSON陣列已省略(${match.length}字)]`;
        }
        return match;
      });

      // ==========================================
      // 🛡️ 第 4 層：Role-aware 截斷
      // assistant 訊息上限 2000 字（結論在頭尾，code 已被第 2 層砍過）
      // user 訊息上限 3000 字（保留更多原始意圖）
      // ==========================================
      const maxChars = role === 'assistant' ? 2000 : 3000;
      if (cleanMsg.content.length > maxChars) {
        const len = cleanMsg.content.length;
        const headLen = Math.floor(maxChars * 0.7);
        const tailLen = Math.floor(maxChars * 0.3);
        const head = cleanMsg.content.substring(0, headLen);
        const tail = cleanMsg.content.substring(len - tailLen);
        cleanMsg.content = `${head}\n\n...[訊息過長已截斷，保留頭尾 (原長 ${len} 字)]...\n\n${tail}`;
      }
    }

    // 估算過濾後長度
    const afterStr = extractTextForConcentrationContent(cleanMsg.content);
    afterLength += afterStr.length;

    return cleanMsg;
  }).filter(Boolean) as ContextMessage[]; 

  // 印出訊息結構診斷 Log
  const statsArr = Object.entries(stats).map(([role, data]) => {
      const wCount = (data.length / 10000).toFixed(1);
      return `${role}:${data.count}則/${wCount}萬字`;
  });
  console.log(`[ConcentratorAdapter] Message structure: ${statsArr.join(', ')}`);

  // 印出雜訊過濾 Log
  if (beforeLength > 0) {
    const reducePercent = Math.round((1 - afterLength / beforeLength) * 100);
    console.log(`[ConcentratorAdapter] Noise filtering: ${(beforeLength / 10000).toFixed(1)} ten-thousand chars -> ${(afterLength / 10000).toFixed(1)} ten-thousand chars (reduced ${reducePercent}%)`);
  }

  return filtered;
}

// ─── 幽靈工具回傳清理 (Ghost Tool Call Cleaner) ───────────────────────

function finalizeMessages(newMessages: ContextMessage[]): ContextMessage[] {
  const activeCallIds = new Set<string>();

  for (const m of newMessages) {
    if (m.role === 'assistant') {
      if ((m as any).tool_calls) {
        (m as any).tool_calls.forEach((c: any) => c.id && activeCallIds.add(c.id));
      }
      if (Array.isArray(m.content)) {
        m.content.forEach((part: any) => {
          const callId = part.id || part.callId || part.tool_call_id || part.toolCallId || part.tool_use_id || part.function_call_id;
          if (callId) activeCallIds.add(callId);
        });
      }
    }
  }

  let finalizedMessages: ContextMessage[] = [];
  for (const m of newMessages) {
    const role = m.role as string;
    
    if (role === 'tool' || role === 'function' || role === 'tool_result' || role === 'toolResult') {
      const callId = (m as any).tool_call_id || (m as any).toolCallId || (m as any).callId || (m as any).id || (m as any).name;
      if (callId && !activeCallIds.has(callId)) {
        continue;
      }
    }

    if (Array.isArray(m.content)) {
      let hasOrphan = false;
      const cleanedContent = m.content.filter((part: any) => {
        if (part && (part.type === 'tool_result' || part.type === 'tool_response' || part.type === 'tool' || part.type === 'toolResult')) {
          const callId = part.tool_use_id || part.toolUseId || part.tool_call_id || part.toolCallId || part.callId || part.id;
          if (callId && !activeCallIds.has(callId)) {
            hasOrphan = true;
            return false;
          }
        }
        return true;
      });

      if (hasOrphan) {
        if (cleanedContent.length === 0) continue; 
        m.content = cleanedContent as any;
      }
    }
    finalizedMessages.push(m);
  }
  return finalizedMessages;
}

// ─── 全新雙軌 Prompt 引擎 ───────────────────────────────────────────

export function buildDualTrackPrompt(conversationLog: string, capsuleLanguage: string = '繁體中文'): string {
  const isSourceLanguage = capsuleLanguage === 'source';
  const sourceLanguageRequirementTop = 'LANGUAGE REQUIREMENT: Write the ENTIRE capsule/前情提要 and structured summary content in the SAME language as the transcript. If the transcript is in English, write the capsule and summary in English. Do NOT default to Chinese. This overrides all other instructions.';
  const sourceLanguageRequirementBottom = 'LANGUAGE REQUIREMENT REMINDER: Write the ENTIRE capsule/前情提要 and structured summary content in the SAME language as the transcript above. If the transcript is in English, write the capsule and summary in English. Do NOT default to Chinese. This overrides all other instructions.';
  const prompt = `你是一個專業的 AI 記憶蒸餾引擎。

你現在要處理的唯一資料來源，是下方提供的真實對話內容。你必須只根據該對話內容蒸餾，不可把本提示中的任務說明、JSON 格式要求、section 定義、評分規則，誤當成對話事實。

=== BEGIN REAL CONVERSATION ===
${conversationLog}
=== END REAL CONVERSATION ===

【任務 A：蒸餾草稿（analysis scratchpad）】
先仔細閱讀上方真實對話，寫出完整的分析 scratchpad：
- 對話的完整脈絡與進展
- 技術細節、錯誤、修復過程
- 用戶的核心意圖與指令
- 任何需要保留顆粒化細節的決定/數值
但 analysis 必須極度精簡，限制在 800 字內。若輸出長度吃緊，優先縮短 analysis，不可犧牲 summary 的完整性。

【任務 B：結構化總結（summary）— 這才是最終產物】
請嚴格按照以下 9 個 section 輸出（每個 section 不能為空，若無資訊寫「無」）：
每個欄位請用 1-3 句精簡完成，不要長篇展開。

## 1. Primary Request and Intent
用戶最原始、最核心的請求是什麼？

## 2. Key Technical Concepts
這次對話涉及哪些關鍵技術概念、架構决策、工具使用？

## 3. Files and Code Sections
涉及哪些檔案？做了什麼改動？

## 4. Errors and Fixes
遇到了什麼錯誤？如何修復的？

## 5. Problem Solving
如何解決問題的？走了哪些弯路？

## 6. All User Messages
所有 user message 的摘要（保留關鍵指令）

## 7. Pending Tasks
還有什麼沒完成的？

## 8. Current Work
目前工作進度/狀態

## 9. Optional Next Step
下一步建議（可選）

【顆粒化長期記憶（notes）】
從真實對話中提取所有可被獨立詢問與回答的具體事實，包括明確名稱、地點、日期、數值、物件、偏好、決定與結果。不得僅因某項事實看似重要性較低而丟棄；只要脫離其他 notes 後仍能獨立理解與檢索，就應收錄。
以可檢索事實的覆蓋率優先於簡短。notes 筆數上限為 min(20, max(12, 對話輪數 × 2))；在上限內完整收錄實際存在的合格事實，不得為達數量填入無具體內容的文字。仍須排除純社交寒暄、無內容的輪次與噪音；沒有合格事實時輸出空陣列。

⚠️ 下面的時間正規化與結構欄位是「對已萃取事實的加值（enrichment）」，不是「萃取什麼」的篩選條件。**絕不可因為某事實沒有日期/數值/可結構化欄位就略過它**；上述收錄廣度（偏好、關係、情緒狀態、決定脈絡等）一字不減，照常收錄為純 text note。

【時間正規化】對話每個 turn 前綴有 [at=<ISO>] 絕對時間戳。當事實含「昨天/今天/明天/上週/下個月/剛才/之後」等相對時間，必須以該事實所在 turn 的 at 為錨，在 text 內寫出絕對日期（例：「在 2023-05-07（原文稱昨天）參加了…」），並填 when 欄位。若 at=unknown 或語意不足以唯一解析，保留原文相對詞、不可猜，when.precision 與 when.source 設為 "unknown"。明確日期、月份、年份、區間、期限、事件先後順序都要保留，不要只寫「最近」「之前」。

每筆格式：
{ "text": "...", "category": "fact|decision|entity|preference|constraint|identity|knowledge|history|business|other", "importance": 0.0-1.0, "tags": ["..."], "subject": "主體（選配）", "predicate": "關係/屬性/動作（選配）", "value": "值，字串/數字/布林（選配）", "unit": "數值單位（選配）", "when": { "start": "YYYY-MM-DD 或 ISO（選配）", "end": "（選配）", "precision": "datetime|date|month|year|range|unknown", "sourceText": "原文時間詞", "source": "explicit|relative_anchored|contextual|unknown", "anchor": "錨定用的 turn ISO 時間" } }
（subject/predicate/value/unit/entities/when 全為選配：有對應資訊才填，沒有就整個省略，不可填空字串或編造。text 仍是主要可讀、可檢索內容；日期、數值、人名、地名、檔案名、產品名、事件名也必須同時寫進 text，能正規化的日期同時寫入 text 與 when。）

收錄：
- 已確認的決策，以及影響決策的關鍵理由、作用域或條件。
- 仍有效的承諾、待辦與計畫；必要時寫明責任人、期限、觸發條件或目前狀態。
- 穩定且可操作的偏好、身份、關係、長期目標與約束（含來源與作用域）。
- 經驗證且不易重新推導的技術結論、環境特性、根因、失敗方案及其原因。
- 對既有記憶的更正、取消或取代；清楚指出何者已失效以及新結論。

不要收錄：
- 問候、稱讚、泛泛建議、對話流程描述、模型自評或「已提供協助」等通用後設敘述。
- 一次性命令、短暫狀態、容易重新查得的通識，或僅為 capsule 敘事服務的細節。
- 尚未確認的猜測、未被接受的方案，或由語氣推測出的身份與偏好。
- 與另一筆 note 意義相同的重述。

寫作要求：
- 一筆只表達一個可獨立更新的主張，必須自足：寫明主體、內容、作用域，以及必要的時間、狀態、條件或理由；不得使用「這個」「上述方案」「已處理」等脫離原文便無法理解的指涉。
- 保留足以語意檢索與回查原始 transcript 的專案、元件、人物或事件名稱，但不要複製整段對話、長篇推理、日誌或操作過程（原文可由 rehydrate 取回）。
- category 選最能代表該主張長期用途者；tags 用少量具辨識力的實體/專案/領域/狀態詞。
- importance 依「跨時間耐久性 × 未來決策效用」評分，不依篇幅、情緒強度或主題是否熱門；較低分代表耐久性或決策效用較低，但不得因此省略可獨立檢索的具體事實。

CRITICAL INSTRUCTION: Output ONLY valid, raw JSON. Do NOT wrap in markdown code blocks. Start with '{' and end with '}'.

confidence 評分標準（0.0–1.0）：
- 0.8+：細節保留完整，能直接回答具體事實（數字、人名、程式碼）
- 0.4–0.7：涵蓋但壓縮率高，細節可能失真或遺漏
- <0.4：只能回答抽象概述，具體數字、名字、檔案名等流失

{
  "analysis": "這裡放任務A的蒸餾草稿...",
  "confidence": 0.85,
  "summary": {
    "primaryRequest": "...",
    "technicalConcepts": "...",
    "filesAndCode": "...",
    "errorsAndFixes": "...",
    "problemSolving": "...",
    "userMessages": "...",
    "pendingTasks": "...",
    "currentWork": "...",
    "nextStep": "..."
  },
  "notes": [
    {
      "text": "精確的顆粒化記憶（含足夠上下文，獨立可理解；日期/數值/人名要寫進 text）",
      "category": "fact|decision|entity|preference|constraint|identity|knowledge|history|business|other",
      "importance": 0.0-1.0,
      "tags": [],
      "subject": "主體（選配，省略則整個不要出現）",
      "predicate": "關係/屬性/動作（選配）",
      "value": "值，字串/數字/布林（選配）",
      "unit": "單位（選配）",
      "when": { "start": "YYYY-MM-DD（選配）", "precision": "date", "sourceText": "原文時間詞", "source": "relative_anchored", "anchor": "turn ISO 時間" }
    }
  ]
}

額外限制：
- notes 筆數上限為 min(20, max(12, 對話輪數 × 2))
- 若輸出即將過長，先縮短 analysis，不可任意刪除合格 notes
- 目標是回傳可完整 JSON.parse 的有效 JSON，不可輸出半截 JSON`;
  return isSourceLanguage ? `${sourceLanguageRequirementTop}\n\n${prompt}\n\n${sourceLanguageRequirementBottom}` : prompt;
}

export function buildGeneralConversationPrompt(conversationLog: string, capsuleLanguage: string = '繁體中文'): string {
  const isSourceLanguage = capsuleLanguage === 'source';
  const sourceLanguageRequirementTop = 'LANGUAGE REQUIREMENT: Write the ENTIRE capsule/前情提要 in the SAME language as the transcript. If the transcript is in English, write the capsule in English. Do NOT default to Chinese. This overrides all other instructions.';
  const sourceLanguageRequirementBottom = 'LANGUAGE REQUIREMENT REMINDER: Write the ENTIRE capsule/前情提要 in the SAME language as the transcript above. If the transcript is in English, write the capsule in English. Do NOT default to Chinese. This overrides all other instructions.';
  const capsuleLanguageInstruction = isSourceLanguage
    ? '用與上方真實對話相同的語言'
    : `用自然流暢的${capsuleLanguage}`;
  const prompt = `你是一個專業的 AI 記憶蒸餾引擎。

你現在要處理的唯一資料來源，是下方提供的真實對話內容。你必須只根據該對話內容蒸餾，不可把本提示中的任務說明、JSON 格式要求、欄位定義、評分規則，誤當成對話事實。

=== BEGIN REAL CONVERSATION ===
${conversationLog}
=== END REAL CONVERSATION ===

【任務 A：蒸餾草稿（analysis scratchpad）】
先仔細閱讀上方真實對話，寫出精簡的分析草稿（限 800 字內）：對話脈絡與進展、關鍵事實、雙方意圖。若輸出吃緊，優先縮短 analysis。

【任務 B：前情提要膠囊（capsule）— 這才是最終產物】
${capsuleLanguageInstruction}寫一段「前情提要」（600–900 字），讓 AI 接手對話時能立刻回到脈絡。必須涵蓋：
- 對話雙方是誰、彼此關係或身份
- 聊了哪些主題、進展到哪
- 確立的具體事實（日期、人名、數字、地點、事件、偏好）—— 必須 fact-faithful：日期依該 turn 的 [at=] 錨成絕對日期（不要只寫「昨天」「上週」）、人名/標題/專名照原文不改寫不譯走樣、數值保留原值與單位
- 做過的決定、計畫、承諾
- 情緒、狀態、關係近況
- 還沒談完或待處理的話題
- 合理的下一步（若有）
寫成連貫敘事，不要分點條列，不要套用程式碼或技術報告格式。

【顆粒化長期記憶（notes）】
從真實對話中提取所有可被獨立詢問與回答的具體事實，包括明確名稱、地點、日期、數值、物件、偏好、決定與結果。不得僅因某項事實看似重要性較低而丟棄；只要脫離其他 notes 後仍能獨立理解與檢索，就應收錄。
以可檢索事實的覆蓋率優先於簡短。notes 筆數上限為 min(20, max(12, 對話輪數 × 2))；在上限內完整收錄實際存在的合格事實，不得為達數量填入無具體內容的文字。仍須排除純社交寒暄、無內容的輪次與噪音；沒有合格事實時輸出空陣列。

⚠️ 下面的時間正規化與結構欄位是「對已萃取事實的加值（enrichment）」，不是「萃取什麼」的篩選條件。**絕不可因為某事實沒有日期/數值/可結構化欄位就略過它**；上述收錄廣度（偏好、關係、情緒狀態、決定脈絡等）一字不減，照常收錄為純 text note。

【時間正規化】對話每個 turn 前綴有 [at=<ISO>] 絕對時間戳。當事實含「昨天/今天/明天/上週/下個月/剛才/之後」等相對時間，必須以該事實所在 turn 的 at 為錨，在 text 內寫出絕對日期（例：「在 2023-05-07（原文稱昨天）參加了…」），並填 when 欄位。若 at=unknown 或語意不足以唯一解析，保留原文相對詞、不可猜，when.precision 與 when.source 設為 "unknown"。明確日期、月份、年份、區間、期限、事件先後順序都要保留，不要只寫「最近」「之前」。

每筆格式：
{ "text": "...", "category": "fact|decision|entity|preference|constraint|identity|knowledge|history|business|other", "importance": 0.0-1.0, "tags": ["..."], "subject": "主體（選配）", "predicate": "關係/屬性/動作（選配）", "value": "值，字串/數字/布林（選配）", "unit": "數值單位（選配）", "when": { "start": "YYYY-MM-DD 或 ISO（選配）", "end": "（選配）", "precision": "datetime|date|month|year|range|unknown", "sourceText": "原文時間詞", "source": "explicit|relative_anchored|contextual|unknown", "anchor": "錨定用的 turn ISO 時間" } }
（subject/predicate/value/unit/entities/when 全為選配：有對應資訊才填，沒有就整個省略，不可填空字串或編造。text 仍是主要可讀、可檢索內容；日期、數值、人名、地名、檔案名、產品名、事件名也必須同時寫進 text，能正規化的日期同時寫入 text 與 when。）

收錄：
- 已確認的決策，以及影響決策的關鍵理由、作用域或條件。
- 仍有效的承諾、待辦與計畫；必要時寫明責任人、期限、觸發條件或目前狀態。
- 穩定且可操作的偏好、身份、關係、長期目標與約束（含來源與作用域）。
- 經驗證且不易重新推導的技術結論、環境特性、根因、失敗方案及其原因。
- 對既有記憶的更正、取消或取代；清楚指出何者已失效以及新結論。

不要收錄：
- 問候、稱讚、泛泛建議、對話流程描述、模型自評或「已提供協助」等通用後設敘述。
- 一次性命令、短暫狀態、容易重新查得的通識，或僅為 capsule 敘事服務的細節。
- 尚未確認的猜測、未被接受的方案，或由語氣推測出的身份與偏好。
- 與另一筆 note 意義相同的重述。

寫作要求：
- 一筆只表達一個可獨立更新的主張，必須自足：寫明主體、內容、作用域，以及必要的時間、狀態、條件或理由；不得使用「這個」「上述方案」「已處理」等脫離原文便無法理解的指涉。
- 保留足以語意檢索與回查原始 transcript 的專案、元件、人物或事件名稱，但不要複製整段對話、長篇推理、日誌或操作過程（原文可由 rehydrate 取回）。
- category 選最能代表該主張長期用途者；tags 用少量具辨識力的實體/專案/領域/狀態詞。
- importance 依「跨時間耐久性 × 未來決策效用」評分，不依篇幅、情緒強度或主題是否熱門；較低分代表耐久性或決策效用較低，但不得因此省略可獨立檢索的具體事實。

CRITICAL INSTRUCTION: Output ONLY valid, raw JSON. Do NOT wrap in markdown code blocks. Start with '{' and end with '}'.

confidence 評分標準（0.0–1.0）：
- 0.8+：細節保留完整，能直接回答具體事實（日期、人名、數字）
- 0.4–0.7：涵蓋但壓縮率高，細節可能失真
- <0.4：只能回答抽象概述

{
  "analysis": "任務A的草稿...",
  "confidence": 0.85,
  "capsule": "任務B的自然語言前情提要...",
  "notes": [
    { "text": "精確的顆粒化記憶（含足夠上下文，獨立可理解；日期/數值/人名要寫進 text）", "category": "fact|decision|entity|preference|constraint|identity|knowledge|history|business|other", "importance": 0.0, "tags": [], "subject": "（選配，省略則不要出現）", "predicate": "（選配）", "value": "（選配）", "unit": "（選配）", "when": { "start": "YYYY-MM-DD（選配）", "precision": "date", "sourceText": "原文時間詞", "source": "relative_anchored", "anchor": "turn ISO 時間" } }
  ]
}

額外限制：
- notes 筆數上限為 min(20, max(12, 對話輪數 × 2))
- 若輸出即將過長，先縮短 analysis，不可任意刪除合格 notes
- 必須回傳可完整 JSON.parse 的有效 JSON，不可輸出半截 JSON`;
  return isSourceLanguage ? `${sourceLanguageRequirementTop}\n\n${prompt}\n\n${sourceLanguageRequirementBottom}` : prompt;
}

// ─── 降級版 Prompt (專供本地小模型使用) ───
export function buildSimplePrompt(conversationLog: string, capsuleLanguage: string = '繁體中文'): string {
  if (capsuleLanguage === 'source') {
    const sourceLanguageRequirementTop = 'LANGUAGE REQUIREMENT: Write the ENTIRE capsule/前情提要 in the SAME language as the transcript. If the transcript is in English, write the capsule in English. Do NOT default to Chinese. This overrides all other instructions.';
    const sourceLanguageRequirementBottom = 'LANGUAGE REQUIREMENT REMINDER: Write the ENTIRE capsule/前情提要 in the SAME language as the transcript above. If the transcript is in English, write the capsule in English. Do NOT default to Chinese. This overrides all other instructions.';
    return `${sourceLanguageRequirementTop}\n\n你是一個專業的 AI 記憶摘要引擎。請仔細閱讀以下對話，並輸出一段 500 字以內的純文字「前情提要」（包含使用者的核心請求、已解決的問題、以及接下來的待辦清單）。
請直接輸出純文字，絕對不要包含任何 markdown 或 JSON 格式：\n\n${conversationLog}\n\n${sourceLanguageRequirementBottom}`;
  }
  return `你是一個專業的 AI 記憶摘要引擎。請仔細閱讀以下對話，並輸出一段 500 字以內的純文字「前情提要」（包含使用者的核心請求、已解決的問題、以及接下來的待辦清單）。
請直接輸出純文字，絕對不要包含任何 markdown 或 JSON 格式：\n\n${conversationLog}`;
}

// ─── Token 估算引擎 ───

function getComplexityFactor(msg: ContextMessage): number {
  const content = extractTokenEstimationText(msg).combined;
  // 使用 \x60 防禦 UI 崩潰
  if (/\x60\x60\x60[\s\S]*?\x60\x60\x60/.test(content)) return 1.5;
  if (/[\u4e00-\u9fff]/.test(content)) return 1.4;
  return 1.0;
}

function extractTextLeafValues(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractTextLeafValues(item));
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((item) => extractTextLeafValues(item));
  }
  return [];
}

function extractTokenEstimationText(msg: ContextMessage): { realText: string; toolText: string; combined: string } {
  const role = String(msg.role || '');

  if (typeof msg.content === 'string') {
    const text = msg.content.trim();
    if (role === 'tool' || role === 'function') {
      return { realText: '', toolText: text, combined: text };
    }
    return { realText: text, toolText: '', combined: text };
  }

  if (!Array.isArray(msg.content)) {
    return { realText: '', toolText: '', combined: '' };
  }

  const realParts: string[] = [];
  const toolParts: string[] = [];

  for (const part of msg.content) {
    if (!part || typeof part !== 'object') continue;

    if (typeof part.text === 'string' && part.text.trim()) {
      if (role === 'tool' || role === 'function') {
        toolParts.push(part.text.trim());
      } else {
        realParts.push(part.text.trim());
      }
    }

    if (part.type === 'tool_use') {
      const inputText = extractTextLeafValues((part as Record<string, unknown>).input).join('\n').trim();
      if (inputText) {
        toolParts.push(inputText);
      }
    }
  }

  const realText = realParts.join('\n').trim();
  const toolText = toolParts.join('\n').trim();
  const combined = [realText, toolText].filter(Boolean).join('\n').trim();

  return { realText, toolText, combined };
}

function estimateTextTokens(text: string, complexityFactor: number): number {
  if (!text) return 0;
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
  const nonCjkChars = text.length - cjkChars;
  const baseTokens = (cjkChars * 1.5) + (nonCjkChars * 0.25);
  return Math.ceil(baseTokens * complexityFactor * (4 / 3));
}

function estimateTokenBreakdownForMessage(msg: ContextMessage): { realTokens: number; toolTokens: number; total: number } {
  const { realText, toolText } = extractTokenEstimationText(msg);
  const complexityFactor = getComplexityFactor(msg);
  const realTokens = estimateTextTokens(realText, complexityFactor);
  const toolTokens = estimateTextTokens(toolText, complexityFactor);
  return { realTokens, toolTokens, total: realTokens + toolTokens };
}

function estimateTokenCount(msg: ContextMessage): number {
  return estimateTokenBreakdownForMessage(msg).total;
}

function estimateTotalTokens(messages: ContextMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokenCount(m), 0);
}

function estimateTotalTokenBreakdown(messages: ContextMessage[]): { realTokens: number; toolTokens: number; total: number } {
  return messages.reduce(
    (acc, msg) => {
      const next = estimateTokenBreakdownForMessage(msg);
      acc.realTokens += next.realTokens;
      acc.toolTokens += next.toolTokens;
      acc.total += next.total;
      return acc;
    },
    { realTokens: 0, toolTokens: 0, total: 0 }
  );
}

function estimatePromptTokens(text: string): number {
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
  const nonCjkChars = text.length - cjkChars;
  return Math.ceil((cjkChars * 1.5 + nonCjkChars * 0.25) * (4 / 3));
}

function truncatePromptToTokenBudget(prompt: string, maxInputTokens: number): string {
  if (estimatePromptTokens(prompt) <= maxInputTokens) return prompt;

  let left = 0;
  let right = prompt.length;
  let best = '';

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const candidate = prompt.slice(0, mid) + '\n\n...[對話過長已截斷，請基於以上內容進行摘要]...';
    const estimated = estimatePromptTokens(candidate);
    if (estimated <= maxInputTokens) {
      best = candidate;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return best || '\n\n...[對話過長已截斷，請基於以上內容進行摘要]...';
}

function classifyConcentratorFailure(err: unknown): ConcentratorFailureReason {
  const message = String((err as any)?.message ?? err ?? '').toLowerCase();
  if (message.includes('json') || message.includes('parse') || message.includes('invalid')) return 'broken_json';
  if (message.includes('timeout') || message.includes('timed out') || message.includes('abort')) return 'timeout';
  if (message.includes('quota') || message.includes('429') || message.includes('rate limit')) return 'quota';
  return 'other';
}

const GEMINI_503_BREAKER_THRESHOLD = 3;
const GEMINI_503_COOLDOWN_MS = 90_000;

let geminiConsecutive503Count = 0;
let geminiCooldownUntil = 0;

function isGemini503Error(err: unknown): boolean {
  const message = String((err as any)?.message ?? err ?? '').toLowerCase();
  return message.includes('gemini api error: 503');
}

function extractBalancedObjectForKey(text: string, key: string): string | null {
  const keyIndex = text.indexOf(`"${key}"`);
  if (keyIndex === -1) return null;
  const braceStart = text.indexOf('{', keyIndex);
  if (braceStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = braceStart; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth++;
    if (ch === '}') depth--;

    if (depth === 0) {
      return text.slice(braceStart, i + 1);
    }
  }

  return null;
}

function salvageSummaryObject(jsonLike: string): Record<string, string> | null {
  const obj = extractBalancedObjectForKey(jsonLike, 'summary');
  if (!obj) return null;
  try {
    const parsed = JSON.parse(obj);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function resolveConcentratorTimeZone(timezone?: string): string {
  const candidate = timezone ?? (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  })();

  try {
    new Intl.DateTimeFormat(undefined, { timeZone: candidate });
    return candidate;
  } catch {
    return 'UTC';
  }
}

function formatTimestampWithTimeZone(timestamp: number, timezone: string): string | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;

  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMinutes = Math.round((wallClockAsUtc - date.getTime()) / 60000);
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const offsetAbs = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(offsetAbs / 60)).padStart(2, '0');
  const offsetRemainder = String(offsetAbs % 60).padStart(2, '0');

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offsetSign}${offsetHours}:${offsetRemainder}`;
}

// ─── API 呼叫包裝 ───

async function callGeminiAPI(
  apiKey: string,
  model: string,
  prompt: string,
  maxTokens: number = 8192,
): Promise<string> {
  await sharedLLMRateLimiter.acquire('gemini');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens },
    }),
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const errBody = await response.json() as any;
      detail = errBody?.error?.message || errBody?.error?.status || JSON.stringify(errBody?.error || errBody);
    } catch {}
    throw new Error(`Gemini API error: ${response.status} — ${detail}`);
  }
  const data = await response.json() as any;
  if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
    return data.candidates[0].content.parts[0].text.trim();
  }
  // Thinking responses may not put the answer at parts[0]; scan all non-thought
  // parts for text before giving up.
  const parts = data.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const text = parts
      .filter((part: any) => part && typeof part.text === 'string' && part.thought !== true)
      .map((part: any) => part.text)
      .join('\n')
      .trim();
    if (text) return text;
  }
  throw new Error('Invalid Gemini API response');
}

async function callDeepSeekAPI(apiKey: string, model: string, prompt: string, maxTokens: number = 8192): Promise<string> {
  await sharedLLMRateLimiter.acquire('deepseek');
  const url = `https://api.deepseek.com/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [{ role: 'user', content: prompt + "\n請直接輸出 JSON，不要包含 markdown 標籤。" }],
    }),
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const errBody = await response.json() as any;
      detail = errBody?.error?.message || errBody?.error?.type || JSON.stringify(errBody?.error || errBody);
    } catch {}
    throw new Error(`DeepSeek API error: ${response.status} — ${detail}`);
  }
  const data = await response.json() as any;
  const messageContent = data.choices?.[0]?.message?.content;
  if (typeof messageContent === 'string' && messageContent.trim()) {
    return messageContent.trim();
  }
  if (Array.isArray(messageContent)) {
    const text = messageContent
      .map((part: any) => {
        if (!part || typeof part !== 'object') return '';
        if (typeof part.text === 'string') return part.text;
        if (part.type === 'text' && typeof part.content === 'string') return part.content;
        return '';
      })
      .join('\n')
      .trim();
    if (text) return text;
  }
  // Reasoning models (deepseek-v4-pro, and occasionally flash) can return an
  // empty message.content with the real output in reasoning_content. Fall back
  // to it; the JSON salvage logic downstream tolerates surrounding CoT text.
  const reasoning = data.choices?.[0]?.message?.reasoning_content;
  if (typeof reasoning === 'string' && reasoning.trim()) {
    return reasoning.trim();
  }
  throw new Error('Invalid DeepSeek response');
}

// ─── Public types & class ───

export interface ConcentratorConfig {
  apiKey: string;
  model: string;
  inboxPath: string;
  timezone?: string;
  capsuleCategory?: string;
  /**
   * Language for the capsule (前情提要). Default '繁體中文' preserves the
   * Chinese-first benchmark behavior. Pass 'source' to make the distiller
   * write the capsule in the same language as the conversation (otter use).
   */
  capsuleLanguage?: string;
  concentrationTarget?: number;
  provider?: 'gemini' | 'deepseek';
  maxTokens?: number;
  deepseekApiKey?: string;
  deepseekModel?: string;
  statsStore?: Pick<MemoryStore, 'recordConcentratorStat'>;
  transcriptArchive: TranscriptArchive;
  sessionSummaryDir: string;
  llm?: LlmClient;
}

export interface CapsuleOutput {
  messages: ContextMessage[];
  wasConcentrated: boolean;
  summary?: string;
  processedThroughIndex?: number;
}

export class ConcentratorAdapter implements LlmClient {
  private config: Required<Omit<ConcentratorConfig, 'statsStore' | 'transcriptArchive' | 'llm'>>;
  private capsuleBridge: CapsuleBridge;
  private statsStore?: Pick<MemoryStore, 'recordConcentratorStat'>;
  private transcriptArchive: TranscriptArchive;
  private llm?: LlmClient;
  private readonly MAX_CONTEXT_WINDOW = 200000; 

  // ── 動態水位線常數 ──────────────────────────────────────
  private static readonly WATERLINE_CODE    = 0.40; // 代碼/技術密集：40%
  private static readonly WATERLINE_DEFAULT = 0.50; // 通用預設：50%

  constructor(config: ConcentratorConfig) {
    this.config = {
      apiKey: config.apiKey,
      model: config.model,
      inboxPath: config.inboxPath,
      capsuleCategory: config.capsuleCategory ?? 'history',
      capsuleLanguage: config.capsuleLanguage ?? '繁體中文',
      concentrationTarget: config.concentrationTarget ?? 0,
      provider: config.provider ?? 'gemini',
      maxTokens: config.maxTokens ?? 8192,
      deepseekApiKey: config.deepseekApiKey || '',
      deepseekModel: config.deepseekModel ?? 'deepseek-v4-flash',
      sessionSummaryDir: config.sessionSummaryDir,
      timezone: resolveConcentratorTimeZone(config.timezone),
    };
    this.statsStore = config.statsStore;
    this.transcriptArchive = config.transcriptArchive;
    this.llm = config.llm;
    this.capsuleBridge = new CapsuleBridge(this.config.inboxPath);
  }

  /**
   * 動態水位線偵測器：分析最近 30 則訊息判斷對話模式
   * - code:    code block 密度 ≥ 15% 或 toolResult 佔比 ≥ 25%
   * - default: 其餘情況
   */
  private detectConversationMode(messages: ContextMessage[]): { mode: 'code' | 'default'; waterline: number; reason: string } {
    const rawSample = messages.slice(-Math.min(30, messages.length));
    if (rawSample.length === 0) {
      return { mode: 'default', waterline: ConcentratorAdapter.WATERLINE_DEFAULT, reason: '無訊息' };
    }

    // 過濾掉 tool/function/tool_result — 這些是 OpenClaw infrastructure 噪音，不代表對話模式
    const contentSample = rawSample.filter(msg => {
      const role = msg.role as string;
      return role !== 'tool' && role !== 'function' && role !== 'toolResult' && role !== 'tool_result';
    });
    if (contentSample.length === 0) {
      return { mode: 'default', waterline: ConcentratorAdapter.WATERLINE_DEFAULT, reason: '全是工具訊息' };
    }

    let totalChars = 0;
    let codeBlockChars = 0;

    for (const msg of contentSample) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
      totalChars += content.length;

      const codeBlocks = content.match(/```[\s\S]*?```/g);
      if (codeBlocks) {
        codeBlockChars += codeBlocks.reduce((sum, block) => sum + block.length, 0);
      }
    }

    const codeBlockRatio = totalChars > 0 ? codeBlockChars / totalChars : 0;

    if (codeBlockRatio >= 0.15) {
      const reason = `code block 佔比 ${(codeBlockRatio * 100).toFixed(1)}%`;
      return { mode: 'code', waterline: ConcentratorAdapter.WATERLINE_CODE, reason };
    }

    return { mode: 'default', waterline: ConcentratorAdapter.WATERLINE_DEFAULT, reason: '通用對話' };
  }

  buildFallbackCapsule(messages: ContextMessage[]): string {
    const cleaned = preFilterForConcentration(messages)
      .map((m) => ({
        role: m.role,
        text: sanitizeForFallbackSummary(extractTextForConcentrationContent(m.content)),
      }))
      .filter((m) => m.text.length > 0);

    const windowed = selectRecentFallbackWindow(cleaned);

    const userMessages = windowed
      .filter((m) => m.role === 'user')
      .map((m) => m.text)
      .slice(0, 3);
    const assistantMessages = windowed
      .filter((m) => m.role === 'assistant')
      .map((m) => m.text)
      .slice(-3);

    const primaryRequest = userMessages[0] || '無';
    const latestAssistant = assistantMessages[assistantMessages.length - 1] || '無';
    const currentWork = assistantMessages.length > 0 ? assistantMessages.join('\n') : '無';
    const userSummary = userMessages.length > 0 ? userMessages.join('\n') : '無';

    return [
      `## 1. Primary Request and Intent\n${primaryRequest}`,
      `## 2. Key Technical Concepts\n無`,
      `## 3. Files and Code Sections\n無`,
      `## 4. Errors and Fixes\n濃縮模型 fallback 失敗，改用本地 deterministic 摘要`,
      `## 5. Problem Solving\n依據對話順序保留主要使用者請求與近期 assistant 回應`,
      `## 6. All User Messages\n${userSummary}`,
      `## 7. Pending Tasks\n無`,
      `## 8. Current Work\n${currentWork}`,
      `## 9. Optional Next Step\n${latestAssistant === '無' ? '無' : latestAssistant}`,
    ].join('\n\n');
  }

  async concentrate(
    rawMessages: ContextMessage[],
    dryRun: boolean = false,
    force: boolean = false,
    context: ConcentrateContext = {},
  ): Promise<CapsuleOutput> {
    
    const messages = rawMessages.map(msg => truncateGiantStrings(msg));
    const currentTokens = estimateTotalTokens(messages);
    
    // 🎯 動態水位線引擎：根據對話模式自動調整觸發門檻
    const { mode, waterline, reason } = this.detectConversationMode(messages);
    const dynamicTarget = this.config.concentrationTarget > 0 
      ? this.config.concentrationTarget 
      : Math.floor(this.MAX_CONTEXT_WINDOW * waterline);

    const needsCut = force || (currentTokens >= dynamicTarget);

    if (!needsCut) {
      return { messages, wasConcentrated: false, processedThroughIndex: 0 };
    }

    if (!this.llm && !this.config.apiKey && !this.config.deepseekApiKey) {
      console.warn('[ConcentratorAdapter] Concentration skipped: no LLM API key configured; raw transcripts and recall remain available.');
      return { messages, wasConcentrated: false, processedThroughIndex: 0 };
    }

    let cutEndIndex = 0;
    if (force) {
      if (context.exhaustive === true) {
        cutEndIndex = messages.length;
      } else {
        cutEndIndex = Math.max(0, messages.length - Math.min(messages.length, 5));
        if (cutEndIndex === 0 && messages.length > 0) cutEndIndex = messages.length;
      }
    } else {
      let keptTokens = 0;
      let keepCount = 0;
      const safeBufferTokens = 20000; 
      for (let i = messages.length - 1; i >= 0; i--) {
        const msgTokens = estimateTokenCount(messages[i]);
        if (keptTokens + msgTokens > safeBufferTokens) break;
        keptTokens += msgTokens;
        keepCount++;
      }
      keepCount = Math.max(2, keepCount); 
      cutEndIndex = Math.max(0, messages.length - keepCount);
      console.log(`[ConcentratorAdapter] Dynamic watermark triggered [${mode}] ${(waterline * 100).toFixed(0)}% (${currentTokens}/${dynamicTarget} tokens) - ${reason}`);
    }

    const newMessages: ContextMessage[] = [];
    const messagesToSummarize: ContextMessage[] = [];
    let hasModified = false;
    let capsuleText = '';   

      for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      let cleanMsg = JSON.parse(JSON.stringify(msg));
      cleanMsg = stripThinkingBlocks(cleanMsg);

      // 🛡️ 核心修復 1：System 訊息擁有「絕對免死金牌」
      // 只要是系統提示詞，無論新舊，一律無條件保留，且不參與濃縮！
      if (msg.role === 'system') {
        newMessages.push(cleanMsg);
        continue;
      }

      // 新訊息（近期對話）：直接保留
      if (i >= cutEndIndex) {
        newMessages.push(cleanMsg);
        continue;
      }

      // 舊訊息（準備被濃縮）：排除 SystemExecInjection (因為沒營養)
      if (!isSystemExecInjection(msg)) {
        messagesToSummarize.push(cleanMsg);
      }
    }

    // 收集被壓縮訊息的時間戳範圍（供 capsule metadata 使用）
    const summarizeTimestamps = messagesToSummarize
      .map(m => m.timestamp)
      .filter((t): t is number => typeof t === 'number' && t > 0);
    const firstTimestamp = summarizeTimestamps.length > 0 ? Math.min(...summarizeTimestamps) : Date.now();
    const lastTimestamp  = summarizeTimestamps.length > 0 ? Math.max(...summarizeTimestamps) : Date.now();

    const sourceEntryIdsProbe = probeSourceEntryIdMatch(
      this.transcriptArchive,
      messagesToSummarize,
      context.sessionIdentity,
      firstTimestamp,
      lastTimestamp,
    );

    if (sourceEntryIdsProbe) {
      console.log(
        `[ConcentratorAdapter][P0-1 probe] summarizeMessages=${messagesToSummarize.length} summarizePairs=${sourceEntryIdsProbe.summarizePairCount} candidateCount=${sourceEntryIdsProbe.candidateCount} matched=${sourceEntryIdsProbe.matched} reason=${sourceEntryIdsProbe.reason ?? 'ok'} matchedEntryIds=${sourceEntryIdsProbe.matchedEntryIds.join(',') || 'none'} sourceEntryIds=${sourceEntryIdsProbe.sourceEntryIds.join(',') || 'none'} firstTimestamp=${firstTimestamp} lastTimestamp=${lastTimestamp} canonicalKey=${context.sessionIdentity?.canonicalKey ?? 'unknown'}`
      );
    } else {
      console.log(
        `[ConcentratorAdapter][P0-1 probe] summarizeMessages=${messagesToSummarize.length} summarizePairs=0 candidateCount=0 matched=false reason=archive_lag matchedEntryIds=none firstTimestamp=${firstTimestamp} lastTimestamp=${lastTimestamp} canonicalKey=unknown sessionIdentity=missing`
      );
    }

    if (messagesToSummarize.length > 0) {
      try {
        // 👇 四層完美過濾濾網啟動！
        const filteredForLLM = preFilterForConcentration(messagesToSummarize);

        const conversationLog = filteredForLLM
          .map(m => {
            const text = stripFrameworkMetadataForConcentration(extractTextForConcentrationContent(m.content));
            if (!text || isFrameworkMetadataForConcentration(text.trim())) return null;
            // Prefix each turn with its absolute timestamp so the distiller can anchor
            // relative time words ("昨天"/"上週") to a real date instead of dropping them.
            const ts = (m as any).timestamp;
            let at = 'unknown';
            if (typeof ts === 'number' && Number.isFinite(ts)) {
              at = formatTimestampWithTimeZone(ts, this.config.timezone) ?? 'unknown';
            }
            return `[at=${at}] ${m.role.toUpperCase()}: ${text}`;
          })
          .filter((line): line is string => !!line && line.trim().length > 0)
          .join('\n\n');

        const prompt = mode === 'code'
          ? buildDualTrackPrompt(conversationLog, this.config.capsuleLanguage)
          : buildGeneralConversationPrompt(conversationLog, this.config.capsuleLanguage);
        const simplePrompt = buildSimplePrompt(conversationLog, this.config.capsuleLanguage);
        if (!conversationLog.trim()) {
          console.warn('[ConcentratorAdapter] conversationLog is empty; compaction input may lack actual conversation content');
        }
        let generatedJSON = '';

        try {
          // 傳入雙軌 prompt 與降級 simplePrompt
          generatedJSON = await this.callWithFallback(prompt, 'concentrate', simplePrompt, {
            sessionIdentity: context.sessionIdentity,
            inputTokens: currentTokens,
          });
        } catch (err) {
          console.error("[ConcentratorAdapter] Compaction failed:", err);
          const fallbackCapsule = this.buildFallbackCapsule(filteredForLLM);
          console.warn('[ConcentratorAdapter] Enabling local deterministic fallback capsule');
          generatedJSON = JSON.stringify({
            capsule: fallbackCapsule,
            notes: [],
            confidence: 0.2,
          });
        }

        // ==========================================
        // 🛡️ 無敵 JSON 暴力萃取器 + 🚑 Regex 救生艇
        // ==========================================
        let parsedData: any = { capsule: '', notes: [] }; 
        let jsonString = generatedJSON.trim();
        
        try {
          parsedData = JSON.parse(jsonString);
        } catch (e) {
          const startIdx = Math.min(
            jsonString.indexOf('{') === -1 ? Infinity : jsonString.indexOf('{'),
            jsonString.indexOf('[') === -1 ? Infinity : jsonString.indexOf('[')
          );
          const endIdx = Math.max(jsonString.lastIndexOf('}'), jsonString.lastIndexOf(']'));

          if (startIdx !== Infinity && endIdx !== -1 && startIdx < endIdx) {
            const strippedJson = jsonString.substring(startIdx, endIdx + 1);
            try {
              parsedData = JSON.parse(strippedJson);
            } catch (err) {
              console.error(`[ConcentratorAdapter] Parsing still failed after stripping; extracted string:\n${strippedJson}`);
              // 🚑 終極急救艇：就算 JSON 斷頭斷尾，也要把最重要的前情提要挖出來！
              const salvagedSummary = salvageSummaryObject(jsonString);
              if (salvagedSummary) {
                parsedData.summary = salvagedSummary;
                console.log(`[ConcentratorAdapter] Recovery succeeded: extracted summary structure`);
              } else {
                const capMatch = jsonString.match(/"capsule"\s*:\s*"([\s\S]*?)"\s*,\s*"notes"/);
                if (capMatch && capMatch[1]) {
                  parsedData.capsule = capMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
                  console.log(`[ConcentratorAdapter] Recovery succeeded: extracted ${parsedData.capsule.length}-character summary`);
                }
              }
            }
          } else {
            console.warn(`[ConcentratorAdapter] Abandoning parse and returning fallback. Original string: ${jsonString.substring(0, 100)}...`);
            // 🚑 終極急救艇：無括號狀態下的搶救
            const salvagedSummary = salvageSummaryObject(jsonString);
            if (salvagedSummary) {
              parsedData.summary = salvagedSummary;
              console.log(`[ConcentratorAdapter] Bracketless recovery succeeded: extracted summary structure`);
            } else {
              const capMatch = jsonString.match(/"capsule"\s*:\s*"([\s\S]*?)"\s*,\s*"notes"/);
              if (capMatch && capMatch[1]) {
                parsedData.capsule = capMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
                console.log(`[ConcentratorAdapter] Bracketless recovery succeeded: extracted ${parsedData.capsule.length}-character summary`);
              }
            }
          }
        }

        // 提取 confidence（LLM 自評保真度）
        const confidence: number = typeof parsedData.confidence === 'number'
          ? Math.max(0, Math.min(1, parsedData.confidence))
          : 0.7; // 舊格式或解析失敗時預設中等

        // Compose capsule from 9-section summary (新結構) 或 legacy capsule
        const summary = parsedData.summary;
        if (summary && typeof summary === 'object') {
          const sections = [
            `## 1. Primary Request and Intent\n${summary.primaryRequest || '無'}`,
            `## 2. Key Technical Concepts\n${summary.technicalConcepts || '無'}`,
            `## 3. Files and Code Sections\n${summary.filesAndCode || '無'}`,
            `## 4. Errors and Fixes\n${summary.errorsAndFixes || '無'}`,
            `## 5. Problem Solving\n${summary.problemSolving || '無'}`,
            `## 6. All User Messages\n${summary.userMessages || '無'}`,
            `## 7. Pending Tasks\n${summary.pendingTasks || '無'}`,
            `## 8. Current Work\n${summary.currentWork || '無'}`,
            `## 9. Optional Next Step\n${summary.nextStep || '無'}`,
          ];
          capsuleText = sections.join('\n\n');
        } else {
          // Fallback: legacy capsule field
          capsuleText = parsedData.capsule || parsedData.analysis || '';
        }
        const originalTokens = estimatePromptTokens(conversationLog);
        const summaryTokens = estimatePromptTokens(capsuleText);
        const compressionRatio = originalTokens / Math.max(1, summaryTokens);
        const notes = parsedData.notes || [];
        const sourceEntryIds = sourceEntryIdsProbe?.matched ? sourceEntryIdsProbe.sourceEntryIds : [];
        const sourceEntryRange = sourceEntryIds.length > 0
          ? {
              firstEntryId: sourceEntryIds[0],
              lastEntryId: sourceEntryIds[sourceEntryIds.length - 1],
              count: sourceEntryIds.length,
            }
          : undefined;

        if (capsuleText) {
          await this.capsuleBridge.writeToInbox("【前情提要】\n" + capsuleText, {
            category: this.config.capsuleCategory,
            importance: 0.8,
            metadata: {
              type: 'dynamic_capsule',
              health: 30,
              lastConcentratedAt: Date.now(),
              confidence,
              compressionRatio,
              firstTimestamp,
              lastTimestamp,
              ...(sourceEntryIds.length > 0 ? { sourceEntryIds } : {}),
              ...(sourceEntryRange ? { sourceEntryRange } : {}),
            }
          });
          console.log(
            `[ConcentratorAdapter] sourceEntryIds metadata: length=${sourceEntryIds.length} firstEntryId=${sourceEntryRange?.firstEntryId ?? 'none'} lastEntryId=${sourceEntryRange?.lastEntryId ?? 'none'}`
          );
          console.log(`[ConcentratorAdapter] Short-term capsule written (health: 30, confidence: ${confidence.toFixed(2)})`);
        }

        const acceptedNoteTexts: string[] = [];
        for (const item of notes) {
          const text = typeof item.text === 'string' ? item.text.trim() : '';
          const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
          const grams = new Set(Array.from({ length: Math.max(0, normalized.length - 1) }, (_, i) => normalized.slice(i, i + 2)));
          const isDuplicate = acceptedNoteTexts.some((existing) => {
            if (existing === normalized) return true;
            const existingGrams = new Set(Array.from({ length: Math.max(0, existing.length - 1) }, (_, i) => existing.slice(i, i + 2)));
            const overlap = [...grams].filter((gram) => existingGrams.has(gram)).length;
            return overlap / Math.max(1, grams.size + existingGrams.size - overlap) >= 0.8;
          });
          if (text && passesConcentratorNoteImportanceFilter(item) && !isDuplicate) {
            acceptedNoteTexts.push(normalized);
            await this.capsuleBridge.writeToInbox(text, {
              category: item.category || 'fact',
              importance: item.importance,
              metadata: {
                tags: item.tags || [],
                health: 100,
                lastConcentratedAt: Date.now(),
                confidence,
                firstTimestamp,
                lastTimestamp,
                ...(sourceEntryIds.length > 0 ? { sourceEntryIds } : {}),
                ...(sourceEntryRange ? { sourceEntryRange } : {}),
                // Optional structured enrichment — additive, stored as-is (no schema change),
                // with shape guards so a malformed LLM value never pollutes metadata.
                // NOTE: no `entities` here — graph entities are generated downstream by
                // inbox-watcher and would overwrite it; entity-relations are the graph's job.
                ...(typeof item.subject === 'string' && item.subject ? { subject: item.subject } : {}),
                ...(typeof item.predicate === 'string' && item.predicate ? { predicate: item.predicate } : {}),
                ...(['string', 'number', 'boolean'].includes(typeof item.value) ? { value: item.value } : {}),
                ...(typeof item.unit === 'string' && item.unit ? { unit: item.unit } : {}),
                ...(item.when && typeof item.when === 'object' && !Array.isArray(item.when) ? { when: item.when } : {}),
              }
            });
          }
        }
        if (notes.length > 0) {
            console.log(`[ConcentratorAdapter] ${notes.length} precise memory notes written`);
        }
        hasModified = true;

        // Write session summary JSON
        // Phase 4-4：sessionId 優先從 sessionIdentity 取，避免從 rawMessages[0]
        // 這種側通道猜（rawMessages 不一定每筆都掛 sessionId）
        const sessionId =
          context.sessionIdentity?.sessionId
          || (rawMessages[0] as any)?.sessionId
          || 'unknown';
        const concentratedAt = Date.now();
        await this.writeSessionSummary({ sessionId, concentratedAt, capsule: capsuleText, notes: parsedData.notes || [], primaryRequest: summary?.primaryRequest || '', pendingTasks: summary?.pendingTasks || '', nextStep: summary?.nextStep || '' });

      } catch (err) {
        console.error("[ConcentratorAdapter] Compaction failed:", err);
      }
    }

    let finalizedMessages = finalizeMessages(newMessages);

    if (capsuleText) {
      finalizedMessages = finalizedMessages.filter(m => !(m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('【前情提要】')));
      
      const summarySystemMsg: ContextMessage = {
        role: 'system',
        content: "【前情提要】\n前面的對話已被壓縮，以下是近期歷史詳細摘要，請將其作為背景脈絡繼續對話：\n" + capsuleText,
        timestamp: Date.now(),
      };

      let insertIdx = 0;
      finalizedMessages.splice(insertIdx, 0, summarySystemMsg);
      console.log("[ConcentratorAdapter] Summary injected at the top of context");
    }

    return { messages: finalizedMessages, wasConcentrated: hasModified || needsCut, summary: capsuleText, processedThroughIndex: cutEndIndex };
  }

  estimateTokens(messages: ContextMessage[]): number {
    return estimateTotalTokens(messages);
  }

  estimateTokenBreakdown(messages: ContextMessage[]): { realTokens: number; toolTokens: number; total: number } {
    return estimateTotalTokenBreakdown(messages);
  }

  /**
   * Provider 輪替 fallback 核心方法
   * 依序嘗試 gemini → deepseek，任一成功即返回
   * Gemini 若連續 3 次 503，冷卻 90 秒內直接跳過
   */
  private async callWithFallback(
    prompt: string,
    fnName: string = 'generate',
    fallbackPrompt?: string, // concentrate 失敗時由呼叫端接 deterministic capsule；此處不處理
    metricContext?: { sessionIdentity?: SessionIdentity; inputTokens?: number },
    maxTokens: number = this.config.maxTokens,
  ): Promise<string> {
    if (this.llm) {
      return this.llm.generate(prompt, { purpose: fnName, maxTokens });
    }

    const providers: ConcentratorProvider[] = [];
    const now = Date.now();
    if (now < geminiCooldownUntil) {
      console.warn(`[${fnName}] gemini skipped: circuit breaker cooling down for ${Math.ceil((geminiCooldownUntil - now) / 1000)}s`);
    } else {
      providers.push('gemini');
    }
    providers.push('deepseek');
    const attemptedProviders: ConcentratorProvider[] = [];
    const startedAt = Date.now();
    const shouldRecordMetric = fnName === 'concentrate';
    let lastError: any = null;

    for (const provider of providers) {
      attemptedProviders.push(provider);
      try {
        if (provider === 'gemini') {
          if (this.config.apiKey) {
            const result = await this.callProvider(provider, prompt, maxTokens);
            geminiConsecutive503Count = 0;
            await this.recordConcentratorAttemptMetric({
              metricContext,
              provider,
              outcome: 'success',
              attemptedProviders,
              inputTokens: metricContext?.inputTokens ?? estimatePromptTokens(prompt),
              outputTokens: estimatePromptTokens(result),
              durationMs: Date.now() - startedAt,
            }, shouldRecordMetric);
            return result;
          }
          console.warn(`[${fnName}] gemini skipped: no API key`);
          continue;
        }
        if (provider === 'deepseek') {
          if (this.config.deepseekApiKey) {
            const result = await this.callProvider(provider, prompt, maxTokens);
            await this.recordConcentratorAttemptMetric({
              metricContext,
              provider,
              outcome: 'success',
              attemptedProviders,
              inputTokens: metricContext?.inputTokens ?? estimatePromptTokens(prompt),
              outputTokens: estimatePromptTokens(result),
              durationMs: Date.now() - startedAt,
            }, shouldRecordMetric);
            return result;
          }
          console.warn(`[${fnName}] deepseek skipped: no API key`);
          continue;
        }
      } catch (err) {
        console.warn(`[${fnName}] ${provider} failed; trying next provider:`, err);
        if (provider === 'gemini') {
          if (isGemini503Error(err)) {
            geminiConsecutive503Count += 1;
            if (geminiConsecutive503Count >= GEMINI_503_BREAKER_THRESHOLD) {
              geminiCooldownUntil = Date.now() + GEMINI_503_COOLDOWN_MS;
              console.warn(`[${fnName}] gemini circuit breaker opened for ${GEMINI_503_COOLDOWN_MS / 1000}s after ${geminiConsecutive503Count} consecutive 503s`);
            }
          } else {
            geminiConsecutive503Count = 0;
          }
        }
        lastError = err;
      }
    }
    await this.recordConcentratorAttemptMetric({
      metricContext,
      provider: 'all_failed',
      outcome: 'failure',
      attemptedProviders,
      inputTokens: metricContext?.inputTokens ?? estimatePromptTokens(prompt),
      outputTokens: null,
      durationMs: Date.now() - startedAt,
      failureReason: classifyConcentratorFailure(lastError),
    }, shouldRecordMetric);
    throw new Error(`[${fnName}] 所有 provider 都失敗: ${lastError}`);
  }

  private async callProvider(
    provider: ConcentratorProvider,
    prompt: string,
    maxTokens: number,
  ): Promise<string> {
    if (provider === 'gemini') {
      return callGeminiAPI(this.config.apiKey, this.config.model, prompt, maxTokens);
    }
    if (provider === 'deepseek') {
      return callDeepSeekAPI(this.config.deepseekApiKey, this.config.deepseekModel, prompt, maxTokens);
    }
    throw new Error(`Unsupported provider: ${provider}`);
  }

  private async recordConcentratorAttemptMetric(stat: {
    metricContext?: { sessionIdentity?: SessionIdentity; inputTokens?: number };
    provider: ConcentratorProvider;
    outcome: 'success' | 'partial' | 'failure';
    attemptedProviders: ConcentratorProvider[];
    inputTokens: number;
    outputTokens: number | null;
    durationMs: number;
    failureReason?: ConcentratorFailureReason | null;
  }, enabled: boolean): Promise<void> {
    if (!enabled || !this.statsStore) return;
    const identity = stat.metricContext?.sessionIdentity;
    try {
      await this.statsStore.recordConcentratorStat({
        canonicalKey: identity?.canonicalKey?.trim() || 'unknown',
        sessionId: identity?.sessionId ?? null,
        provider: stat.provider,
        outcome: stat.outcome,
        attemptedProviders: JSON.stringify(stat.attemptedProviders),
        inputTokens: stat.inputTokens,
        outputTokens: stat.outputTokens,
        durationMs: stat.durationMs,
        failureReason: stat.failureReason ?? null,
        createdAt: Date.now(),
      });
    } catch (err: any) {
      console.warn(`[ConcentratorAdapter] Failed to write concentrator_stats: ${err?.message ?? err}`);
    }
  }

  /**
   * 簡單文字生成介面（供 core 模組使用）
   * 支援 provider fallback：gemini → deepseek
   */
  async generate(prompt: string, opts?: { purpose?: string; maxTokens?: number }): Promise<string>;
  async generate(messages: any[]): Promise<string>;
  async generate(
    input: string | any[],
    opts?: { purpose?: string; maxTokens?: number },
  ): Promise<string> {
    let prompt: string;
    if (typeof input === 'string') {
      prompt = input;
    } else {
      prompt = '';
      for (let i = input.length - 1; i >= 0; i--) {
        const message = input[i];
        if (message?.role === 'user') {
          prompt = typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content);
          break;
        }
      }
      if (!prompt) {
        prompt = typeof input[0]?.content === 'string'
          ? input[0].content
          : JSON.stringify(input);
      }
    }
    return this.callWithFallback(
      prompt,
      opts?.purpose ?? 'generate',
      undefined,
      undefined,
      opts?.maxTokens,
    );
  }

  async assemble(params: { messages: ContextMessage[]; session?: any }): Promise<ContextMessage[]> {
    try {
      const msgs = Array.isArray(params.messages) ? params.messages : (params.session?.messages || []);
      if (msgs.length === 0) return [];
      const result = await this.concentrate(msgs, false);
      return result.messages;
    } catch (err) {
      console.error(`[ConcentratorAdapter] Critical assemble error:`, err);
      return Array.isArray(params.messages) ? params.messages : [];
    }
  }

  // 🛡️ P0 修復：sessionId 未驗證會被拼進路徑造成路徑穿越。比照
  // transcript-archive.ts 的 getTranscriptPath 規則：白名單字元 + 不含 '..' +
  // resolve 後仍必須落在 sessionSummaryDir 之內，否則視為不合法（回傳 null）。
  private getSessionSummaryPath(sessionId: string): string | null {
    if (!/^[A-Za-z0-9._:-]+$/.test(sessionId) || sessionId.includes('..')) {
      console.warn(`[ConcentratorAdapter] getSessionSummaryPath rejected invalid sessionId: ${sessionId}`);
      return null;
    }
    const dir = path.resolve(this.config.sessionSummaryDir);
    const filePath = path.resolve(dir, `${sessionId}-summary.json`);
    const dirPrefix = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
    if (!filePath.startsWith(dirPrefix)) {
      console.warn(`[ConcentratorAdapter] getSessionSummaryPath escaped sessionSummaryDir: ${sessionId}`);
      return null;
    }
    return filePath;
  }

  private async writeSessionSummary(summary: SessionSummary): Promise<void> {
    if (!summary.sessionId || summary.sessionId === 'unknown') return;
    try {
      const filePath = this.getSessionSummaryPath(summary.sessionId);
      if (!filePath) return;
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(filePath, JSON.stringify(summary, null, 2), { encoding: 'utf-8', mode: 0o600 });
      console.log(`[ConcentratorAdapter] Session summary written: ${filePath}`);
    } catch (err) {
      console.warn('[ConcentratorAdapter] writeSessionSummary failed:', err);
    }
  }
}
