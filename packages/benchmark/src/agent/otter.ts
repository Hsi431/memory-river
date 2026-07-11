import type {
  ContextMessage,
  MemoryRiver,
} from '@memory-river/core';

import {
  runToolLoop,
  type ToolResultEvent,
  type ToolTraceEntry,
} from '../harness/tool-llm.js';
import type { DeepSeekTool } from '../harness/deepseek-llm.js';

const SYSTEM_PROMPT =
  // Gap-aware rehydrate disposition — kept in sync with docs/AGENT_MEMORY_SYSTEM_PROMPT.md.
  "Recalled memories are CANDIDATE EVIDENCE from a LOSSY memory: memory_recall returns compressed summaries. " +
  "A summary helps you find WHERE to look; it is NOT proof that a detail it omits is absent. " +
  "Classify each recalled memory for THIS question: SUFFICIENT (directly contains the EXACT fact/value asked — a neighboring or same-subject fact is NOT sufficient) / " +
  "RELEVANT_PARTIAL (right subject but missing the asked detail, only a neighboring fact, or it advertises sourceEntryIds while the exact answer is not visible) / " +
  "CONFLICTING / RECALL_FAILED (no relevant hit, generic filler, or unrelated). " +
  "HARD RULE: do NOT answer 'unknown' / 'not recorded' / 'not mentioned' or any absence claim from recall summaries alone. " +
  "If any RELEVANT_PARTIAL or CONFLICTING memory exposes sourceEntryIds, you MUST call memory_rehydrate mode='entry_ids' at least once before concluding the fact is absent. " +
  "Route: RELEVANT_PARTIAL/CONFLICTING with source ids → entry_ids first; relevant but only a timestamp → time_range; RECALL_FAILED → keyword with ONE distinctive entity from the QUESTION. " +
  "If a route returns empty/irrelevant turns, try ONE materially different route (different ids, nearby time window, distinctive keyword). " +
  "count>0 is NOT success: check the returned turns actually contain the asked fact. " +
  "If the turns use relative time words (yesterday, last week, earlier, ...), derive the date from the timestamp ON that turn; state a derived date only when the timestamp and expression make it clear. " +
  "Trust the original turns over the summary only when they explicitly give a different fact/value; raw silence in rehydrated turns is a MISS, not a refutation, and does not override a truly SUFFICIENT recall summary or prove absence. " +
  "Cost: do not rehydrate a truly SUFFICIENT memory; when required, normally make 1 call on the strongest route, a 2nd only if the first is empty/irrelevant/still missing the fact and another strong route exists, a 3rd only for a clearly distinct unused route; never repeat an unchanged failed query. " +
  "Say \"I don't know\" only after the required routes were tried and exhausted. Never invent missing details. " +
  'Before composing your answer, run a private stock-take (do not output this step):\n' +
  '1. From the retrieved evidence, extract every distinct item that stands in the requested relationship to the subject.\n' +
  '2. Merge aliases and duplicates into a single canonical entry.\n' +
  '3. For each remaining item, verify at least one memory block supports it; drop any item with no supporting evidence.\n' +
  '4. Your answer must include all evidence-supported items and must not include items absent from the retrieved evidence.\n' +
  'Answer concisely.';

const CARDINALITY_HINT =
  "When the user asks for a list, examples, \"what are\", or \"which\", the retrieved evidence may contain multiple distinct supported items. " +
  "Do not stop after the first matching item. " +
  "List all distinct items that are supported by the retrieved evidence. " +
  "Do not invent items not supported by memory; if evidence is insufficient, say so.";

/** Returns the system prompt for the current arm.
 *  Arm A (default): SYSTEM_PROMPT unchanged.
 *  Arm B (MR_CARDINALITY_HINT=1): SYSTEM_PROMPT + blank line + CARDINALITY_HINT. */
export function effectiveSystemPrompt(): string {
  return process.env.MR_CARDINALITY_HINT === '1'
    ? `${SYSTEM_PROMPT}\n\n${CARDINALITY_HINT}`
    : SYSTEM_PROMPT;
}

