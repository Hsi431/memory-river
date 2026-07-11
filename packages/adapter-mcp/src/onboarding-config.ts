import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type OnboardingEmbeddingProvider = 'ollama' | 'openai';
export type OnboardingConcentrationProvider = 'gemini' | 'deepseek' | 'degraded';

export interface OnboardingConfig {
  dataDir: string;
  storageMode: 'auto' | 'ram' | 'ssd';
  embedding: {
    provider: OnboardingEmbeddingProvider;
    model: string;
    baseUrl?: string;
    apiKey?: string;
    dimensions?: number;
  };
  concentration: {
    provider: OnboardingConcentrationProvider;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  };
}

export function defaultOnboardingConfig(): OnboardingConfig {
  return {
    dataDir: path.join(os.homedir(), '.memory-river'),
    storageMode: 'auto',
    embedding: {
      provider: 'ollama',
      model: 'hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF',
      baseUrl: 'http://localhost:11434',
      dimensions: 1024,
    },
    concentration: { provider: 'degraded' },
  };
}

export function onboardingConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MEMORY_RIVER_CONFIG?.trim() || path.join(os.homedir(), '.memory-river', 'config.json');
}

export function readOnboardingConfig(configPath = onboardingConfigPath()): OnboardingConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<OnboardingConfig>;
    const defaults = defaultOnboardingConfig();
    if (!parsed || typeof parsed !== 'object') throw new Error('config must be a JSON object');
    return {
      ...defaults,
      ...parsed,
      embedding: { ...defaults.embedding, ...parsed.embedding },
      concentration: { ...defaults.concentration, ...parsed.concentration },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`cannot read Memory River config: ${error instanceof Error ? error.message : error}`);
  }
}

export function writeOnboardingConfig(config: OnboardingConfig, configPath = onboardingConfigPath()): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
}
