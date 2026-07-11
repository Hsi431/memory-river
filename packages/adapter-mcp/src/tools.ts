import type {
  ContextMessage,
  MemoryRiver,
  RehydrateRequest,
  SessionHint,
} from '@memory-river/core';
import { z } from 'zod/v4';

export const TOOL_NAMES = [
  'memory_recall',
  'memory_rehydrate',
  'memory_archive',
  'memory_store',
  'memory_update',
  'memory_set_status',
  'gwm_on',
  'gwm_off',
  'gwm_status',
  'gwm_update',
  'skill_save',
  'skill_load',
  'memory_river_info',
] as const;

export const TOOL_SCHEMAS = {
  memory_recall: z.object({
    query: z.string(),
    limit: z.number().int().min(1).max(20).default(5),
  }).strict(),
  memory_rehydrate: z.object({
    mode: z.enum(['entry_ids', 'keyword', 'time_range']),
    entryIds: z.array(z.number().int()).optional(),
    keyword: z.string().optional(),
    timestamp: z.string().optional(),
    windowMinutes: z.number().min(1).default(60),
    sessionKey: z.string().optional(),
    bleed: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(200).default(10),
    offset: z.number().int().min(0).default(0),
  }).strict(),
  memory_archive: z.object({
    messages: z.array(z.object({
      role: z.string(),
      content: z.string(),
      timestamp: z.string().optional(),
    }).strict()),
  }).strict(),
  memory_store: z.object({
    text: z.string(),
    category: z.string().default('other'),
    importance: z.number().min(0).max(1).default(0.7),
  }).strict(),
  memory_update: z.object({
    id: z.string().uuid(),
    text: z.string().optional(),
    category: z.enum([
      'preference',
      'fact',
      'decision',
      'entity',
      'constraint',
      'identity',
      'business',
      'knowledge',
      'skill',
      'other',
    ]).optional(),
    importance: z.number().min(0).max(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }).strict().refine(
    args => args.text !== undefined
      || args.category !== undefined
      || args.importance !== undefined
      || args.metadata !== undefined,
    { message: 'memory_update requires at least one update field' },
  ),
  memory_set_status: z.object({
    memoryId: z.string().uuid(),
    toStatus: z.enum(['active', 'deprecated', 'superseded', 'trashed']),
    supersededBy: z.string().uuid().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  gwm_on: z.object({
    taskName: z.string(),
    taskDescription: z.string(),
    keywords: z.array(z.string()).optional(),
  }).strict(),
  gwm_off: z.object({}).strict(),
  gwm_status: z.object({}).strict(),
  gwm_update: z.object({
    taskName: z.string().optional(),
    taskDescription: z.string().optional(),
    keywords: z.array(z.string()).optional(),
  }).strict(),
  skill_save: z.object({
    name: z.string(),
    summary: z.string(),
    triggers: z.array(z.string()),
    steps: z.array(z.string()),
  }).strict(),
  skill_load: z.object({
    name: z.string(),
  }).strict(),
  memory_river_info: z.object({}).strict(),
} as const;

function recallResult(result: Awaited<ReturnType<MemoryRiver['recall']>>[number]) {
  return {
    id: result.entry.id,
    text: result.entry.text,
    category: result.entry.category,
    metadata: result.entry.metadata,
    createdAt: result.entry.createdAt,
    updatedAt: result.entry.updatedAt,
    sessionId: result.entry.sessionId,
    rankScore: result.rankScore,
  };
}

export function createToolExecutor(river: MemoryRiver, sessionKey: string) {
  return {
    async memory_recall(args: z.infer<typeof TOOL_SCHEMAS.memory_recall>) {
      const results = await river.recall(args.query, args.limit);
      return results.map(recallResult);
    },

    async memory_rehydrate(args: z.infer<typeof TOOL_SCHEMAS.memory_rehydrate>) {
      let request: RehydrateRequest;
      if (args.mode === 'entry_ids') {
        request = {
          mode: 'entry_ids',
          sessionKey: args.sessionKey ?? sessionKey,
          entryIds: args.entryIds ?? [],
          bleed: args.bleed ?? 2,
          limit: args.limit,
        };
      } else if (args.mode === 'time_range') {
        request = {
          mode: 'time_range',
          sessionKey: args.sessionKey ?? sessionKey,
          timestamp: args.timestamp ?? '',
          windowMinutes: args.windowMinutes,
          limit: args.limit,
        };
      } else {
        request = {
          mode: 'keyword',
          keyword: args.keyword ?? '',
          sessionKey: args.sessionKey,
          limit: args.limit,
          offset: args.offset,
        };
      }
      return river.rehydrate(request);
    },

    async memory_archive(args: z.infer<typeof TOOL_SCHEMAS.memory_archive>) {
      const messages: ContextMessage[] = args.messages.map(message => {
        if (
          message.role !== 'user'
          && message.role !== 'assistant'
          && message.role !== 'system'
        ) {
          throw new Error(`memory_archive received unsupported role: ${message.role}`);
        }
        const timestamp = message.timestamp === undefined
          ? undefined
          : Date.parse(message.timestamp);
        if (timestamp !== undefined && Number.isNaN(timestamp)) {
          throw new Error(`memory_archive received invalid timestamp: ${message.timestamp}`);
        }
        return {
          role: message.role,
          content: message.content,
          timestamp,
        };
      });
      const session: SessionHint = { sessionKey };
      await river.archiveTranscript(session, messages);
      return { archived: messages.length };
    },

    async memory_store(args: z.infer<typeof TOOL_SCHEMAS.memory_store>) {
      const text = args.text.trim();
      if (!text) throw new Error('memory_store requires non-empty text');
      await river.remember(text, {
        category: args.category,
        importance: args.importance,
        metadata: { sessionKey },
      });
      return 'stored';
    },

    async memory_update(args: z.infer<typeof TOOL_SCHEMAS.memory_update>) {
      const updates = {
        ...(args.text !== undefined ? { text: args.text } : {}),
        ...(args.category !== undefined ? { category: args.category } : {}),
        ...(args.importance !== undefined ? { importance: args.importance } : {}),
        ...(args.metadata !== undefined ? { metadata: JSON.stringify(args.metadata) } : {}),
      };
      return { updated: await river.updateMemory(args.id, updates) };
    },

    memory_set_status(args: z.infer<typeof TOOL_SCHEMAS.memory_set_status>) {
      return river.setMemoryStatus({
        memoryId: args.memoryId,
        toStatus: args.toStatus,
        reason: 'manual',
        source: '@memory-river/adapter-mcp',
        supersededBy: args.supersededBy,
        meta: args.meta,
      });
    },

    gwm_on(args: z.infer<typeof TOOL_SCHEMAS.gwm_on>) {
      return river.gwm.on(args.taskName, args.taskDescription, args.keywords ?? []);
    },

    gwm_off() {
      return river.gwm.off();
    },

    gwm_status() {
      return river.gwm.status();
    },

    gwm_update(args: z.infer<typeof TOOL_SCHEMAS.gwm_update>) {
      return river.gwm.update(args);
    },

    async skill_save(args: z.infer<typeof TOOL_SCHEMAS.skill_save>) {
      const saved = await river.skills.save(args);
      return `skill saved: ${args.name} (${saved.id})`;
    },

    async skill_load(args: z.infer<typeof TOOL_SCHEMAS.skill_load>) {
      const skill = await river.skills.load(args.name);
      return skill ?? `skill not found: ${args.name}`;
    },
  };
}
