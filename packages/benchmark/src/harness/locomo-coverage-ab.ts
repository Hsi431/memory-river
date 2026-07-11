#!/usr/bin/env node

/**
 * Benchmark-only decisive A/B for cat1 enumeration (does NOT touch packages/core).
 *
 * Tests the never-run question: when the answerer is given a *fixed* context built
 * from the recall@50 pool, does coverage-greedy SELECTION/ORDER beat baseline
 * (fusedScore) order on actual answer accuracy?
 *
 * Clean isolation per the Opus×Codex convergence:
 *  - tools OFF (the answerer sees only the injected fixed context, no self-retrieval),
 *  - raised token cap (removes the truncation confound),
 *  - same answerer model + judge + snapshot + question set; only the ordering of the
 *    fixed context differs between arms,
 *  - paired per-question accuracy; gate = coverage − baseline >= +5pp keeps the path alive.
 *
 * The reranker/MMR see only (query, memoryText); gold/reference answers are used only
 * by the judge after answering.
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CrossEncoderReranker, MMARCO_MMINILM_RERANKER_MODEL } from './cross-encoder-reranker.js';
import { mmrOrder, COVERAGE_MMR_LAMBDA } from './locomo-reranker-probe.js';
import { loadLocomo, type LocomoQa } from './locomo.js';
import { findSnapshotPath } from './locomo-provenance.js';
import { createRealMemoryRiver } from './real-river.js';
import { createRealEmbedder } from './real-embedder.js';
import { runToolLoop } from './tool-llm.js';
import { deepseekApiKey, geminiApiKey } from './provider-keys.js';
import { createGeminiJudge } from './gemini-llm.js';

const POOL_K = 50;

// Clean, tool-free answer prompt for the fixed-context A/B. The product otter
// prompt is all about memory_recall/rehydrate tool routing; with tools OFF that
// makes the reasoning model spin on absent tools and burn the whole token budget
// (rampant finish_reason=length). Both arms use this identical prompt, so the
// paired delta is unaffected; the enumeration stock-take is general (keys off the
// question's own phrasing, not any category label).
const ANSWER_PROMPT =
  'Answer the question using ONLY the numbered memory snippets provided below as context; they are recalled evidence. ' +
  'Before answering, privately: (1) extract every distinct item in the context that stands in the relationship the question asks about; ' +
  '(2) merge aliases and duplicates; (3) keep only items at least one snippet supports. ' +
  "If the question asks for several things (e.g. 'what/which ... are', 'list', 'mention'), your answer must include ALL evidence-supported items and none the context does not support. " +
  "Do not invent details. If the context does not contain the answer, say you don't know. Answer concisely.";

interface CoverageAbOptions {
  snapshotDir: string;
  conversations: string[]; // empty = all conversations with category-1 questions
  category: number;
  ks: number[];
  primaryK: number;
  lambda: number;
  maxTokens: number;
  threads: number;
  batchSize: number;
  reranker: 'mmarco' | 'bge';
  seed: number;
  outJson?: string;
  outMarkdown?: string;
}

type Arm = 'baseline' | 'coverage';

interface ArmCell {
  answer: string;
  answerChars: number;
  truncated: boolean;
  correct: boolean;
  parseFailure: boolean;
}

interface QuestionAb {
  sampleId: string;
  questionIndex: number;
  question: string;
  poolSize: number;
  armOrder: Arm[];
  perK: Record<number, Record<Arm, ArmCell>>;
}

interface KSummary {
  k: number;
  // both-parsed paired set (single shared denominator)
  pairs: number;
  baselineCorrect: number;
  coverageCorrect: number;
  baselineAccuracy: number;
  coverageAccuracy: number;
  absoluteDeltaPp: number;
  coverageOnlyWins: number;
  baselineOnlyWins: number;
  mcnemarP: number;
  // parse-fail bias (over all attempted questions)
  baselineParseFail: number;
  coverageParseFail: number;
  parseFailArmBiased: boolean;
  // length / truncation self-deception guards
  baselineTruncated: number;
  coverageTruncated: number;
  baselineMeanChars: number;
  coverageMeanChars: number;
  meanCharDeltaOnCoverageWins: number;
  lengthSuspect: boolean;
  verdict: 'go' | 'no-go' | 'invalid';
}

interface CoverageAbResult {
  label: string;
  description: string;
  antiCheat: string;
  conversations: string[];
  category: number;
  toolsEnabled: false;
  maxTokens: number;
  mmrLambda: number;
  rerankerModel: string;
  gatePp: number;
  primaryK: number;
  primaryVerdict: 'go' | 'no-go' | 'invalid';
  questions: QuestionAb[];
  summary: KSummary[];
  warnings: string[];
}

const GATE_PP = 0.05;
const MCNEMAR_ALPHA = 0.05;

function usage(): void {
  console.error(
    'Usage: node dist/harness/locomo-coverage-ab.js --snapshot-dir DIR ' +
    '[--conversations all|conv-26,conv-30] [--category 1] [--ks 10,20] [--primary-k 10] ' +
    '[--mmr-lambda 0.5] [--max-tokens 8192] [--threads 4] [--batch-size 8] [--seed 42] ' +
    '[--out-json FILE] [--out-md FILE]',
  );
}

function parseList(value: string | undefined, what: string): string[] {
  const items = (value ?? '').split(',').map(item => item.trim()).filter(Boolean);
  if (items.length === 0) throw new Error(`${what} requires a comma-separated list`);
  return items;
}

function parseArgs(args: string[]): CoverageAbOptions {
  const options: CoverageAbOptions = {
    snapshotDir: '',
    conversations: [],
    category: 1,
    ks: [10, 20],
    primaryK: 10,
    lambda: COVERAGE_MMR_LAMBDA,
    maxTokens: 8192,
    threads: 4,
    batchSize: 8,
    reranker: 'mmarco',
    seed: 42,
  };
  const rest = [...args];
  while (rest.length > 0) {
    const option = rest.shift();
    if (option === '--snapshot-dir') options.snapshotDir = rest.shift() ?? '';
    else if (option === '--conversations') options.conversations = parseList(rest.shift(), '--conversations');
    else if (option === '--category') options.category = Number(rest.shift());
    else if (option === '--ks') options.ks = parseList(rest.shift(), '--ks').map(Number);
    else if (option === '--primary-k') options.primaryK = Number(rest.shift());
    else if (option === '--mmr-lambda') options.lambda = Number(rest.shift());
    else if (option === '--max-tokens') options.maxTokens = Number(rest.shift());
    else if (option === '--threads') options.threads = Number(rest.shift());
    else if (option === '--batch-size') options.batchSize = Number(rest.shift());
    else if (option === '--reranker') {
      const value = rest.shift();
      if (value !== 'mmarco' && value !== 'bge') throw new Error("--reranker must be 'mmarco' or 'bge'");
      options.reranker = value;
    }
    else if (option === '--seed') options.seed = Number(rest.shift());
    else if (option === '--out-json') options.outJson = rest.shift();
    else if (option === '--out-md') options.outMarkdown = rest.shift();
    else if (option === '--help' || option === '-h') { usage(); process.exit(0); }
    else throw new Error(`unknown argument: ${option}`);
  }
  if (!options.snapshotDir) throw new Error('--snapshot-dir is required');
  if (options.ks.some(k => !Number.isInteger(k) || k < 1)) throw new Error('--ks must be positive integers');
  if (!options.ks.includes(options.primaryK)) throw new Error('--primary-k must be one of --ks');
  if (!(options.lambda >= 0 && options.lambda <= 1)) throw new Error('--mmr-lambda must be in [0, 1]');
  return options;
}

function formatContext(texts: string[]): string {
  return texts.map((text, index) => `[${index + 1}] ${text}`).join('\n\n');
}

async function answerWithFixedContext(input: {
  apiKey: string;
  model: string;
  context: string;
  question: string;
}): Promise<{ answer: string; truncated: boolean }> {
  const result = await runToolLoop({
    apiKey: input.apiKey,
    model: input.model,
    system: `${ANSWER_PROMPT}\n\n${input.context}`,
    userMessages: [{ role: 'user', content: input.question }],
    tools: [],
    execute: async () => ({ content: '' }),
  });
  return { answer: result.answer, truncated: result.truncated };
}

function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function binomCoeff(n: number, k: number): number {
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return result;
}

// Two-sided exact-binomial McNemar p-value over the discordant pairs (b, c).
function mcnemarExactP(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let cumulative = 0;
  for (let i = 0; i <= k; i++) cumulative += binomCoeff(n, i);
  return Math.min(1, 2 * cumulative * Math.pow(0.5, n));
}

// Same YES/NO prompt as gradeLocomoAnswer (locomo.ts) — cat1 never hits the cat5
// abstention path, so we only need the binary judge.
async function judgeCorrect(
  judge: { generate(prompt: string): Promise<string> },
  qa: LocomoQa,
  candidate: string,
): Promise<{ correct: boolean; parseFailure: boolean }> {
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

function summarize(questions: QuestionAb[], k: number): KSummary {
  let attempted = 0;
  let pairs = 0;
  let baselineCorrect = 0;
  let coverageCorrect = 0;
  let coverageOnlyWins = 0;
  let baselineOnlyWins = 0;
  let baselineParseFail = 0;
  let coverageParseFail = 0;
  let baselineTruncated = 0;
  let coverageTruncated = 0;
  let baselineCharsSum = 0;
  let coverageCharsSum = 0;
  let charDeltaOnCoverageWinsSum = 0;

  for (const question of questions) {
    const cell = question.perK[k];
    if (!cell) continue;
    const base = cell.baseline;
    const cov = cell.coverage;
    attempted++;
    baselineCharsSum += base.answerChars;
    coverageCharsSum += cov.answerChars;
    if (base.truncated) baselineTruncated++;
    if (cov.truncated) coverageTruncated++;
    if (base.parseFailure) baselineParseFail++;
    if (cov.parseFailure) coverageParseFail++;
    if (base.parseFailure || cov.parseFailure) continue; // invalid pair
    pairs++;
    if (base.correct) baselineCorrect++;
    if (cov.correct) coverageCorrect++;
    if (cov.correct && !base.correct) {
      coverageOnlyWins++;
      charDeltaOnCoverageWinsSum += cov.answerChars - base.answerChars;
    }
    if (base.correct && !cov.correct) baselineOnlyWins++;
  }

  const baselineAccuracy = pairs > 0 ? baselineCorrect / pairs : 0;
  const coverageAccuracy = pairs > 0 ? coverageCorrect / pairs : 0;
  const absoluteDeltaPp = coverageAccuracy - baselineAccuracy;
  const mcnemarP = mcnemarExactP(coverageOnlyWins, baselineOnlyWins);
  const denom = Math.max(attempted, 1);
  const parseFailArmBiased = Math.abs(baselineParseFail - coverageParseFail) / denom > 0.05;
  const truncationArmBiased = baselineTruncated !== coverageTruncated;
  const baselineMeanChars = attempted > 0 ? baselineCharsSum / attempted : 0;
  const coverageMeanChars = attempted > 0 ? coverageCharsSum / attempted : 0;
  const meanCharDeltaOnCoverageWins = coverageOnlyWins > 0 ? charDeltaOnCoverageWinsSum / coverageOnlyWins : 0;
  const lengthSuspect = coverageOnlyWins >= 3 && meanCharDeltaOnCoverageWins > 200;

  const invalid = parseFailArmBiased || truncationArmBiased || lengthSuspect;
  const verdict: KSummary['verdict'] = invalid
    ? 'invalid'
    : (absoluteDeltaPp >= GATE_PP && mcnemarP < MCNEMAR_ALPHA ? 'go' : 'no-go');

  return {
    k,
    pairs,
    baselineCorrect,
    coverageCorrect,
    baselineAccuracy,
    coverageAccuracy,
    absoluteDeltaPp,
    coverageOnlyWins,
    baselineOnlyWins,
    mcnemarP,
    baselineParseFail,
    coverageParseFail,
    parseFailArmBiased,
    baselineTruncated,
    coverageTruncated,
    baselineMeanChars,
    coverageMeanChars,
    meanCharDeltaOnCoverageWins,
    lengthSuspect,
    verdict,
  };
}

export async function runCoverageAb(options: CoverageAbOptions): Promise<CoverageAbResult> {
  const apiKey = deepseekApiKey();
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required for the answerer');
  if (!geminiApiKey()) throw new Error('GEMINI_API_KEY is required for the judge');
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
  if (!process.env.DEEPSEEK_MAX_TOKENS) process.env.DEEPSEEK_MAX_TOKENS = String(options.maxTokens);

  const reranker = await CrossEncoderReranker.load({
    threads: options.threads,
    batchSize: options.batchSize,
    ...(options.reranker === 'mmarco' ? { spec: MMARCO_MMINILM_RERANKER_MODEL, allowFallback: false } : {}),
  });
  await reranker.warm();
  const embedder = createRealEmbedder();
  const judge = createGeminiJudge();
  const all = loadLocomo();
  const sampleIds = options.conversations.length > 0
    ? options.conversations
    : all.filter(c => c.qa.some(qa => qa.category === options.category)).map(c => c.sampleId);
  const rng = seededRng(options.seed);
  const questions: QuestionAb[] = [];
  const warnings: string[] = [];

  for (const sampleId of sampleIds) {
    const conversation = all.find(item => item.sampleId === sampleId);
    if (!conversation) { warnings.push(`conversation not found: ${sampleId}`); continue; }
    const snapshotPath = findSnapshotPath(options.snapshotDir, conversation);
    if (!snapshotPath) { warnings.push(`${sampleId}: no restored snapshot in ${options.snapshotDir}`); continue; }

    const real = await createRealMemoryRiver(undefined, snapshotPath);
    try {
      const targets = conversation.qa
        .map((qa, questionIndex) => ({ qa, questionIndex }))
        .filter(({ qa }) => qa.category === options.category);

      for (const { qa, questionIndex } of targets) {
        const pool = (await real.river.searchMemory(qa.question, POOL_K)).slice(0, POOL_K);
        if (pool.length === 0) { warnings.push(`${sampleId} q${questionIndex}: empty pool`); continue; }
        const { logits } = await reranker.scorePairs(
          pool.map(result => ({ query: qa.question, passage: result.entry.text })),
        );
        const vectors = await embedder.embedTextBatch(pool.map(result => result.entry.text));
        const relevance = pool.map((_, index) => logits[index] ?? Number.NEGATIVE_INFINITY);
        const coveragePool = mmrOrder(relevance, vectors, options.lambda).map(index => pool[index]);

        const armOrder: Arm[] = rng() < 0.5 ? ['baseline', 'coverage'] : ['coverage', 'baseline'];
        const perK: QuestionAb['perK'] = {};
        for (const k of options.ks) {
          const armPools: Record<Arm, typeof pool> = {
            baseline: pool.slice(0, k),
            coverage: coveragePool.slice(0, k),
          };
          const cells = {} as Record<Arm, ArmCell>;
          for (const arm of armOrder) {
            const context = formatContext(armPools[arm].map(result => result.entry.text));
            const { answer, truncated } = await answerWithFixedContext({ apiKey, model, context, question: qa.question });
            const grade = await judgeCorrect(judge, qa, answer);
            cells[arm] = {
              answer,
              answerChars: answer.length,
              truncated,
              correct: grade.correct,
              parseFailure: grade.parseFailure,
            };
          }
          perK[k] = cells;
        }
        questions.push({ sampleId, questionIndex, question: qa.question, poolSize: pool.length, armOrder, perK });
      }
    } finally {
      await real.cleanup();
    }
  }

  const summary = options.ks.map(k => summarize(questions, k));
  const primary = summary.find(s => s.k === options.primaryK)!;
  return {
    label: `LocomoCoverageAb(${sampleIds.length}conv_cat${options.category}_${options.reranker})`,
    description: 'Fixed-context A/B: baseline (fusedScore) vs coverage-greedy (MMR) selection of the recall@50 pool, tools off, raised token cap, randomized arm order, paired scoring.',
    antiCheat: 'Reranker/MMR see only (query, memoryText); reference answers used only by the judge after answering.',
    conversations: sampleIds,
    category: options.category,
    toolsEnabled: false,
    maxTokens: options.maxTokens,
    mmrLambda: options.lambda,
    rerankerModel: `${reranker.info.modelId}@${reranker.info.revision}`,
    gatePp: GATE_PP,
    primaryK: options.primaryK,
    primaryVerdict: primary.verdict,
    questions,
    summary,
    warnings,
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function renderCoverageAb(result: CoverageAbResult): string {
  const lines = [
    `# ${result.label}`,
    '',
    result.description,
    result.antiCheat,
    `Tools: OFF | maxTokens: ${result.maxTokens} | MMR lambda: ${result.mmrLambda} | reranker: ${result.rerankerModel}`,
    `Conversations: ${result.conversations.length} | category ${result.category} | questions: ${result.questions.length}`,
    `PRIMARY k=${result.primaryK} -> ${result.primaryVerdict.toUpperCase()}`,
    '',
    '| k | pairs | baseline acc | coverage acc | abs delta | cov-only | base-only | McNemar p | verdict |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---|',
    ...result.summary.map(s =>
      `| ${s.k}${s.k === result.primaryK ? '*' : ''} | ${s.pairs} | ` +
      `${pct(s.baselineAccuracy)} (${s.baselineCorrect}/${s.pairs}) | ` +
      `${pct(s.coverageAccuracy)} (${s.coverageCorrect}/${s.pairs}) | ` +
      `${(s.absoluteDeltaPp * 100).toFixed(1)}pp | ${s.coverageOnlyWins} | ${s.baselineOnlyWins} | ` +
      `${s.mcnemarP.toFixed(3)} | ${s.verdict.toUpperCase()} |`,
    ),
    '',
    '| k | base/cov parseFail | biased | base/cov trunc | base/cov meanChars | Δchars on cov-wins | length suspect |',
    '|---:|---:|:---:|---:|---:|---:|:---:|',
    ...result.summary.map(s =>
      `| ${s.k} | ${s.baselineParseFail}/${s.coverageParseFail} | ${s.parseFailArmBiased ? 'YES' : 'no'} | ` +
      `${s.baselineTruncated}/${s.coverageTruncated} | ${s.baselineMeanChars.toFixed(0)}/${s.coverageMeanChars.toFixed(0)} | ` +
      `${s.meanCharDeltaOnCoverageWins.toFixed(0)} | ${s.lengthSuspect ? 'YES' : 'no'} |`,
    ),
    '',
    `Gate (primary k=${result.primaryK}, all must hold): absolute delta >= +${(result.gatePp * 100).toFixed(0)}pp ` +
    `AND McNemar p < ${MCNEMAR_ALPHA} AND parse-fail not arm-biased AND truncation not arm-biased AND not length-suspect. ` +
    `Else cat1 CLOSED.  (* = primary k)`,
  ];
  if (result.warnings.length > 0) lines.push('', 'Warnings:', ...result.warnings.map(w => `- ${w}`));
  return lines.join('\n');
}

export async function runCli(input: string[]): Promise<number> {
  try {
    const options = parseArgs(input);
    const result = await runCoverageAb(options);
    const markdown = renderCoverageAb(result);
    if (options.outMarkdown) fs.writeFileSync(options.outMarkdown, `${markdown}\n`, 'utf8');
    if (options.outJson) fs.writeFileSync(options.outJson, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(markdown);
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`locomo-coverage-ab fatal:\n${detail}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runCli(process.argv.slice(2));
}
