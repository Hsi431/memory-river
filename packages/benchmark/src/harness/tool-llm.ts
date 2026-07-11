import {
  deepseekChatCompletion,
  extractContent,
  type DeepSeekCompletion,
  type DeepSeekMessage,
  type DeepSeekTool,
  type DeepSeekToolCall,
} from './deepseek-llm.js';

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const DSML_MARKER = '｜｜DSML｜｜';
const DSML_RETRY_MESSAGE =
  'Your previous response contained malformed native tool-call markup. ' +
  'Retry using the provided structured tools, or answer normally without tool-call markup.';

export interface ToolTraceEntry {
  name: string;
  args: Record<string, unknown>;
  content?: string;
}

export interface ToolExecutionResult {
  content: string;
  resultCount?: number;
}

export interface ToolResultEvent extends ToolTraceEntry {
  content: string;
  resultCount?: number;
}

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<string | ToolExecutionResult>;

export type ToolCompletion = (input: {
  apiKey: string;
  model: string;
  messages: DeepSeekMessage[];
  tools?: DeepSeekTool[];
  maxTokens?: number;
}) => Promise<DeepSeekCompletion>;

function decodeXmlText(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function parseDsmlToolCalls(
  content: string | null,
  tools: DeepSeekTool[],
  round: number,
): DeepSeekToolCall[] | undefined {
  if (!content?.includes(DSML_MARKER)) return undefined;

  const block = content.match(
    /^\s*<｜｜DSML｜｜tool_calls>\s*([\s\S]*?)\s*<\/｜｜DSML｜｜tool_calls>\s*$/,
  );
  if (!block) return [];

  const allowedNames = new Set(tools.map(tool => tool.function.name));
  const calls: DeepSeekToolCall[] = [];
  const invokePattern =
    /<｜｜DSML｜｜invoke\s+name="([^"]+)">\s*([\s\S]*?)\s*<\/｜｜DSML｜｜invoke>/g;
  let unmatched = block[1];

  for (const invoke of block[1].matchAll(invokePattern)) {
    const name = decodeXmlText(invoke[1]);
    if (!allowedNames.has(name)) return [];

    const args: Record<string, unknown> = {};
    const parameterPattern =
      /<｜｜DSML｜｜parameter\s+name="([^"]+)"\s+string="(true|false)">([\s\S]*?)<\/｜｜DSML｜｜parameter>/g;
    let unmatchedParameters = invoke[2];

    for (const parameter of invoke[2].matchAll(parameterPattern)) {
      const parameterName = decodeXmlText(parameter[1]);
      const text = decodeXmlText(parameter[3].trim());
      if (parameter[2] === 'true') {
        args[parameterName] = text;
      } else {
        try {
          args[parameterName] = JSON.parse(text);
        } catch {
          return [];
        }
      }
      unmatchedParameters = unmatchedParameters.replace(parameter[0], '');
    }

    if (unmatchedParameters.trim()) return [];
    calls.push({
      id: `dsml-${round}-${calls.length}`,
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    });
    unmatched = unmatched.replace(invoke[0], '');
  }

  return calls.length > 0 && !unmatched.trim() ? calls : [];
}

