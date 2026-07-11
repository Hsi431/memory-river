#!/usr/bin/env node

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';

import {
  createMemoryRiver,
  OllamaEmbedding,
  type ContextMessage,
  type LlmClient,
} from '@memory-river/core';
import { runAgent } from './agent.js';

class OpenAICompatibleClient implements LlmClient {
  constructor(
    private readonly endpoint: string,
    private readonly model: string,
    private readonly apiKey?: string,
  ) {}

  async generate(prompt: string, opts?: { maxTokens?: number }): Promise<string> {
    const response = await fetch(`${this.endpoint.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: opts?.maxTokens,
      }),
    });
    if (!response.ok) throw new Error(`LLM request failed (${response.status}): ${await response.text()}`);
    const body = await response.json() as any;
    return body.choices?.[0]?.message?.content ?? '';
  }
}

const demoDir = path.join(os.homedir(), '.memory-river-demo');
const ramDir = path.join(demoDir, 'ram');
fs.mkdirSync(demoDir, { recursive: true });
fs.mkdirSync(ramDir, { recursive: true });

const ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const llm = new OpenAICompatibleClient(
  process.env.OPENAI_BASE_URL ?? `${ollamaUrl}/v1`,
  process.env.OPENAI_MODEL ?? 'qwen3:8b',
  process.env.OPENAI_API_KEY,
);
const embedder = new OllamaEmbedding({
  provider: 'ollama',
  apiKey: '',
  model: 'hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF',
  dimensions: 1024,
  ollamaUrl,
});
const river = createMemoryRiver({ dataDir: demoDir, ramDir }, { embedder, llm });

function usage(): never {
  console.error('Usage: mr remember "text" | mr recall "query" | mr chat | mr agent');
  process.exitCode = 1;
  throw new Error('invalid command');
}

async function chat(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const history: ContextMessage[] = [];
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    history.push({ role: 'user', content: text });
    const assembled = await river.assembleContext(history);
    const injected = assembled.messages.filter(message => !history.includes(message));
    console.log(`[memory context]\n${injected.length ? JSON.stringify(injected, null, 2) : '(none)'}`);
    const reply = await llm.generate(JSON.stringify(assembled.messages), { maxTokens: 1000 });
    console.log(reply);
    history.push({ role: 'assistant', content: reply });
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  await river.start();
  process.once('SIGINT', async () => {
    await river.stop();
    process.exit(130);
  });
  process.once('SIGTERM', async () => {
    await river.stop();
    process.exit(143);
  });
  try {
    if (command === 'remember') {
      const text = args.join(' ').trim();
      if (!text) usage();
      await river.remember(text);
      console.log('remembered');
      return;
    }
    if (command === 'recall') {
      const query = args.join(' ').trim();
      if (!query) usage();
      console.log(JSON.stringify(await river.recall(query), null, 2));
      return;
    }
    if (command === 'chat') {
      await chat();
      return;
    }
    if (command === 'agent') {
      await runAgent(river);
      return;
    }
    usage();
  } finally {
    await river.stop();
  }
}

main().catch(error => {
  if (error?.message !== 'invalid command') console.error(error);
  process.exitCode = 1;
});
