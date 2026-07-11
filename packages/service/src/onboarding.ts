import * as readline from 'node:readline';

import {
  defaultOnboardingConfig,
  readOnboardingConfig,
  writeOnboardingConfig,
  type OnboardingConfig,
} from '@memory-river/adapter-mcp';

export const INIT_TEXT = {
  embedding: [
    'Embedding provider — powers all memory search.',
    '  Note: semi-permanent. Switching later requires re-indexing every stored memory.',
    '    ollama [model]                         local & private; needs a running Ollama',
    '    openai <base-url> <model> [api-key]    any OpenAI-compatible embedding API',
    'Embedding',
  ].join('\n'),
  concentration: [
    'Distillation LLM — condenses conversations into durable memories.',
    '  "skip" = degraded mode: transcripts and recall still work; no automatic distillation.',
    '    gemini <api-key> | deepseek <api-key> | skip',
    'Distillation',
  ].join('\n'),
  dataDir: 'Data directory (memories, transcripts and WAL live here)',
  done: 'Configuration saved. Next: run "mr doctor" to verify your environment.',
  usage: 'Usage: mr init [--yes]',
  embeddingError: 'Embedding must be "ollama [model]" or "openai <base-url> <model> [api-key]".',
  concentrationError: 'Distillation must be "gemini <api-key>", "deepseek <api-key>", or "skip".',
} as const;

type Prompt = (question: string) => Promise<string>;

function parseEmbedding(answer: string, defaults: OnboardingConfig['embedding']): OnboardingConfig['embedding'] {
  if (!answer.trim()) return defaults;
  const [provider, ...parts] = answer.trim().split(/\s+/);
  if (provider === 'ollama') return { ...defaults, provider, model: parts.join(' ') || defaults.model };
  if (provider === 'openai' && parts.length >= 2) {
    const [baseUrl, model, apiKey] = parts;
    return { ...defaults, provider, baseUrl, model, ...(apiKey ? { apiKey } : {}) };
  }
  throw new Error(INIT_TEXT.embeddingError);
}

function parseConcentration(answer: string, defaults: OnboardingConfig['concentration']): OnboardingConfig['concentration'] {
  if (!answer.trim()) return defaults;
  if (answer.trim() === 'skip') return { provider: 'degraded' };
  const [provider, apiKey] = answer.trim().split(/\s+/, 2);
  if ((provider === 'gemini' || provider === 'deepseek') && apiKey) {
    return { provider, apiKey };
  }
  throw new Error(INIT_TEXT.concentrationError);
}

function createReadlinePrompt(): { prompt: Prompt; close(): void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    prompt: question => new Promise(resolve => rl.question(`${question}: `, resolve)),
    close: () => rl.close(),
  };
}

export async function runInit(options: {
  yes?: boolean;
  configPath?: string;
  prompt?: Prompt;
  write?: (line: string) => void;
} = {}): Promise<OnboardingConfig> {
  const existing = readOnboardingConfig(options.configPath) ?? defaultOnboardingConfig();
  let config = existing;
  let readlinePrompt: ReturnType<typeof createReadlinePrompt> | undefined;
  const prompt = options.prompt ?? (() => {
    readlinePrompt = createReadlinePrompt();
    return readlinePrompt.prompt;
  })();
  try {
    if (!options.yes) {
      config = {
        ...config,
        embedding: parseEmbedding(await prompt(`${INIT_TEXT.embedding} [${config.embedding.provider} ${config.embedding.model}]`), config.embedding),
        concentration: parseConcentration(await prompt(`${INIT_TEXT.concentration} [${config.concentration.provider}]`), config.concentration),
      };
      const dataDir = (await prompt(`${INIT_TEXT.dataDir} [${config.dataDir}]`)).trim();
      if (dataDir) config = { ...config, dataDir };
    }
    writeOnboardingConfig(config, options.configPath);
    (options.write ?? console.log)(INIT_TEXT.done);
    return config;
  } finally {
    readlinePrompt?.close();
  }
}