export async function runToolLoop(input: {
  apiKey: string;
  model: string;
  system: string;
  userMessages: DeepSeekMessage[];
  tools: DeepSeekTool[];
  execute: ToolExecutor;
  maxRounds?: number;
  maxCalls?: number;
  complete?: ToolCompletion;
  onToolResult?(event: ToolResultEvent): void;
}): Promise<{
  answer: string;
  trace: ToolTraceEntry[];
  capExhausted: boolean;
  truncated: boolean;
  usage: { calls: number; promptTokens: number; completionTokens: number };
}> {
  // Budget sweep (2026-06-26, cat2+cat4 tools-on): accuracy 45→55/80 as rounds 6→12, plateauing at 12
  // (16 adds only +2 for +16% tokens). ~half of multi-step questions truncate below rounds=12. Default
  // raised 4→12 / 8→24 (rounds is the binding constraint; calls=24 rarely saturates). See
  // project_retrieval_vs_endtoend_gap memory + docs/AGENT_MEMORY_SYSTEM_PROMPT.md budget note.
  const maxRounds = input.maxRounds ?? envPositiveInt('MR_AGENT_MAX_ROUNDS', 12);
  const maxCalls = input.maxCalls ?? envPositiveInt('MR_AGENT_MAX_CALLS', 24);
  const complete = input.complete ?? deepseekChatCompletion;
  const messages: DeepSeekMessage[] = [
    { role: 'system', content: input.system },
    ...input.userMessages,
  ];
  const trace: ToolTraceEntry[] = [];
  const usage = { calls: 0, promptTokens: 0, completionTokens: 0 };
  let truncated = false;

  function recordUsage(completion: DeepSeekCompletion): void {
    usage.calls++;
    usage.promptTokens += completion.usage.promptTokens;
    usage.completionTokens += completion.usage.completionTokens;
    // Truncation silently corrupts scores; surface it (preflight should prevent it).
    if (completion.finishReason === 'length') {
      truncated = true;
      console.warn(
        `[tool-llm] ${input.model} hit max_tokens (finish_reason=length); ` +
        'answer may be truncated. Raise DEEPSEEK_MAX_TOKENS.',
      );
    }
  }

  // A DSML marker in the answer means the model emitted tool markup instead of a
  // real reply (possibly via the reasoning_content fallback); treat as no answer.
  function extractAnswer(message: DeepSeekMessage): string {
    const answer = extractContent(message);
    return answer.includes(DSML_MARKER) ? '' : answer;
  }

  for (let round = 0; round < maxRounds; round++) {
    const completion = await complete({
      apiKey: input.apiKey,
      model: input.model,
      messages,
      tools: input.tools,
    });
    recordUsage(completion);
    const structuredCalls = completion.message.tool_calls ?? [];
    const dsmlCalls = structuredCalls.length > 0
      ? undefined
      : parseDsmlToolCalls(completion.message.content, input.tools, round);
    if (dsmlCalls?.length === 0) {
      messages.push(completion.message, {
        role: 'user',
        content: DSML_RETRY_MESSAGE,
      });
      continue;
    }
    const calls = structuredCalls.length > 0 ? structuredCalls : dsmlCalls ?? [];
    if (calls.length === 0) {
      return {
        answer: extractAnswer(completion.message),
        trace,
        capExhausted: false,
        truncated,
        usage,
      };
    }

    const remaining = maxCalls - trace.length;
    if (remaining <= 0) break;
    const acceptedCalls = calls.slice(0, remaining);
    messages.push({
      ...completion.message,
      content: dsmlCalls ? null : completion.message.content ?? null,
      tool_calls: acceptedCalls,
    });

    for (const call of acceptedCalls) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      // A tool exception (e.g. a regex-metachar query, malformed data) must NOT abort the
      // whole multi-hour run. Degrade to a tool-error result so the agent answers without
      // this tool and the question still gets cached (resume won't loop on it forever).
      let executed: string | { content: string; resultCount?: number };
      try {
        executed = await input.execute(call.function.name, args);
      } catch (err) {
        console.warn(`[tool-error] ${call.function.name}: ${(err as Error)?.message ?? String(err)}`);
        executed = { content: `tool error: ${(err as Error)?.message ?? String(err)}` };
      }
      const result = typeof executed === 'string'
        ? { content: executed }
        : executed;
      trace.push({
        name: call.function.name,
        args,
      });
      input.onToolResult?.({
        name: call.function.name,
        args,
        content: result.content,
        ...(result.resultCount === undefined ? {} : { resultCount: result.resultCount }),
      });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result.content,
      });
    }

    if (acceptedCalls.length < calls.length || trace.length >= maxCalls) break;
  }

  // 回合用盡的收尾:明確要求停用工具、純文字作答,避免模型仍吐 DSML 工具呼叫
  // 而被當成空答案(graceful finalization)。
  messages.push({
    role: 'user',
    content:
      '你已無法再使用任何工具。請根據以上已取得的資訊,直接用純文字給出最終答案;' +
      '若資訊不足以回答,就明確說明無法回答。不要輸出任何工具呼叫或 DSML 標記。',
  });
  const final = await complete({
    apiKey: input.apiKey,
    model: input.model,
    messages,
  });
  recordUsage(final);
  return {
    answer: extractAnswer(final.message),
    trace,
    capExhausted: true,
    truncated,
    usage,
  };
}
