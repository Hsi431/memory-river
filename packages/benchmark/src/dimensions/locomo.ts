import {
  loadLocomo,
  type LocomoConversation,
  type LocomoQa,
} from '../harness/locomo.js';
import type { BenchmarkResult } from '../report.js';
import type { BenchmarkOptions } from './index.js';
import {
  runConversationBenchmark,
  type ConvSet,
  type ConvQa,
  type GradeResult,
} from './conversation-runner.js';

// createIdxRehydrator lives in locomo-rehydrator.ts; re-export so tests that
// import it from locomo.js continue to work unchanged.
export { createIdxRehydrator } from './locomo-rehydrator.js';

// ─── Abstention helper (exported for tests) ───────────────────────────────────

export function isAbstention(answer: string): boolean {
  const normalized = answer.toLowerCase().replace(/['']/g, "'");
  return [
    /\bi (?:do not|don't) know\b/,
    /\bnot mentioned\b/,
    /\bnot (?:stated|provided|available|specified)\b/,
    /\bno (?:relevant )?(?:information|context|answer)\b/,
    /\b(?:cannot|can't) (?:determine|tell|answer)\b/,
    /\bunknown\b/,
    // 中文拒答:Chinese-first 系統會用中文 abstain(DeepSeek 輸出簡繁混雜)。
    // 中文無詞界線故不用 \b;字元類別同時涵蓋簡/繁。從拒答語彙通則出發,非針對題目。
    /[無无]法(回答|[確确]定|判[斷断]|得知|找到|提供)/,
    /([沒没]有|找不到|查[無无]|未)(找到|提到|提及|相[關关]|[關关]于|關於)/,
    /[沒没]有.{0,8}([資资][訊讯]|[記记][憶忆]|[資资]料|[紀纪记][錄录]|[內内]容|[線线]索)/,
    /不知道/,
  ].some(pattern => pattern.test(normalized));
}

// ─── Locomo-specific grader: category 5 = unanswerable ───────────────────────

export async function gradeLocomoAnswer(
  judge: { generate(prompt: string): Promise<string> },
  qa: ConvQa,
  candidate: string,
): Promise<GradeResult> {
  if (qa.category === '5') {
    return { correct: isAbstention(candidate), parseFailure: false };
  }
  const verdict = (await judge.generate(
    `Grade whether the candidate answer is correct.\n` +
    `Question: ${qa.question}\nReference answer: ${String(qa.answer ?? '')}\n` +
    `Candidate answer: ${candidate}\n\n` +
    `Accept equivalent wording and concise answers. Reply with exactly YES or NO.`,
  )).trim().toUpperCase();
  if (verdict === 'YES') return { correct: true, parseFailure: false };
  if (verdict === 'NO') return { correct: false, parseFailure: false };
  return { correct: false, parseFailure: true };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 0x1_0000_0000;
  };
}

function shuffled<T>(items: T[], seed: number): T[] {
  const result = [...items];
  const random = seededRandom(seed);
  for (let index = result.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

export function sampleLocomo(
  conversations: LocomoConversation[],
  sampleSize: number,
  seed = 1,
): LocomoConversation[] {
  if (conversations.length === 0 || sampleSize < 1) return [];
  const totalQuestions = conversations.reduce((sum, conversation) => sum + conversation.qa.length, 0);
  const cappedSize = Math.min(sampleSize, totalQuestions);
  // Full run: when the caller asks for >= every question, return all qa per
  // conversation. The even per-conv distribution below caps uneven conversations
  // (105–260 qa) and cannot reach the true 1,986 total otherwise.
  const fullRun = cappedSize >= totalQuestions;
  const base = Math.floor(cappedSize / conversations.length);
  const remainder = cappedSize % conversations.length;
  const extraOrder = shuffled(
    conversations.map((_, index) => index),
    seed,
  );
  const extras = new Set(extraOrder.slice(0, remainder));

  return conversations.map((conversation, conversationIndex) => {
    const target = fullRun
      ? conversation.qa.length
      : Math.min(
          conversation.qa.length,
          base + (extras.has(conversationIndex) ? 1 : 0),
        );
    const buckets = new Map<number, Array<{ qa: LocomoQa; sourceIndex: number }>>();
    conversation.qa.forEach((qa, sourceIndex) => {
      const bucket = buckets.get(qa.category) ?? [];
      bucket.push({ qa, sourceIndex });
      buckets.set(qa.category, bucket);
    });
    const categories = [...buckets.keys()].sort((left, right) => left - right);
    const categoryOrder = categories.map(
      (_, index) => categories[(index + conversationIndex + Math.abs(seed)) % categories.length],
    );
    const shuffledBuckets = new Map(categoryOrder.map(category => [
      category,
      shuffled(buckets.get(category) ?? [], seed ^ ((conversationIndex + 1) * 1009 + category)),
    ]));
    const selected: Array<{ qa: LocomoQa; sourceIndex: number }> = [];
    let round = 0;
    while (selected.length < target) {
      let added = false;
      for (const category of categoryOrder) {
        const item = shuffledBuckets.get(category)?.[round];
        if (!item) continue;
        selected.push(item);
        added = true;
        if (selected.length === target) break;
      }
      if (!added) break;
      round++;
    }
    return {
      ...conversation,
      qa: selected.map(({ qa, sourceIndex }) => ({ ...qa, sourceIndex })),
    };
  }).filter(conversation => conversation.qa.length > 0);
}

function toConvSet(conversation: ReturnType<typeof loadLocomo>[number]): ConvSet {
  return {
    sampleId: conversation.sampleId,
    sessions: conversation.sessions.map(session => ({
      index: session.index,
      dateTime: session.dateTime,
      turns: session.turns,
      messages: session.messages,
    })),
    qa: conversation.qa.map((qa: LocomoQa): ConvQa => ({
      question: qa.question,
      answer: qa.answer,
      evidence: qa.evidence,
      category: String(qa.category),
      sourceIndex: qa.sourceIndex,
    })),
  };
}

export async function runLocomoBenchmark(
  options: BenchmarkOptions = {},
): Promise<BenchmarkResult> {
  const loaded = loadLocomo().slice(0, options.limit ?? undefined);
  // Filter to the requested category BEFORE sampling. sampleLocomo balances
  // across categories, so filtering afterwards (in the conversation runner)
  // would shrink an already category-balanced sample to a tiny per-category
  // slice. Pre-filtering makes --sample / --max-questions operate on the
  // target category's full pool.
  const conversations = options.category === undefined
    ? loaded
    : loaded
        .map(conversation => ({
          ...conversation,
          qa: conversation.qa.filter(qa => Number(qa.category) === options.category),
        }))
        .filter(conversation => conversation.qa.length > 0);
  const sampled = sampleLocomo(conversations, options.sample ?? 20, options.seed ?? 1);
  return runConversationBenchmark(
    sampled.map(toConvSet),
    { dimensionName: 'locomo', gradeQuestion: gradeLocomoAnswer },
    // Slice is already applied above; pass remaining options without limit.
    { ...options, limit: undefined },
  );
}
