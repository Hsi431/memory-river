import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

import {
  onboardingConfigPath,
  readOnboardingConfig,
  type OnboardingConfig,
} from '@memory-river/adapter-mcp';
import { getDevShmFreeBytes, MIN_RAM_DB_BYTES } from '@memory-river/core';

export const DOCTOR_TEXT = {
  names: {
    config: 'config',
    embedding: 'embedding',
    llm: 'LLM key',
    shm: '/dev/shm',
    port: 'service port',
    dataDir: 'data directory',
    wal: 'WAL',
  },
  readable: 'readable',
  notFound: 'not found',
  valid: 'valid',
  degraded: 'degraded mode selected',
  available: 'available',
  unavailable: 'unavailable',
  walReady: 'ready',
  missingApiKey: 'missing API key',
  config: 'Run "mr init" to create or repair the config.',
  embedding: 'Start the embedding service or correct its URL/model in the config.',
  llm: 'Add a valid distillation key with "mr init", or choose skip for degraded mode.',
  shm: 'Free /dev/shm space or set storageMode=ssd in the config.',
  port: 'Stop the process using the service port or set MR_SERVE_PORT to a free port.',
  dataDir: 'Choose a writable data directory with "mr init".',
  wal: 'Restore write access to the data directory; WAL is created on first start.',
  usage: 'Usage: mr doctor',
} as const;

type CheckResult = { ok: boolean; detail: string; hint: string; critical: boolean };

export interface DoctorDependencies {
  readConfig: () => OnboardingConfig | null;
  probeEmbedding: (config: OnboardingConfig) => Promise<number>;
  probeLlm: (config: OnboardingConfig) => Promise<void>;
  getShmFreeBytes: () => number;
  checkPort: () => Promise<boolean>;
  checkDataDir: (dataDir: string) => Promise<boolean>;
  checkWal: (dataDir: string) => Promise<boolean>;
  write: (line: string) => void;
}

