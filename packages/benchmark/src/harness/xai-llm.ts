import { xaiApiKey } from './provider-keys.js';

// 判「候選答案是否等價於參考答案」不需要推理模型:實測 grok-4.3 / 4.6 為了回一個
// YES 會燒掉一兩百個 reasoning token,而 non-reasoning 版本 700ms 回完、零 reasoning。
// 之所以不用 DeepSeek 當裁判:答題 agent 就是 deepseek-v4-flash,同一支模型改自己的
// 考卷會偏向接受自己的措辭。裁判必須跟考生不同家。
const DEFAULT_MODEL = 'grok-4-1-fast-non-reasoning';
const DEFAULT_BASE_URL = 'https://api.x.ai';

export interface XaiJudge {
  readonly model: string;
  readonly stats: { calls: number; promptTokens: number; completionTokens: number };
  generate(prompt: string): Promise<string>;
}

export function xaiJudgeAvailable(): boolean {
  return !!xaiApiKey();
}

export function createXaiJudge(
  model = process.env.XAI_JUDGE_MODEL ?? DEFAULT_MODEL,
): XaiJudge {
  const apiKey = xaiApiKey();
  const baseUrl = (process.env.XAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const stats = { calls: 0, promptTokens: 0, completionTokens: 0 };

  return {
    model,
    stats,
    async generate(prompt: string): Promise<string> {
      const body = JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 256,
      });
      // 跟 Gemini 那支一樣的重試策略:429 與 5xx 退避重試,其餘直接拋。
      const maxAttempts = 5;
      let res: Response | undefined;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          res = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body,
          });
          if (res.ok) break;
          const transient = res.status === 429 || res.status >= 500;
          if (!transient || attempt === maxAttempts) {
            throw new Error(`xAI judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
          }
        } catch (err) {
          lastErr = err;
          if (attempt === maxAttempts) throw err;
        }
        const delayMs = Math.min(16000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      if (!res || !res.ok) {
        throw (lastErr instanceof Error ? lastErr : new Error('xAI judge failed after retries'));
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      stats.calls++;
      stats.promptTokens += data.usage?.prompt_tokens ?? 0;
      stats.completionTokens += data.usage?.completion_tokens ?? 0;
      return (data.choices?.[0]?.message?.content ?? '').trim();
    },
  };
}
