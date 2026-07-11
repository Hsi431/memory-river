import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type ProviderName = 'google' | 'deepseek';

function configuredProviderKey(provider: ProviderName): string {
  try {
    const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      providers?: Record<string, { apiKey?: unknown }>;
      models?: { providers?: Record<string, { apiKey?: unknown }> };
    };
    const value =
      config.providers?.[provider]?.apiKey ??
      config.models?.providers?.[provider]?.apiKey;
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

export function geminiApiKey(): string {
  return process.env.GEMINI_API_KEY ?? configuredProviderKey('google');
}

export function deepseekApiKey(): string {
  return process.env.DEEPSEEK_API_KEY ?? configuredProviderKey('deepseek');
}
