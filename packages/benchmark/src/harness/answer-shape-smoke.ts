/**
 * Pre-flight answer-shape smoke gate.
 *
 * Runs a handful of prompts against the configured answer model and verifies the
 * harness actually captures its output BEFORE a full benchmark is launched. A
 * heavy reasoning model can spend its whole token budget on chain-of-thought and
 * return an empty `content` (finish_reason=length); that silently scores every
 * question wrong (see HANDOFF 2026-06-17 §4c — pro burned 5.7h with 35% empty
 * answers). This gate catches that in seconds and is model-agnostic: point it at
 * any model via DEEPSEEK_MODEL and it reports where the answer lands.
 *
 * Run:  DEEPSEEK_MODEL=deepseek-v4-pro node dist/harness/answer-shape-smoke.js
 * Exits non-zero (blocks the run) if any prompt yields an empty answer or is
 * truncated by max_tokens.
 */

import { fileURLToPath } from 'node:url';

import { deepseekApiKey } from './provider-keys.js';
import { deepseekChatCompletion, extractContent } from './deepseek-llm.js';

// Mix of light and reasoning-heavy prompts; the temporal one provokes the
// worst case (lots of hidden reasoning before any visible answer).
const PROMPTS = [
  'Answer in one short sentence: what is the capital of France?',
  'A conversation on 2026-05-10 says "we met last Friday". Give only the ISO date (YYYY-MM-DD) of that Friday.',
  'If today is 2026-06-18 (a Thursday), give only the ISO date of next Friday.',
  'List exactly three primary colors, comma-separated, nothing else.',
  'In two words, summarize: the harness was dropping reasoning-model output.',
] as const;

export interface ShapeProbe {
  prompt: string;
  finishReason: string;
  contentEmpty: boolean;
  reasoningOnly: boolean; // content empty but reasoning_content had text
  truncated: boolean; // finish_reason === 'length'
  answer: string; // what extractContent() would hand the benchmark
}

export interface ShapeReport {
  model: string;
  probes: ShapeProbe[];
  nonEmptyRate: number;
  reasoningOnlyCount: number;
  truncatedCount: number;
  pass: boolean;
}

export async function checkAnswerShape(
  prompts: readonly string[] = PROMPTS,
): Promise<ShapeReport> {
  const apiKey = deepseekApiKey();
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set');
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';

  const probes: ShapeProbe[] = [];
  for (const prompt of prompts) {
    const completion = await deepseekChatCompletion({
      apiKey,
      model,
      messages: [{ role: 'user', content: prompt }],
    });
    const contentEmpty = !completion.message.content?.trim();
    const reasoning = completion.message.reasoning_content?.trim() ?? '';
    probes.push({
      prompt,
      finishReason: completion.finishReason,
      contentEmpty,
      reasoningOnly: contentEmpty && reasoning.length > 0,
      truncated: completion.finishReason === 'length',
      answer: extractContent(completion.message),
    });
  }

  const nonEmpty = probes.filter(p => p.answer.trim().length > 0).length;
  const report: ShapeReport = {
    model,
    probes,
    nonEmptyRate: nonEmpty / probes.length,
    reasoningOnlyCount: probes.filter(p => p.reasoningOnly).length,
    truncatedCount: probes.filter(p => p.truncated).length,
    pass: nonEmpty === probes.length && probes.every(p => !p.truncated),
  };
  return report;
}

function printReport(r: ShapeReport): void {
  console.log(`\nanswer-shape smoke — model=${r.model}`);
  for (const p of r.probes) {
    const flags = [
      p.contentEmpty ? 'content-EMPTY' : 'content-ok',
      p.reasoningOnly ? 'reasoning-only-FALLBACK' : '',
      p.truncated ? 'TRUNCATED(length)' : '',
    ].filter(Boolean).join(' ');
    console.log(`  [${flags}] finish=${p.finishReason} :: ${p.answer.slice(0, 60) || '<empty>'}`);
  }
  console.log(
    `\n  nonEmptyRate=${(r.nonEmptyRate * 100).toFixed(0)}% ` +
    `reasoningOnly=${r.reasoningOnlyCount} truncated=${r.truncatedCount}`,
  );
  console.log(
    r.pass
      ? '  PASS — harness captures this model. Safe to run the full benchmark.'
      : '  FAIL — answers would be dropped/truncated. Fix harness (raise DEEPSEEK_MAX_TOKENS / reasoning fallback) before a full run.',
  );
}

// Run as a script (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  checkAnswerShape()
    .then(report => {
      printReport(report);
      process.exit(report.pass ? 0 : 1);
    })
    .catch(err => {
      console.error('answer-shape smoke failed:', err);
      process.exit(2);
    });
}
