import * as fs from 'node:fs';

import {
  loadLocomo,
  locomoDatasetPath,
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

type Cat5Qa = ConvQa & { adversarialAnswer?: string; adversarial_answer?: string };

function cat5QaKey(sampleId: string, question: string): string {
  return `${sampleId}\u0000${question}`;
}

function loadCat5AdversarialAnswers(): Map<string, string> {
  const raw = JSON.parse(fs.readFileSync(locomoDatasetPath(), 'utf8')) as Array<{
    sample_id?: unknown;
    qa?: Array<{
      question?: unknown;
      category?: unknown;
      adversarial_answer?: unknown;
    }>;
  }>;
  const answers = new Map<string, string>();
  for (const sample of raw) {
    const sampleId = String(sample.sample_id ?? '');
    for (const qa of sample.qa ?? []) {
      if (Number(qa.category) !== 5) continue;
      if (typeof qa.adversarial_answer !== 'string' && typeof qa.adversarial_answer !== 'number') continue;
      answers.set(cat5QaKey(sampleId, String(qa.question ?? '')), String(qa.adversarial_answer));
    }
  }
  return answers;
}

export async function gradeLocomoAnswer(
  judge: { generate(prompt: string): Promise<string> },
  qa: Cat5Qa,
  candidate: string,
): Promise<GradeResult> {
  if (qa.category === '5') {
    const adversarialAnswer = qa.adversarialAnswer ?? qa.adversarial_answer ?? '';
    const verdict = (await judge.generate(
      `Grade this LoCoMo category-5 adversarial question.\n` +
      `The question contains a false premise or attribution. The adversarial answer below is bait, not gold.\n` +
      `Question: ${qa.question}\n` +
      `Adversarial answer (bait, not gold): ${String(adversarialAnswer)}\n` +
      `Candidate answer: ${candidate}\n\n` +
      `Reply YES only if the candidate explicitly abstains because the premise is unsupported, or correctly ` +
      `corrects the false premise or attribution. Reply NO if it accepts, repeats, or merely paraphrases ` +
      `the bait, or if it is unrelated. Merely mentioning a different name is not enough: a correction must ` +
      `explicitly reject the false attribution. Reply with exactly YES or NO.`,
    )).trim().toUpperCase();
    const normalizeBaitAnswer = (value: string): string => value.trim().toLowerCase().replace(/[\p{P}\p{S}]+/gu, '').replace(/\s+/g, ' ');
    if (normalizeBaitAnswer(candidate) === normalizeBaitAnswer(String(adversarialAnswer))) {
      return { correct: false, parseFailure: false };
    }
    if (verdict === 'YES') return { correct: true, parseFailure: false };
    if (verdict === 'NO') return { correct: false, parseFailure: false };
    return { correct: false, parseFailure: true };
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

function toConvSet(
  conversation: ReturnType<typeof loadLocomo>[number],
  adversarialAnswers: Map<string, string>,
): ConvSet {
  return {
    sampleId: conversation.sampleId,
    sessions: conversation.sessions.map(session => ({
      index: session.index,
      dateTime: session.dateTime,
      turns: session.turns,
      messages: session.messages,
    })),
    qa: conversation.qa.map((qa: LocomoQa): ConvQa => {
      const base: ConvQa = {
        question: qa.question,
        answer: qa.answer,
        evidence: qa.evidence,
        category: String(qa.category),
        sourceIndex: qa.sourceIndex,
      };
      if (qa.category !== 5) return base;
      return {
        ...base,
        adversarialAnswer: adversarialAnswers.get(cat5QaKey(conversation.sampleId, qa.question)) ?? '',
      } as Cat5Qa;
    }),
  };
}

export async function runLocomoBenchmark(
  options: BenchmarkOptions = {},
): Promise<BenchmarkResult> {
  // MR_LOCOMO_CONVERSATIONS=conv-47,conv-50 限定只跑指定的 conversation
  // (--limit 只能取前 N 個,無法挑中間的)。空值或未設 = 全部。
  const only = (process.env.MR_LOCOMO_CONVERSATIONS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const loaded = loadLocomo()
    .filter(conversation => only.length === 0 || only.includes(conversation.sampleId))
    .slice(0, options.limit ?? undefined);
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
  const adversarialAnswers = loadCat5AdversarialAnswers();
  // MR_LOCOMO_MAX_SESSIONS=2 只吃每個 conversation 的前 N 個 session(排空煙霧測試用,
  // 不是完整評測 —— 被砍掉的 session 裡的證據就答不出來)。未設或 0 = 全部。
  const maxSessions = Number(process.env.MR_LOCOMO_MAX_SESSIONS ?? 0);
  return runConversationBenchmark(
    sampled.map(conversation => toConvSet(conversation, adversarialAnswers)).map(conversation => maxSessions > 0
      ? { ...conversation, sessions: conversation.sessions.slice(0, maxSessions) }
      : conversation),
    { dimensionName: 'locomo', gradeQuestion: gradeLocomoAnswer },
    // Slice is already applied above; pass remaining options without limit.
    { ...options, limit: undefined },
  );
}
