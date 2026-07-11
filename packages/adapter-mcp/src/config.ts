import * as os from 'node:os';
import * as path from 'node:path';

import {
  createMemoryRiver,
  OllamaEmbedding,
  type EmbeddingProvider,
  type LlmClient,
  type MemoryRiver,
} from '@memory-river/core';
import { readOnboardingConfig, type OnboardingConfig } from './onboarding-config.js';

class OpenAICompatibleClient implements LlmClient {
  constructor(
    private readonly endpoint: string,
    private readonly model: string,
    private readonly apiKey?: string,
    private readonly timeoutMs = 60_000,
  ) {}

  async generate(prompt: string, opts?: { maxTokens?: number }): Promise<string> {
    const response = await fetch(`${this.endpoint.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: opts?.maxTokens,
      }),
    });
    if (!response.ok) {
      throw new Error(`LLM request failed (${response.status}): ${await response.text()}`);
    }
    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }>;
    };
    // Reasoning models (e.g. deepseek-v4-flash) may leave content empty and put
    // the answer in reasoning_content; fall back so concentration isn't dropped.
    const message = body.choices?.[0]?.message;
    return (message?.content?.trim() || message?.reasoning_content?.trim()) ?? '';
  }
}

class OpenAICompatibleEmbedding implements EmbeddingProvider {
  constructor(
    private readonly endpoint: string,
    private readonly model: string,
    private readonly apiKey: string | undefined,
    private readonly dimensions: number,
  ) {}

  getDimensions(): number {
    return this.dimensions;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.embed('memory-river health check');
      return true;
    } catch {
      return false;
    }
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.endpoint.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!response.ok) throw new Error(`embedding request failed (${response.status}): ${await response.text()}`);
    const body = await response.json() as { data?: Array<{ embedding?: number[] }> };
    const embedding = body.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) throw new Error('embedding response did not contain a vector');
    return embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(text => this.embed(text)));
  }
}

export interface AdapterConfig {
  dataDir: string;
  ramDir: string;
  storageMode: 'auto' | 'ram' | 'ssd';
  sessionKey: string;
  ollamaUrl: string;
  embeddingModel: string;
  embeddingProvider: 'ollama' | 'openai';
  embeddingApiKey?: string;
  embeddingDimensions: number;
  concentration: OnboardingConfig['concentration'];
  llm?: LlmClient;
}

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function llmFromEnv(): LlmClient | undefined {
  const apiKey = firstEnv('MEMORY_RIVER_LLM_API_KEY', 'OPENAI_API_KEY');
  const baseUrl = firstEnv('MEMORY_RIVER_LLM_BASE_URL', 'OPENAI_BASE_URL');
  const model = firstEnv('MEMORY_RIVER_LLM_MODEL', 'OPENAI_MODEL');
  if (!apiKey && !baseUrl && !model) return undefined;
  const configuredTimeoutMs = Number(firstEnv('MEMORY_RIVER_LLM_TIMEOUT_MS'));
  return new OpenAICompatibleClient(
    baseUrl ?? 'https://api.openai.com/v1',
    model ?? 'gpt-4.1-mini',
    apiKey,
    Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0 ? configuredTimeoutMs : 60_000,
  );
}

export function configFromEnv(): AdapterConfig {
  const fileConfig = readOnboardingConfig();
  const defaults = fileConfig ?? undefined;
  const dataDir = firstEnv('MEMORY_RIVER_DATA_DIR', 'DATA_DIR')
    ?? defaults?.dataDir
    ?? path.join(os.homedir(), '.memory-river');
  const ramDir = firstEnv('MEMORY_RIVER_RAM_DIR', 'RAM_DIR')
    ?? path.join('/dev/shm', 'memory-river');
  return {
    dataDir,
    ramDir,
    storageMode: (firstEnv('MEMORY_RIVER_STORAGE_MODE') ?? defaults?.storageMode ?? 'auto') as AdapterConfig['storageMode'],
    sessionKey: firstEnv('MEMORY_RIVER_SESSION_KEY') ?? 'memory-river-mcp',
    ollamaUrl: firstEnv('MEMORY_RIVER_OLLAMA_URL', 'OLLAMA_URL', 'OLLAMA_BASE_URL')
      ?? defaults?.embedding.baseUrl
      ?? 'http://localhost:11434',
    embeddingModel: firstEnv('MEMORY_RIVER_EMBEDDING_MODEL', 'OLLAMA_EMBEDDING_MODEL')
      ?? defaults?.embedding.model
      ?? 'hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF',
    embeddingProvider: defaults?.embedding.provider ?? 'ollama',
    embeddingApiKey: defaults?.embedding.apiKey,
    embeddingDimensions: defaults?.embedding.dimensions ?? 1024,
    concentration: defaults?.concentration ?? { provider: 'degraded' },
    llm: llmFromEnv(),
  };
}

export function createRiverFromEnv(): {
  river: MemoryRiver;
  sessionKey: string;
  concentrationLlmConfigured: boolean;
} {
  const config = configFromEnv();
  const embedder: EmbeddingProvider = config.embeddingProvider === 'openai'
    ? new OpenAICompatibleEmbedding(
      config.ollamaUrl,
      config.embeddingModel,
      config.embeddingApiKey,
      config.embeddingDimensions,
    )
    : new OllamaEmbedding({
      provider: 'ollama',
      apiKey: '',
      model: config.embeddingModel,
      dimensions: config.embeddingDimensions,
      ollamaUrl: config.ollamaUrl,
      embeddingModel: config.embeddingModel,
    });
  return {
    river: createMemoryRiver(
      {
        dataDir: config.dataDir,
        ramDir: config.ramDir,
        storageMode: config.storageMode,
        embedding: {
          provider: config.embeddingProvider,
          model: config.embeddingModel,
          dimensions: config.embeddingDimensions,
        },
        concentration: config.concentration.provider === 'gemini'
          ? { provider: 'gemini', geminiApiKey: config.concentration.apiKey ?? '', model: config.concentration.model }
          : config.concentration.provider === 'deepseek'
            ? { provider: 'deepseek', deepseekApiKey: config.concentration.apiKey ?? '', deepseekModel: config.concentration.model }
            : undefined,
      },
      { embedder, llm: config.llm },
    ),
    sessionKey: config.sessionKey,
    concentrationLlmConfigured: config.llm !== undefined || config.concentration.provider !== 'degraded',
  };
}
