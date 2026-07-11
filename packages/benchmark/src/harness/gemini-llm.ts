import { geminiApiKey } from './provider-keys.js';

const DEFAULT_MODEL = 'gemini-2.5-flash';

export interface GeminiJudge {
  readonly model: string;
  readonly stats: { calls: number; promptTokens: number; completionTokens: number };
  generate(prompt: string): Promise<string>;
}

export function geminiJudgeAvailable(): boolean {
  return !!geminiApiKey();
}

export function createGeminiJudge(
  model = process.env.GEMINI_JUDGE_MODEL ?? DEFAULT_MODEL,
): GeminiJudge {
  const apiKey = geminiApiKey();
  const stats = { calls: 0, promptTokens: 0, completionTokens: 0 };

  return {
    model,
    stats,
    async generate(prompt: string): Promise<string> {
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
        `:generateContent?key=${encodeURIComponent(apiKey)}`;
      const body = JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 256,
        },
      });
      // Gemini (flash-lite) is flaky: 429 rate limits + 503 UNAVAILABLE spikes + transient
      // network errors. Retry transient failures with exponential backoff + jitter so a single
      // hiccup doesn't abort the whole benchmark. Non-transient errors (4xx other than 429) throw.
      const maxAttempts = 5;
      let res: Response | undefined;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          });
          if (res.ok) break;
          const transient = res.status === 429 || res.status >= 500;
          if (!transient || attempt === maxAttempts) {
            throw new Error(`Gemini judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
          }
        } catch (err) {
          lastErr = err;
          if (attempt === maxAttempts) throw err;
        }
        const delayMs = Math.min(16000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      if (!res || !res.ok) {
        throw (lastErr instanceof Error ? lastErr : new Error('Gemini judge failed after retries'));
      }
      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
        };
      };
      stats.calls++;
      stats.promptTokens += data.usageMetadata?.promptTokenCount ?? 0;
      stats.completionTokens += data.usageMetadata?.candidatesTokenCount ?? 0;
      return data.candidates?.[0]?.content?.parts
        ?.map(part => part.text ?? '')
        .join('')
        .trim() ?? '';
    },
  };
}
