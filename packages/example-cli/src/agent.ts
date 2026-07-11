import * as readline from 'node:readline';

import type {
  ContextMessage,
  MemoryRiver,
  RehydrateRequest,
} from '@memory-river/core';

const SYSTEM_PROMPT = `You operate with a long-term memory (memory-river). It is intentionally LOSSY: recall returns
compressed summaries/notes, but the ORIGINAL conversation is fully retained and can be pulled
back on demand with memory_rehydrate. Your job is to recognize when what you recalled is not
enough to answer precisely, and to go get the exact original turns instead of guessing.

Tools:
- memory_recall(query): semantic search over long-term memory (capsules + notes). Returns
  CANDIDATE EVIDENCE — not guaranteed relevant or sufficient.
- memory_rehydrate(mode, ...): read the exact original turns.
    • mode='entry_ids' (entryIds=[...]): PREFERRED, most reliable. Use when a RELEVANT recalled
      memory exposes sourceEntryIds.
    • mode='time_range' (timestamp,windowMinutes): when a relevant memory has only a timestamp,
      or the user gives a trustworthy time.
    • mode='keyword' (keyword): fallback when recall found NO relevant memory. It scans only the
      latest ~10 transcript files with AND/ranked substring matching, so pass ONE short
      distinctive entity from the question (a person/thing/file/project/rare term), not a
      multi-word phrase or a generic word.
- (if available) memory_store, gwm_on/gwm_update (task working-memory that biases recall),
  skill_save/skill_load.

How to decide:
1. Judge each recalled memory for THIS question: SUFFICIENT (answer directly, no tool) /
   RELEVANT_PARTIAL (right subject, missing the asked detail) / CONFLICTING / RECALL_FAILED
   (no hit, generic filler, or unrelated).
2. Pick the rehydrate route by provenance:
   - RELEVANT_PARTIAL/CONFLICTING with source ids → entry_ids first.
   - relevant but only a timestamp → time_range.
   - RECALL_FAILED → do NOT trust that candidate's ids; use keyword with one distinctive
     entity from the QUESTION.
3. count>0 is NOT success: after each rehydrate, check the returned turns actually contain the
   requested fact. Empty or irrelevant output is a FAILED route, not proof memory is absent.
4. Escalate across materially-different routes (change mode / entity / time window) before
   saying you don't know. Do not repeat an unchanged failed query. Bounded effort: ~2
   rehydrate calls, a 3rd only if a strong unused route remains.
5. Only answer "I don't know" after the applicable routes are exhausted. Never invent missing
   details. Answer concisely.

Before composing your answer, run a private stock-take (do not output this step):
1. From the retrieved evidence, extract every distinct item that stands in the requested relationship to the subject.
2. Merge aliases and duplicates into a single canonical entry.
3. For each remaining item, verify at least one memory block supports it; drop any item with no supporting evidence.
4. Your answer must include all evidence-supported items and must not include items absent from the retrieved evidence.`;

interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: ToolCall[];
}

interface ChatCompletion {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
}

const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'memory_recall',
      description: 'Search long-term memory for relevant facts, summaries, and source provenance.',
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
        'Read exact original conversation turns. Prefer entry_ids with relevant sourceEntryIds and their sessionKey; ' +
        'use time_range for a trustworthy timestamp; use one distinctive keyword when recall failed.',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['entry_ids', 'keyword', 'time_range'] },
          entryIds: { type: 'array', items: { type: 'integer' } },
          keyword: { type: 'string' },
          timestamp: { type: 'string' },
          windowMinutes: { type: 'number', minimum: 1, default: 60 },
          sessionKey: { type: 'string' },
          bleed: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
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
      description: 'Start Global Working Memory for a task so its keywords bias recall.',
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
      description: 'Show the current Global Working Memory task and drift state.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gwm_update',
      description: 'Update the Global Working Memory task name, description, or keywords.',
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
      description: "Load a saved skill's full execution steps by name.",
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
];

class AgentClient {
  constructor(
    private readonly endpoint: string,
    private readonly model: string,
    private readonly apiKey?: string,
  ) {}