export const OTTER_TOOLS: DeepSeekTool[] = [
  {
    type: 'function',
    function: {
      name: 'memory_recall',
      description: 'Search long-term memory for relevant facts.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_rehydrate',
      description:
        'Read exact original conversation turns. count>0 is not success: verify the returned turns contain the requested fact; ' +
        "if not, escalate to a different route. Modes: entry_ids — preferred and most precise when a relevant recalled memory " +
        "provides sourceEntryIds; never use ids from generic or irrelevant memory. time_range — when relevant memory has only " +
        'a timestamp, or the user gives a trustworthy time. keyword — fallback when recall found no relevant memory; it only ' +
        'scans the latest ~10 transcript files and whitespace-splits terms for AND substring matching, so use one distinctive ' +
        'entity from the question (person/thing/filename/project/rare term), avoiding multi-word phrases and generic terms.',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['entry_ids', 'keyword', 'time_range'] },
          entryIds: { type: 'array', items: { type: 'integer' } },
          keyword: { type: 'string' },
          timestamp: { type: 'string' },
          windowMinutes: { type: 'number', minimum: 1, default: 60 },
          sessionKey: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
        },
        required: ['mode'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_store',
      description: 'Save a durable long-term memory.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          category: { type: 'string', default: 'other' },
          importance: { type: 'number', minimum: 0, maximum: 1, default: 0.7 },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gwm_on',
      description:
        'Start Global Working Memory for a task; its keywords bias what memory_recall surfaces.',
      parameters: {
        type: 'object',
        properties: {
          taskName: { type: 'string' },
          taskDescription: { type: 'string' },
          keywords: { type: 'array', items: { type: 'string' } },
        },
        required: ['taskName', 'taskDescription'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gwm_off',
      description: 'Stop Global Working Memory tracking.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gwm_status',
      description: 'Show the current Global Working Memory state (task name, drift).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gwm_update',
      description: 'Update the working-memory task description or keywords.',
      parameters: {
        type: 'object',
        properties: {
          taskName: { type: 'string' },
          taskDescription: { type: 'string' },
          keywords: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_save',
      description: 'Save a reusable skill procedure.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          summary: { type: 'string' },
          triggers: { type: 'array', items: { type: 'string' } },
          steps: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'summary', 'triggers', 'steps'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_load',
      description: "Load a skill's full execution steps by name.",
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
];

export interface RehydratedTurn {
  entryId: number;
  user: string;
  assistant: string;
  timestamp: number;
}

export interface OtterLlm {
  apiKey: string;
  model: string;
}

export interface OtterResult {
  answer: string;
  trace: ToolTraceEntry[];
  capExhausted: boolean;
  entryIdsAdvertisedInPreamble: boolean;
  deliveredContext?: {
    entryIds: number[];
    channels: Record<'autoRecall' | 'memory_recall' | 'memory_rehydrate', number[]>;
    textChunks: Record<'autoRecall' | 'memory_recall' | 'memory_rehydrate', string[]>;
  };
  usage: { calls: number; promptTokens: number; completionTokens: number };
}

export interface DeliveredContextCapture {
  entryIds: Set<number>;
  channels: Record<'autoRecall' | 'memory_recall' | 'memory_rehydrate', Set<number>>;
  textChunks: Record<'autoRecall' | 'memory_recall' | 'memory_rehydrate', string[]>;
}

function messageText(message: ContextMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter(part => part.type === undefined || part.type === 'text')
    .map(part => part.text ?? '')
    .filter(Boolean)
    .join('\n');
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string');
  return out.length > 0 ? out : undefined;
}

function metadataObject(metadata: unknown): Record<string, unknown> {
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
}

function sourceEntryIdsFromMemory(result: unknown): number[] {
  const metadata = metadataObject((result as any)?.entry?.metadata);
  const ids = metadata.sourceEntryIds;
  return Array.isArray(ids)
    ? ids.filter((id): id is number => typeof id === 'number' && Number.isFinite(id))
    : [];
}

function addDeliveredIds(
  capture: DeliveredContextCapture | undefined,
  channel: keyof DeliveredContextCapture['channels'],
  ids: Iterable<number>,
): void {
  if (!capture) return;
  for (const id of ids) {
    if (!Number.isFinite(id)) continue;
    capture.entryIds.add(id);
    capture.channels[channel].add(id);
  }
}

function addDeliveredText(
  capture: DeliveredContextCapture | undefined,
  channel: keyof DeliveredContextCapture['textChunks'],
  text: string,
): void {
  if (!capture || !text) return;
  capture.textChunks[channel].push(text);
}

function sortedNumbers(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

export function turnText(turns: RehydratedTurn[]): string {
  return turns.map((turn, index) => {
    const date = Number.isFinite(turn.timestamp) && turn.timestamp > 0
      ? new Date(turn.timestamp).toISOString().slice(0, 10)
      : '';
    const prefix = date ? `[${date}] ` : '';

    // This bracketed date exists only in QA-time memory_rehydrate tool output.
    // It is never written back into messages passed through concentration.
    return [
      `[T${index + 1}]`,
      turn.user ? `${prefix}user: ${turn.user}` : '',
      turn.assistant ? `${prefix}assistant: ${turn.assistant}` : '',
    ].filter(Boolean).join('\n');
  }).filter(Boolean).join('\n\n');
}

export async function runOtter(input: {
  llm: OtterLlm;
  river: MemoryRiver;
  question: string;
  sessionKeys: string[];
  conversationKey: string;
  rehydrateById(entryIds: number[], limit: number): Promise<RehydratedTurn[]>;
  onToolResult?(event: ToolResultEvent): void;
  deliveredContext?: DeliveredContextCapture;
  extraAutoRecallContext?: string[];
}): Promise<OtterResult> {
  const assembled = await (input.river as any).assembleContext(
    [{ role: 'user', content: input.question }],
    undefined,
    {
      onAutoRecallResults(event: { results: unknown[] }) {
        for (const result of event.results) {
          addDeliveredIds(input.deliveredContext, 'autoRecall', sourceEntryIdsFromMemory(result));
        }
      },
    },
  );
  const injectedContext = assembled.messages
    .filter((message: ContextMessage) => message.role === 'system')
    .map((message: ContextMessage) => messageText(message))
    .filter((text: string) => Boolean(text))
    .join('\n\n');
  addDeliveredText(input.deliveredContext, 'autoRecall', injectedContext);
  const fanoutContext = input.extraAutoRecallContext?.filter(Boolean).join('\n\n') ?? '';
  const entryIdsAdvertisedInPreamble = injectedContext.includes('entryIds=[');
  const contextText = [injectedContext, fanoutContext].filter(Boolean).join('\n\n');
  const system = contextText
    ? `${effectiveSystemPrompt()}\n\n${contextText}`
    : effectiveSystemPrompt();
  const allowedSessionKeys = new Set([...input.sessionKeys, input.conversationKey]);
  // Confirmatory A/B runs set MR_OTTER_READONLY=1 to disable agent-induced writes that would
  // bleed across questions in the same conversation-shared river (memory_store injects fake
  // memories; gwm_* leaves working-memory state on; skill_save mutates skills). Reads stay live.
  const otterReadonly = process.env.MR_OTTER_READONLY === '1';

  const result = await runToolLoop({
    apiKey: input.llm.apiKey,
    model: input.llm.model,
    system,
    userMessages: [{ role: 'user', content: input.question }],
    tools: OTTER_TOOLS,
    onToolResult: input.onToolResult,
    async execute(name, args) {
      if (
        otterReadonly &&
        (name === 'memory_store' || name === 'gwm_on' || name === 'gwm_off' ||
          name === 'gwm_update' || name === 'skill_save' || name === 'skill_load')
      ) {
        // No-op the mutating tools; return plausible result so agent behaviour is unchanged.
        // Applied to BOTH arms identically -> not a differential confound.
        // skill_load is here because engine.loadSkill() writes usageCount + boostHealth on the
        // entry (engine.ts:1421-1424), a cross-question retrieval-state write; v4 used it 0×.
        const acks: Record<string, { content: string; resultCount: number }> = {
          memory_store: { content: 'stored', resultCount: 1 },
          gwm_on: { content: 'working memory started', resultCount: 1 },
          gwm_off: { content: 'working memory stopped', resultCount: 1 },
          gwm_update: { content: 'working memory updated', resultCount: 1 },
          skill_save: { content: 'skill saved', resultCount: 1 },
          skill_load: { content: 'skill not found', resultCount: 0 },
        };
        return acks[name];
      }

      if (name === 'memory_recall') {
        const query = typeof args.query === 'string' ? args.query : input.question;
        const limit = finiteNumber(args.limit, 5);
        const results = await input.river.searchMemory(query, limit);
        for (const result of results) {
          addDeliveredIds(input.deliveredContext, 'memory_recall', sourceEntryIdsFromMemory(result));
        }
        const memories = results
          .map(result => result.entry.text)
          .filter(text => text && text !== '_SYSTEM_INIT_');
        const content = memories.map((text, index) => `[M${index + 1}] • ${text}`).join('\n');
        addDeliveredText(input.deliveredContext, 'memory_recall', content);
        return {
          content,
          resultCount: memories.length,
        };
      }

      if (name === 'memory_store') {
        const text = typeof args.text === 'string' ? args.text : '';
        if (!text.trim()) return { content: 'memory_store requires text', resultCount: 0 };
        await input.river.remember(text, {
          category: typeof args.category === 'string' ? args.category : undefined,
          importance: finiteNumber(args.importance, 0.7),
        });
        return { content: 'stored', resultCount: 1 };
      }

      if (name === 'gwm_on') {
        const taskName = typeof args.taskName === 'string' ? args.taskName : '';
        const taskDescription = typeof args.taskDescription === 'string' ? args.taskDescription : '';
        const keywords = stringArray(args.keywords);
        const msg = await input.river.gwm.on(taskName, taskDescription, keywords);
        return { content: msg, resultCount: 1 };
      }

      if (name === 'gwm_off') {
        return { content: await input.river.gwm.off(), resultCount: 1 };
      }

      if (name === 'gwm_status') {
        return { content: input.river.gwm.status(), resultCount: 1 };
      }

      if (name === 'gwm_update') {
        const update: { taskName?: string; taskDescription?: string; keywords?: string[] } = {};
        if (typeof args.taskName === 'string') update.taskName = args.taskName;
        if (typeof args.taskDescription === 'string') update.taskDescription = args.taskDescription;
        // Pass keywords whenever an array is given (incl. [] to clear them).
        if (Array.isArray(args.keywords)) {
          update.keywords = args.keywords.filter((k): k is string => typeof k === 'string');
        }
        return { content: await input.river.gwm.update(update), resultCount: 1 };
      }

      if (name === 'skill_save') {
        const def = {
          name: typeof args.name === 'string' ? args.name : '',
          summary: typeof args.summary === 'string' ? args.summary : '',
          triggers: stringArray(args.triggers) ?? [],
          steps: stringArray(args.steps) ?? [],
        };
        try {
          const saved = await input.river.skills.save(def);
          return { content: `skill saved: ${def.name} (${saved.id})`, resultCount: 1 };
        } catch (err) {
          return { content: `skill_save failed: ${(err as Error)?.message ?? String(err)}`, resultCount: 0 };
        }
      }

      if (name === 'skill_load') {
        const skillName = typeof args.name === 'string' ? args.name : '';
        try {
          const skill = await input.river.skills.load(skillName);
          if (!skill) return { content: `skill not found: ${skillName}`, resultCount: 0 };
          const steps = skill.executionSteps.map((step, i) => `${i + 1}. ${step}`).join('\n');
          const text = [
            `【${skill.name}】`,
            `summary: ${skill.summary}`,
            `triggers: ${skill.triggerConditions.join(', ')}`,
            `usage: ${skill.usageCount}`,
            'steps:',
            steps,
          ].join('\n');
          return { content: text, resultCount: 1 };
        } catch (err) {
          return { content: `skill_load failed: ${(err as Error)?.message ?? String(err)}`, resultCount: 0 };
        }
      }

      if (name !== 'memory_rehydrate') {
        return { content: '', resultCount: 0 };
      }

      const limit = finiteNumber(args.limit, 10);
      let turns: RehydratedTurn[] = [];
      if (args.mode === 'entry_ids') {
        const entryIds = Array.isArray(args.entryIds)
          ? args.entryIds.filter((id): id is number => typeof id === 'number' && Number.isInteger(id))
          : [];
        turns = await input.rehydrateById(entryIds, limit);
      } else if (args.mode === 'keyword') {
        const keyword = typeof args.keyword === 'string' ? args.keyword.trim() : '';
        if (keyword) {
          turns = await input.river.rehydrate({
            mode: 'keyword',
            keyword,
            sessionKey: input.conversationKey,
            limit,
          });
        }
      } else if (args.mode === 'time_range') {
        const timestamp = typeof args.timestamp === 'string' ? args.timestamp : '';
        const requestedSession = typeof args.sessionKey === 'string' ? args.sessionKey : '';
        const sessionKey = allowedSessionKeys.has(requestedSession)
          ? requestedSession
          : input.conversationKey;
        if (timestamp) {
          turns = await input.river.rehydrate({
            mode: 'time_range',
            sessionKey,
            timestamp,
            windowMinutes: finiteNumber(args.windowMinutes, 60),
            limit,
          });
        }
      }
      addDeliveredIds(input.deliveredContext, 'memory_rehydrate', turns.map(turn => turn.entryId));
      const content = turnText(turns);
      addDeliveredText(input.deliveredContext, 'memory_rehydrate', content);

      return {
        content,
        resultCount: turns.length,
      };
    },
  });
  return {
    ...result,
    entryIdsAdvertisedInPreamble,
    ...(input.deliveredContext ? {
      deliveredContext: {
        entryIds: sortedNumbers(input.deliveredContext.entryIds),
        channels: {
          autoRecall: sortedNumbers(input.deliveredContext.channels.autoRecall),
          memory_recall: sortedNumbers(input.deliveredContext.channels.memory_recall),
          memory_rehydrate: sortedNumbers(input.deliveredContext.channels.memory_rehydrate),
        },
        textChunks: input.deliveredContext.textChunks,
      },
    } : {}),
  };
}
