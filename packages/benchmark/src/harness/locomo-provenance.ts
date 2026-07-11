import * as fs from 'node:fs';
import * as path from 'node:path';

import { type LocomoConversation } from './locomo.js';
import { snapshotCacheKey } from './snapshot-key.js';

export interface TranscriptEntry {
  entryId: number;
  user: string;
  assistant: string;
  timestamp: number;
}

export interface MemoryRow {
  id: string;
  text: string;
  metadata: string;
  category: string;
  status?: string;
}

export interface GraphTripleRow {
  id: string;
  subject: string;
  relation: string;
  object: string;
  sourceMemoryId: string;
}

export function evidenceDiaIds(evidence: string): string[] {
  const matches = evidence.match(/D\d+:\d+/g);
  return matches && matches.length > 0 ? matches : [evidence];
}

export function findSnapshotPath(snapshotDir: string, conversation: LocomoConversation): string | null {
  const exact = path.join(snapshotDir, snapshotCacheKey(conversation));
  if (fs.existsSync(path.join(exact, 'manifest.json'))) return exact;
  if (!fs.existsSync(snapshotDir)) return null;
  const prefix = `${conversation.sampleId}-`;
  const candidates = fs.readdirSync(snapshotDir)
    .filter(name => name.startsWith(prefix))
    .map(name => path.join(snapshotDir, name))
    .filter(candidate => fs.existsSync(path.join(candidate, 'manifest.json')))
    .sort();
  return candidates[0] ?? null;
}

export function readJsonl(filePath: string): TranscriptEntry[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as TranscriptEntry);
}

export function buildEvidenceEntryMap(
  conversation: LocomoConversation,
  snapshotPath: string,
): Map<string, { sessionKey: string; entryId: number }> {
  const result = new Map<string, { sessionKey: string; entryId: number }>();
  const transcriptDir = path.join(snapshotPath, 'data', 'transcripts');
  const convKey = `locomo-${conversation.sampleId}`;

  for (const session of conversation.sessions) {
    const sessionKey = `${convKey}-s${session.index}`;
    const transcriptEntries = readJsonl(path.join(transcriptDir, `${sessionKey}.jsonl`));
    const entryByTimestamp = new Map(transcriptEntries.map(entry => [entry.timestamp, entry]));

    let pendingDiaId: string | null = null;
    let pendingTimestamp = 0;
    for (let index = 0; index < session.messages.length; index++) {
      const message = session.messages[index];
      const diaId = session.turns[index]?.diaId;
      if (!diaId) continue;

      if (message.role === 'user') {
        pendingDiaId = diaId;
        pendingTimestamp = message.timestamp ?? 0;
        const entry = entryByTimestamp.get(pendingTimestamp);
        if (entry) result.set(diaId, { sessionKey, entryId: entry.entryId });
        continue;
      }

      if (message.role === 'assistant' && pendingDiaId !== null) {
        const entry = entryByTimestamp.get(pendingTimestamp);
        if (entry) {
          result.set(pendingDiaId, { sessionKey, entryId: entry.entryId });
          result.set(diaId, { sessionKey, entryId: entry.entryId });
        }
        pendingDiaId = null;
      } else if (message.timestamp !== undefined) {
        const entry = entryByTimestamp.get(message.timestamp);
        if (entry) result.set(diaId, { sessionKey, entryId: entry.entryId });
      }
    }
  }

  return result;
}

function parseMetadata(metadata: unknown): Record<string, unknown> {
  if (typeof metadata !== 'string' || metadata.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function sourceEntryIds(metadata: unknown): number[] {
  const parsed = parseMetadata(metadata);
  const ids = parsed.sourceEntryIds;
  return Array.isArray(ids)
    ? ids.filter((id): id is number => typeof id === 'number' && Number.isFinite(id))
    : [];
}

export async function readLanceRows<T>(
  snapshotPath: string,
  tableName: string,
  columns: string[],
  limit = 10000,
): Promise<T[]> {
  const lancedb = await import('@lancedb/lancedb');
  const ramPath = path.join(snapshotPath, 'ram');
  const dataPath = path.join(snapshotPath, 'data', 'lancedb');
  const dbPath = fs.existsSync(path.join(ramPath, `${tableName}.lance`)) ? ramPath : dataPath;
  const db = await lancedb.connect(dbPath);
  const table = await db.openTable(tableName);
  return await table.query().select(columns).limit(limit).toArray() as T[];
}
