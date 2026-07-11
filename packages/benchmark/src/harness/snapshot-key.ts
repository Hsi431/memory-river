import { createHash } from 'node:crypto';

import type { ContextMessage } from '@memory-river/core';

import { EMBED_MODEL } from './real-embedder.js';

/**
 * Bump when the snapshot layout or ingest pipeline changes shape so stale
 * caches are not silently restored. Shared by the conversation runner (which
 * writes snapshots) and the enumeration-presence audit (which reads them) so
 * the two can never drift apart.
 */
export const SNAPSHOT_SCHEMA_VERSION = 2;

export interface SnapshotKeyInput {
  sampleId: string;
  sessions: Array<{ messages: ContextMessage[] }>;
}

/**
 * Content-hashed snapshot cache key = ingest-determining inputs (schema version
 * + answer/distill model + real DEEPSEEK_MAX_TOKENS + embedding model + this
 * conversation's messages). Not index-keyed, so --sample/seed reshuffles still
 * hit the right cache entry. Changing distill code does NOT auto-invalidate —
 * pass --rebuild-snapshot after a distill-side change.
 */
export function snapshotCacheKey(conversation: SnapshotKeyInput): string {
  return `${conversation.sampleId}-${createHash('sha256')
    .update(JSON.stringify({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
      maxTokens: process.env.DEEPSEEK_MAX_TOKENS ?? '',
      embedModel: process.env.MR_BENCH_EMBED_MODEL ?? EMBED_MODEL,
      sessions: conversation.sessions.map(session => session.messages),
    }))
    .digest('hex')
    .slice(0, 16)}`;
}
