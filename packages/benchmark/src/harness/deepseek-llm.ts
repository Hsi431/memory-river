/**
 * DeepSeek V4 LLM client for the optional answer-level judge in Benchmark B2.
 *
 * DeepSeek (and other reasoning models, e.g. deepseek-v4-pro) put the verdict in
 * `message.content` while chain-of-thought lands in `message.reasoning_content`.
 * Reasoning tokens count as completion tokens, so a too-small `max_tokens` is spent
 * entirely on hidden reasoning and `content` comes back empty (finish_reason=length).
 * We therefore (a) set a generous, env-tunable token budget and (b) fall back to
 * `reasoning_content` via {@link extractContent} when `content` is empty, so a heavy
 * reasoning model's answer is never silently dropped.
 *
 * The judge only runs when DEEPSEEK_API_KEY is set, keeping the dimension's
 * deterministic retrieval metrics independent of any external API. Requests are
 * throttled and retried so a full sweep stays under provider rate limits.
 */

import type { LlmClient } from '@memory-river/core';

import { deepseekApiKey } from './provider-keys.js';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-v4-flash';
// Generous default so reasoning tokens don't exhaust the budget before `content`
// is emitted. Heavy reasoning models (pro) can override via DEEPSEEK_MAX_TOKENS.
function defaultMaxTokens(): number {
  const env = Number(process.env.DEEPSEEK_MAX_TOKENS);
  return Number.isInteger(env) && env >= 1 ? env : 2048;
}
const MAX_TOKENS = defaultMaxTokens();

export function judgeAvailable(): boolean {
  return !!deepseekApiKey();
}

/**
 * Extract a usable answer from a completion message: prefer `content`, but fall
 * back to `reasoning_content` when `content` is empty (reasoning model whose
 * budget was spent on chain-of-thought, leaving the answer only in the trace).
 */
export function extractContent(message: DeepSeekMessage): string {
  const content = message.content?.trim();
  if (content) return content;
  return message.reasoning_content?.trim() ?? '';
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>(resolve => this.queue.push(resolve));
    this.active++;
  }
  release(): void {
    this.active--;
    this.queue.shift()?.();
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const sharedSemaphore = new Semaphore(
  Number(process.env.DEEPSEEK_CONCURRENCY ?? 3) || 3,
);

export interface JudgeStats {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

export interface DeepSeekJudge extends LlmClient {
  readonly stats: JudgeStats;
}

export interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Chain-of-thought channel on reasoning models; answer falls back here when content is empty. */
  reasoning_content?: string | null;
  tool_call_id?: string;
  tool_calls?: DeepSeekToolCall[];
}

export interface DeepSeekToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface DeepSeekTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface DeepSeekCompletion {
  message: DeepSeekMessage;
  finishReason: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
}

export async function deepseekChatCompletion(input: {
  apiKey: string;
  model: string;
  messages: DeepSeekMessage[];
  tools?: DeepSeekTool[];
  maxTokens?: number;
  baseUrl?: string;
}): Promise<DeepSeekCompletion> {
  await sharedSemaphore.acquire();
  try {
    const baseUrl = (input.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${input.apiKey}`,
          },
          body: JSON.stringify({
            model: input.model,
            messages: input.messages,
            ...(input.tools ? { tools: input.tools, tool_choice: 'auto' } : {}),
            max_tokens: input.maxTokens ?? MAX_TOKENS,
            temperature: 0,
          }),
        });
      } catch (err) {
        if (attempt === maxAttempts) throw err;
        const delayMs =
          Math.min(16000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
        await sleep(delayMs);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt === maxAttempts) {
          throw new Error(`DeepSeek HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        const delayMs =
          Math.min(16000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
        await sleep(delayMs);
        continue;
      }
      if (!res.ok) {
        throw new Error(`DeepSeek HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }

      const data = (await res.json()) as {
        choices?: Array<{
          finish_reason?: string;
          message?: DeepSeekMessage;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = data.choices?.[0];
      return {
        message: choice?.message ?? { role: 'assistant', content: '' },
        finishReason: choice?.finish_reason ?? '',
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? 0,
        },
      };
    }
    throw new Error('unreachable');
  } finally {
    sharedSemaphore.release();
  }
}

/**
 * Build a DeepSeek-backed LlmClient. Concurrency defaults to 3 to respect
 * rate limits; override with DEEPSEEK_CONCURRENCY.
 */
export function createDeepSeekJudge(
  onUsage?: (usage: DeepSeekCompletion['usage']) => void,
  opts?: { ingest?: boolean },
): DeepSeekJudge {
  // The engine's internal LLM (concentration / hooks / entities / conflict) is
  // pinned to a cheap, separate endpoint via the MR_INGEST_* envs (defaulting to
  // real DeepSeek flash), so an expensive answerer model — e.g. gpt served on the
  // proxy via DEEPSEEK_BASE_URL — is never burned on background ingest work.
  const ingest = opts?.ingest === true;
  const apiKey = deepseekApiKey();
  const model = ingest
    ? (process.env.MR_INGEST_MODEL ?? DEFAULT_MODEL)
    : (process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL);
  const baseUrl = ingest
    ? (process.env.MR_INGEST_BASE_URL ?? DEFAULT_BASE_URL)
    : undefined;
  const stats: JudgeStats = { calls: 0, promptTokens: 0, completionTokens: 0 };

  async function generate(
    prompt: string,
    opts?: { purpose?: string; maxTokens?: number },
  ): Promise<string> {
    const completion = await deepseekChatCompletion({
      apiKey,
      model,
      baseUrl,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: opts?.maxTokens,
    });
    stats.calls++;
    stats.promptTokens += completion.usage.promptTokens;
    stats.completionTokens += completion.usage.completionTokens;
    onUsage?.(completion.usage);
    return extractContent(completion.message);
  }

  return { generate, stats };
}