function endpoint(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/$/, '')}${suffix}`;
}

async function defaultEmbeddingProbe(config: OnboardingConfig): Promise<number> {
  const isOllama = config.embedding.provider === 'ollama';
  const response = await fetch(endpoint(config.embedding.baseUrl ?? 'http://localhost:11434', isOllama ? '/api/embeddings' : '/embeddings'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(!isOllama && config.embedding.apiKey ? { authorization: `Bearer ${config.embedding.apiKey}` } : {}),
    },
    body: JSON.stringify(isOllama
      ? { model: config.embedding.model, prompt: 'memory-river doctor' }
      : { model: config.embedding.model, input: 'memory-river doctor' }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as { embedding?: number[]; data?: Array<{ embedding?: number[] }> };
  const vector = body.embedding ?? body.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) throw new Error('response had no embedding vector');
  return vector.length;
}

async function defaultLlmProbe(config: OnboardingConfig): Promise<void> {
  if (!config.concentration.apiKey) throw new Error(DOCTOR_TEXT.missingApiKey);
  const isGemini = config.concentration.provider === 'gemini';
  const baseUrl = config.concentration.baseUrl ?? (isGemini
    ? 'https://generativelanguage.googleapis.com/v1beta'
    : 'https://api.deepseek.com');
  const model = config.concentration.model ?? (isGemini ? 'gemini-2.5-flash-lite' : 'deepseek-v4-flash');
  const url = isGemini
    ? endpoint(baseUrl, `/models/${model}:generateContent?key=${config.concentration.apiKey}`)
    : endpoint(baseUrl, '/chat/completions');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(!isGemini ? { authorization: `Bearer ${config.concentration.apiKey}` } : {}),
    },
    body: JSON.stringify(isGemini
      ? { contents: [{ parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 1 } }
      : { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

async function defaultPortCheck(): Promise<boolean> {
  const port = Number.parseInt(process.env.MR_SERVE_PORT ?? '4791', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return false;
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port }, () => server.close(() => resolve(true)));
  });
}

async function defaultDataDirCheck(dataDir: string): Promise<boolean> {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, `.doctor-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function defaultWalCheck(dataDir: string): Promise<boolean> {
  try {
    const walPath = path.join(dataDir, 'wal.jsonl');
    if (fs.existsSync(walPath)) fs.accessSync(walPath, fs.constants.R_OK | fs.constants.W_OK);
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
}

function defaultDependencies(configPath?: string): DoctorDependencies {
  return {
    readConfig: () => readOnboardingConfig(configPath ?? onboardingConfigPath()),
    probeEmbedding: defaultEmbeddingProbe,
    probeLlm: defaultLlmProbe,
    getShmFreeBytes: getDevShmFreeBytes,
    checkPort: defaultPortCheck,
    checkDataDir: defaultDataDirCheck,
    checkWal: defaultWalCheck,
    write: console.log,
  };
}

function report(deps: DoctorDependencies, name: string, result: CheckResult): CheckResult {
  deps.write(`${result.ok ? '✓' : '✗'} ${name}: ${result.detail}${result.ok ? '' : ` — ${result.hint}`}`);
  return result;
}

export async function runDoctor(options: { configPath?: string; deps?: Partial<DoctorDependencies> } = {}): Promise<number> {
  const defaults = defaultDependencies(options.configPath);
  const deps = { ...defaults, ...options.deps };
  let config: OnboardingConfig | null;
  try {
    config = deps.readConfig();
  } catch (error) {
    report(deps, DOCTOR_TEXT.names.config, { ok: false, detail: error instanceof Error ? error.message : String(error), hint: DOCTOR_TEXT.config, critical: true });
    return 1;
  }
  if (!config) {
    report(deps, DOCTOR_TEXT.names.config, { ok: false, detail: DOCTOR_TEXT.notFound, hint: DOCTOR_TEXT.config, critical: true });
    return 1;
  }

  const results: CheckResult[] = [report(deps, DOCTOR_TEXT.names.config, { ok: true, detail: DOCTOR_TEXT.readable, hint: DOCTOR_TEXT.config, critical: true })];
  try {
    const dimensions = await deps.probeEmbedding(config);
    results.push(report(deps, DOCTOR_TEXT.names.embedding, { ok: true, detail: `reachable (${dimensions} dimensions)`, hint: DOCTOR_TEXT.embedding, critical: true }));
  } catch (error) {
    results.push(report(deps, DOCTOR_TEXT.names.embedding, { ok: false, detail: error instanceof Error ? error.message : String(error), hint: DOCTOR_TEXT.embedding, critical: true }));
  }
  if (config.concentration.provider === 'degraded') {
    results.push(report(deps, DOCTOR_TEXT.names.llm, { ok: true, detail: DOCTOR_TEXT.degraded, hint: DOCTOR_TEXT.llm, critical: false }));
  } else {
    try {
      await deps.probeLlm(config);
      results.push(report(deps, DOCTOR_TEXT.names.llm, { ok: true, detail: DOCTOR_TEXT.valid, hint: DOCTOR_TEXT.llm, critical: true }));
    } catch (error) {
      results.push(report(deps, DOCTOR_TEXT.names.llm, { ok: false, detail: error instanceof Error ? error.message : String(error), hint: DOCTOR_TEXT.llm, critical: true }));
    }
  }
  const shmBytes = deps.getShmFreeBytes();
  const shmOk = config.storageMode !== 'ram' || shmBytes >= MIN_RAM_DB_BYTES;
  results.push(report(deps, DOCTOR_TEXT.names.shm, { ok: shmOk, detail: `${shmBytes} bytes free`, hint: DOCTOR_TEXT.shm, critical: config.storageMode === 'ram' }));
  const portOk = await deps.checkPort();
  results.push(report(deps, DOCTOR_TEXT.names.port, { ok: portOk, detail: portOk ? DOCTOR_TEXT.available : DOCTOR_TEXT.unavailable, hint: DOCTOR_TEXT.port, critical: true }));
  results.push(report(deps, DOCTOR_TEXT.names.dataDir, { ok: await deps.checkDataDir(config.dataDir), detail: config.dataDir, hint: DOCTOR_TEXT.dataDir, critical: true }));
  results.push(report(deps, DOCTOR_TEXT.names.wal, { ok: await deps.checkWal(config.dataDir), detail: DOCTOR_TEXT.walReady, hint: DOCTOR_TEXT.wal, critical: true }));
  return results.some(result => result.critical && !result.ok) ? 1 : 0;
}