  async complete(
    messages: LlmMessage[],
    useTools = true,
  ): Promise<{ content: string; toolCalls: ToolCall[] }> {
    const response = await fetch(`${this.endpoint.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        ...(useTools ? { tools: TOOLS, tool_choice: 'auto' } : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(`Agent LLM request failed (${response.status}): ${await response.text()}`);
    }
    const body = await response.json() as ChatCompletion;
    const message = body.choices?.[0]?.message;
    if (!message) throw new Error('Agent LLM returned no message');
    return {
      content: message.content ?? '',
      toolCalls: message.tool_calls ?? [],
    };
  }
}

function agentClientFromEnv(): AgentClient {
  if (process.env.OPENAI_API_KEY) {
    return new AgentClient(
      process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
      process.env.OPENAI_API_KEY,
    );
  }
  const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  const endpoint = baseUrl.replace(/\/$/, '').endsWith('/v1')
    ? baseUrl
    : `${baseUrl.replace(/\/$/, '')}/v1`;
  return new AgentClient(endpoint, process.env.OLLAMA_MODEL ?? 'qwen3:8b');
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

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function executeTool(
  river: MemoryRiver,
  sessionKey: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (name === 'memory_recall') {
    const query = typeof args.query === 'string' ? args.query : '';
    const results = await river.recall(query, finiteNumber(args.limit, 5));
    return results.map((result, index) => `[M${index + 1}] ${serialize({
      id: result.entry.id,
      text: result.entry.text,
      category: result.entry.category,
      metadata: result.entry.metadata,
      createdAt: result.entry.createdAt,
      updatedAt: result.entry.updatedAt,
      sessionId: result.entry.sessionId,
      rankScore: result.rankScore,
    })}`).join('\n\n');
  }

  if (name === 'memory_rehydrate') {
    const limit = finiteNumber(args.limit, 10);
    let request: RehydrateRequest;
    if (args.mode === 'entry_ids') {
      const entryIds = Array.isArray(args.entryIds)
        ? args.entryIds.filter((id): id is number => typeof id === 'number' && Number.isInteger(id))
        : [];
      request = {
        mode: 'entry_ids',
        sessionKey: typeof args.sessionKey === 'string' ? args.sessionKey : sessionKey,
        entryIds,
        bleed: finiteNumber(args.bleed, 0),
        limit,
      };
    } else if (args.mode === 'time_range') {
      request = {
        mode: 'time_range',
        sessionKey: typeof args.sessionKey === 'string' ? args.sessionKey : sessionKey,
        timestamp: typeof args.timestamp === 'string' ? args.timestamp : '',
        windowMinutes: finiteNumber(args.windowMinutes, 60),
        limit,
      };
    } else {
      request = {
        mode: 'keyword',
        keyword: typeof args.keyword === 'string' ? args.keyword : '',
        sessionKey: typeof args.sessionKey === 'string' ? args.sessionKey : undefined,
        limit,
      };
    }
    const turns = await river.rehydrate(request);
    return turns.map((turn, index) => `[T${index + 1}] ${serialize(turn)}`).join('\n\n');
  }

  if (name === 'memory_store') {
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) return 'memory_store requires non-empty text';
    await river.remember(text, {
      category: typeof args.category === 'string' ? args.category : undefined,
      importance: finiteNumber(args.importance, 0.7),
      metadata: { sessionKey },
    });
    return 'stored';
  }

  if (name === 'gwm_on') {
    return river.gwm.on(
      typeof args.taskName === 'string' ? args.taskName : '',
      typeof args.taskDescription === 'string' ? args.taskDescription : '',
      stringArray(args.keywords),
    );
  }
  if (name === 'gwm_off') return river.gwm.off();
  if (name === 'gwm_status') return river.gwm.status();
  if (name === 'gwm_update') {
    const update: { taskName?: string; taskDescription?: string; keywords?: string[] } = {};
    if (typeof args.taskName === 'string') update.taskName = args.taskName;
    if (typeof args.taskDescription === 'string') update.taskDescription = args.taskDescription;
    if (Array.isArray(args.keywords)) update.keywords = stringArray(args.keywords);
    return river.gwm.update(update);
  }

  if (name === 'skill_save') {
    const skillName = typeof args.name === 'string' ? args.name : '';
    const saved = await river.skills.save({
      name: skillName,
      summary: typeof args.summary === 'string' ? args.summary : '',
      triggers: stringArray(args.triggers),
      steps: stringArray(args.steps),
    });
    return `skill saved: ${skillName} (${saved.id})`;
  }
  if (name === 'skill_load') {
    const skillName = typeof args.name === 'string' ? args.name : '';
    const skill = await river.skills.load(skillName);
    return skill ? serialize(skill) : `skill not found: ${skillName}`;
  }

  return `unknown tool: ${name}`;
}

async function runToolLoop(
  client: AgentClient,
  river: MemoryRiver,
  sessionKey: string,
  messages: LlmMessage[],
): Promise<string> {
  for (let iteration = 0; iteration < 12; iteration++) {
    const response = await client.complete(messages);
    if (response.toolCalls.length === 0) return response.content;

    messages.push({
      role: 'assistant',
      content: response.content || null,
      tool_calls: response.toolCalls,
    });
    for (const call of response.toolCalls) {
      const args = parseArguments(call.function.arguments);
      console.error(`[agent tool] ${call.function.name} ${serialize(args)}`);
      let result: string;
      try {
        result = await executeTool(river, sessionKey, call.function.name, args);
      } catch (error) {
        result = `${call.function.name} failed: ${(error as Error)?.message ?? String(error)}`;
      }
      console.error(`[agent tool result] ${call.function.name}: ${result}`);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: result,
      });
    }
  }
  // 回合用盡的收尾:不再丟例外,改為停用工具、強制純文字作答(與 benchmark 一致的
  // graceful finalization),避免真實對話中直接崩掉。
  messages.push({
    role: 'user',
    content:
      '你已無法再使用任何工具。請根據以上已取得的資訊,直接用純文字給出最終答案;' +
      '若資訊不足以回答,就明確說明無法回答。',
  });
  const finalResponse = await client.complete(messages, false);
  return finalResponse.content;
}

export async function runAgent(river: MemoryRiver): Promise<void> {
  const client = agentClientFromEnv();
  const startedAt = new Date();
  const sessionKey = `agent-session-${startedAt.toISOString()}`;
  const session = { sessionKey };
  const history: ContextMessage[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  console.error(`[agent] sessionKey=${sessionKey}`);
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;

    const userMessage: ContextMessage = {
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    history.push(userMessage);

    const assembled = await river.assembleContext(history, session);
    const llmMessages: LlmMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...assembled.messages.map(message => ({
        role: message.role,
        content: messageText(message),
      })),
    ];
    const reply = await runToolLoop(client, river, sessionKey, llmMessages);
    const assistantMessage: ContextMessage = {
      role: 'assistant',
      content: reply,
      timestamp: Date.now(),
    };

    await river.archiveTranscript(session, [userMessage, assistantMessage]);
    history.push(assistantMessage);
    console.log(reply);
  }
}
