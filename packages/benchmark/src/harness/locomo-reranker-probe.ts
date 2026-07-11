#!/usr/bin/env node

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import type { MemorySearchResult } from '@memory-river/core';

import { CrossEncoderReranker, PRIMARY_RERANKER_MODEL } from './cross-encoder-reranker.js';
import { loadLocomo, type LocomoConversation } from './locomo.js';
import {
  buildEvidenceEntryMap,
  evidenceDiaIds,
  findSnapshotPath,
  type MemoryRow,
  readLanceRows,
  sourceEntryIds,
} from './locomo-provenance.js';
import { createRealEmbedder } from './real-embedder.js';
import { createRealMemoryRiver } from './real-river.js';

export const CRAG_RERANKER_POOL_K = 50;
export const COVERAGE_MMR_LAMBDA = 0.5;

const REPORT_K = [1, 2, 5] as const;
const DEFAULT_CATEGORIES = [2, 4] as const;
const MINILM_MODEL_ID = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const HF_HOSTS = new Set([
  'huggingface.co',
  'www.huggingface.co',
  'hf.co',
  'cdn-lfs.huggingface.co',
]);

type ArmId = 'qwen-bi' | 'minilm-bi' | 'bge-cross';

interface RerankerProbeOptions {
  snapshotDir?: string;
  conversation: string;
  categories: number[];
  outJson?: string;
  outMarkdown?: string;
  threads: number;
  batchSize: number;
  maxLength: number;
  passageTokenLimit: number;
  modelDir?: string;
  cacheDir?: string;
  smokeSamples: number;
}

interface ScoredCandidate {
  baselineRank: number;
  rerankRank: number;
  memoryId: string;
  text: string;
  sourceEntryIds: number[];
  gold: boolean;
  score: number;
  baselineFusedScore: number;
}

interface QuestionArmResult {
  sampleId: string;
  questionIndex: number;
  category: number;
  question: string;
  goldEntryIds: number[];
  poolSize: number;
  latencyMs: number;
  topHits: Record<`top${typeof REPORT_K[number]}`, boolean>;
  scoredGold: number;
  scoredNoise: number;
  scoreSeparation: number | null;
  candidates: ScoredCandidate[];
}

interface ArmCategoryMetrics {
  arm: ArmId;
  label: string;
  category: number | 'all';
  questions: number;
  top1HitRate: number;
  top2HitRate: number;
  top5HitRate: number;
  scoreSeparation: number | null;
  scoredGold: number;
  scoredNoise: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
}

interface ArmResult {
  arm: ArmId;
  label: string;
  model: string;
  loadMs: number;
  perQuestion: QuestionArmResult[];
  metrics: ArmCategoryMetrics[];
}

interface SmokeMatch {
  memoryId: string;
  sourceEntryIds: number[];
  text: string;
}

interface SmokeQuestion {
  sampleId: string;
  questionIndex: number;
  category: number;
  question: string;
  evidence: string[];
  goldEntryIds: number[];
  matches: SmokeMatch[];
}

interface RerankerProbeResult {
  metricLabel: string;
  description: string;
  antiCheat: string;
  scope: {
    conversation: string;
    categories: number[];
    poolK: number;
  };
  offline: {
    hfRemoteDisabled: true;
    cacheDir: string;
    miniLmDir: string;
    bgeDir: string;
  };
  smoke: SmokeQuestion[];
  arms: ArmResult[];
  table: ArmCategoryMetrics[];
  warnings: string[];
  ambiguities: string[];
}

interface Scorer {
  id: ArmId;
  label: string;
  model: string;
  loadMs: number;
  score(query: string, pool: MemorySearchResult[]): Promise<{ scores: number[]; latencyMs: number }>;
}

let activeHfArm: string | null = null;
let fetchGuardInstalled = false;

function usage(): void {
  console.error(
    'Usage: node dist/harness/locomo-reranker-probe.js --snapshot-dir DIR ' +
    '[--conversation conv-26] [--category 2,4] [--out-json FILE] [--out-md FILE] ' +
    '[--threads 4] [--batch-size 8] [--max-length 512] [--passage-tokens 320] ' +
    '[--model-dir DIR] [--cache-dir DIR] [--smoke-samples 3]',
  );
}

function parsePositiveInteger(option: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${option} requires a positive integer`);
  }
  return parsed;
}

function parseCategoryList(value: string | undefined): number[] {
  if (!value || value.startsWith('--')) throw new Error('--category requires a comma-separated list');
  const categories = value.split(',')
    .map(item => Number(item.trim()))
    .filter(Number.isFinite);
  if (categories.length === 0 || categories.some(item => !Number.isInteger(item) || item < 1)) {
    throw new Error('--category requires positive integer categories, e.g. 2,4');
  }
  return [...new Set(categories)];
}

function parseArgs(args: string[]): RerankerProbeOptions {
  const options: RerankerProbeOptions = {
    conversation: 'conv-26',
    categories: [...DEFAULT_CATEGORIES],
    threads: 4,
    batchSize: 8,
    maxLength: 512,
    passageTokenLimit: 320,
    smokeSamples: 3,
  };
  const rest = [...args];
  while (rest.length > 0) {
    const option = rest.shift();
    if (option === '--snapshot-dir') {
      options.snapshotDir = rest.shift();
      if (!options.snapshotDir || options.snapshotDir.startsWith('--')) {
        throw new Error('--snapshot-dir requires a directory path');
      }
    } else if (option === '--conversation') {
      options.conversation = rest.shift() ?? '';
      if (!options.conversation || options.conversation.startsWith('--')) {
        throw new Error('--conversation requires a LoCoMo sample id such as conv-26');
      }
    } else if (option === '--category') {
      options.categories = parseCategoryList(rest.shift());
    } else if (option === '--out-json') {
      options.outJson = rest.shift();
      if (!options.outJson || options.outJson.startsWith('--')) {
        throw new Error('--out-json requires a file path');
      }
    } else if (option === '--out-md') {
      options.outMarkdown = rest.shift();
      if (!options.outMarkdown || options.outMarkdown.startsWith('--')) {
        throw new Error('--out-md requires a file path');
      }
    } else if (option === '--threads') {
      options.threads = parsePositiveInteger(option, rest.shift());
    } else if (option === '--batch-size') {
      options.batchSize = parsePositiveInteger(option, rest.shift());
    } else if (option === '--max-length') {
      options.maxLength = parsePositiveInteger(option, rest.shift());
    } else if (option === '--passage-tokens') {
      options.passageTokenLimit = parsePositiveInteger(option, rest.shift());
    } else if (option === '--model-dir') {
      options.modelDir = rest.shift();
      if (!options.modelDir || options.modelDir.startsWith('--')) {
        throw new Error('--model-dir requires a directory path');
      }
    } else if (option === '--cache-dir') {
      options.cacheDir = rest.shift();
      if (!options.cacheDir || options.cacheDir.startsWith('--')) {
        throw new Error('--cache-dir requires a directory path');
      }
    } else if (option === '--smoke-samples') {
      options.smokeSamples = parsePositiveInteger(option, rest.shift());
    } else if (option === '--help' || option === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${option}`);
    }
  }
  if (!options.snapshotDir) throw new Error('--snapshot-dir is required');
  return options;
}

function defaultCacheDir(): string {
  return process.env.TRANSFORMERS_CACHE
    ?? process.env.HF_HOME
    ?? path.join(os.homedir(), '.cache', 'huggingface');
}

function modelDir(cacheDir: string, modelId: string): string {
  return path.join(cacheDir, ...modelId.split('/'));
}

function requireCachedModel(arm: string, dir: string, requiredFiles: string[]): void {
  const missing = requiredFiles
    .map(file => path.join(dir, file))
    .filter(file => !fs.existsSync(file));
  if (missing.length > 0) {
    throw new Error(
      `${arm}: required offline model cache is incomplete at ${dir}; missing ${missing.join(', ')}`,
    );
  }
}

function installHuggingFaceNetworkGuard(): void {
  if (fetchGuardInstalled || typeof globalThis.fetch !== 'function') return;
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const [input] = args;
    const raw = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    let url: URL | null = null;
    try {
      url = new URL(raw);
    } catch {
      url = null;
    }
    if (url && HF_HOSTS.has(url.hostname)) {
      throw new Error(
        `${activeHfArm ?? 'unknown arm'} attempted HuggingFace network access: ${url.href}`,
      );
    }
    return originalFetch(...args);
  }) as typeof globalThis.fetch;
  fetchGuardInstalled = true;
}

function configureOfflineTransformers(cacheDir: string): void {
  process.env.TRANSFORMERS_CACHE = cacheDir;
  process.env.HF_HOME = cacheDir;
  process.env.HF_HUB_OFFLINE = '1';
  process.env.TRANSFORMERS_OFFLINE = '1';
  installHuggingFaceNetworkGuard();
}

function uniqueNumbers(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(q * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function cosineNumber(a: ArrayLike<number>, b: ArrayLike<number> | undefined): number {
  if (!b || a.length === 0 || b.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const av = Number(a[i]);
    const bv = Number(b[i]);
    if (!Number.isFinite(av) || !Number.isFinite(bv)) continue;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function ms(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(1)}ms`;
}

function fixed(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(4);
}

function excerpt(text: string, limit = 180): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}...` : compact;
}

function parseMetadata(metadata: unknown): Record<string, unknown> {
  if (typeof metadata !== 'string' || metadata.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function isActiveMemory(row: MemoryRow): boolean {
  const topStatus = row.status || 'active';
  const metaStatus = parseMetadata(row.metadata).status;
  return topStatus === 'active' && (metaStatus == null || metaStatus === 'active');
}

function goldEntryIdsForQuestion(
  conversation: LocomoConversation,
  snapshotPath: string,
  evidence: string[],
): number[] {
  const evidenceEntryMap = buildEvidenceEntryMap(conversation, snapshotPath);
  return uniqueNumbers(evidence.flatMap(item =>
    evidenceDiaIds(item)
      .map(diaId => evidenceEntryMap.get(diaId)?.entryId)
      .filter((entryId): entryId is number => entryId !== undefined)
  ));
}

function isGoldMemory(result: MemorySearchResult, goldSet: Set<number>): boolean {
  return sourceEntryIds(result.entry.metadata).some(entryId => goldSet.has(entryId));
}

function sortByScore(pool: MemorySearchResult[], scores: number[]): Array<{ result: MemorySearchResult; index: number; score: number }> {
  return pool
    .map((result, index) => ({ result, index, score: scores[index] ?? Number.NEGATIVE_INFINITY }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
}

// Coverage-greedy (MMR) ordering retained for locomo-coverage-ab imports.
export function mmrOrder(relevance: number[], vectors: Float32Array[], lambda: number): number[] {
  const lo = Math.min(...relevance);
  const hi = Math.max(...relevance);
  const rel = relevance.map(value => (hi > lo ? (value - lo) / (hi - lo) : 0));
  const selected: number[] = [];
  const remaining = new Set(relevance.map((_, index) => index));
  while (remaining.size > 0) {
    let best = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const index of remaining) {
      let maxSim = 0;
      for (const chosen of selected) {
        const sim = cosineNumber(vectors[index], vectors[chosen]);
        if (sim > maxSim) maxSim = sim;
      }
      const score = lambda * rel[index] - (1 - lambda) * maxSim;
      if (score > bestScore || (score === bestScore && index < best)) {
        bestScore = score;
        best = index;
      }
    }
    selected.push(best);
    remaining.delete(best);
  }
  return selected;
}

class QwenBiScorer implements Scorer {
  readonly id = 'qwen-bi' as const;
  readonly label = 'Qwen-bi';
  readonly model = 'hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF via local Ollama';
  readonly loadMs = 0;
  private readonly embedder = createRealEmbedder();

  async score(query: string, pool: MemorySearchResult[]): Promise<{ scores: number[]; latencyMs: number }> {
    const started = performance.now();
    const queryVector = await this.embedder.embed(query, 'query');
    const scores = pool.map(result => cosineNumber(queryVector, result.entry.vector as number[] | undefined));
    return { scores, latencyMs: performance.now() - started };
  }
}

class MiniLmBiScorer implements Scorer {
  readonly id = 'minilm-bi' as const;
  readonly label = 'paraphrase-MiniLM-bi';
  readonly model = MINILM_MODEL_ID;
  readonly loadMs: number;
  private constructor(private readonly extractor: any, loadMs: number) {
    this.loadMs = loadMs;
  }

  static async load(cacheDir: string): Promise<MiniLmBiScorer> {
    const miniLmDir = modelDir(cacheDir, MINILM_MODEL_ID);
    requireCachedModel('paraphrase-MiniLM-bi', miniLmDir, [
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/model_quantized.onnx',
    ]);
    configureOfflineTransformers(cacheDir);
    activeHfArm = 'paraphrase-MiniLM-bi';
    const started = performance.now();
    try {
      const { pipeline, env } = await import('@xenova/transformers');
      env.cacheDir = cacheDir;
      (env as any).allowRemoteModels = false;
      const extractor = await pipeline('feature-extraction', MINILM_MODEL_ID, {
        quantized: true,
        local_files_only: true,
      } as any);
      return new MiniLmBiScorer(extractor, performance.now() - started);
    } catch (error) {
      throw new Error(`paraphrase-MiniLM-bi failed offline load: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      activeHfArm = null;
    }
  }

  async score(query: string, pool: MemorySearchResult[]): Promise<{ scores: number[]; latencyMs: number }> {
    const started = performance.now();
    activeHfArm = 'paraphrase-MiniLM-bi';
    try {
      const queryEmbedding = await this.extractor(query, { pooling: 'mean', normalize: true });
      const scores: number[] = [];
      for (const result of pool) {
        const memoryEmbedding = await this.extractor(result.entry.text, { pooling: 'mean', normalize: true });
        scores.push(cosineNumber(queryEmbedding.data, memoryEmbedding.data));
      }
      return { scores, latencyMs: performance.now() - started };
    } finally {
      activeHfArm = null;
    }
  }
}

class BgeCrossScorer implements Scorer {
  readonly id = 'bge-cross' as const;
  readonly label = 'bge-reranker-v2-m3 cross';
  readonly model: string;
  readonly loadMs: number;
  private constructor(private readonly reranker: CrossEncoderReranker) {
    this.model = `${reranker.info.modelId}@${reranker.info.revision}`;
    this.loadMs = reranker.info.loadMs;
  }

  static async load(options: RerankerProbeOptions, cacheDir: string): Promise<BgeCrossScorer> {
    const bgeDir = modelDir(cacheDir, PRIMARY_RERANKER_MODEL.modelId);
    requireCachedModel('bge-reranker-v2-m3 cross', bgeDir, [
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/model_quantized.onnx',
    ]);
    configureOfflineTransformers(cacheDir);
    activeHfArm = 'bge-reranker-v2-m3 cross';
    try {
      const reranker = await CrossEncoderReranker.load({
        threads: options.threads,
        batchSize: options.batchSize,
        maxLength: options.maxLength,
        passageTokenLimit: options.passageTokenLimit,
        modelDir: options.modelDir,
        cacheDir,
        allowFallback: false,
      });
      await reranker.warm();
      return new BgeCrossScorer(reranker);
    } catch (error) {
      throw new Error(`bge-reranker-v2-m3 cross failed offline load: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      activeHfArm = null;
    }
  }

  async score(query: string, pool: MemorySearchResult[]): Promise<{ scores: number[]; latencyMs: number }> {
    activeHfArm = 'bge-reranker-v2-m3 cross';
    try {
      const { logits, timing } = await this.reranker.scorePairs(pool.map(result => ({
        query,
        passage: result.entry.text,
      })));
      return { scores: logits, latencyMs: timing.timedMs };
    } finally {
      activeHfArm = null;
    }
  }
}

async function loadActiveMemories(snapshotPath: string): Promise<Array<MemoryRow & { sourceEntryIds: number[] }>> {
  const rows = await readLanceRows<MemoryRow>(
    snapshotPath,
    'memories',
    ['id', 'text', 'metadata', 'category', 'status'],
  );
  return rows
    .filter(row => row.id !== 'init_00000000000000000000000000000000' && isActiveMemory(row))
    .map(row => ({ ...row, sourceEntryIds: sourceEntryIds(row.metadata) }));
}

async function smokeGoldMatching(input: {
  conversation: LocomoConversation;
  snapshotPath: string;
  categories: number[];
  samples: number;
}): Promise<SmokeQuestion[]> {
  const memories = await loadActiveMemories(input.snapshotPath);
  const targets = input.conversation.qa
    .map((qa, questionIndex) => ({ qa, questionIndex }))
    .filter(({ qa }) => input.categories.includes(qa.category));
  if (targets.length === 0) {
    throw new Error(`smoke gate: no questions found for categories ${input.categories.join(',')}`);
  }

  const smoke: SmokeQuestion[] = [];
  for (const { qa, questionIndex } of targets) {
    const goldEntryIds = goldEntryIdsForQuestion(input.conversation, input.snapshotPath, qa.evidence);
    const goldSet = new Set(goldEntryIds);
    const matches = memories
      .filter(memory => memory.sourceEntryIds.some(entryId => goldSet.has(entryId)))
      .slice(0, 5)
      .map(memory => ({
        memoryId: memory.id,
        sourceEntryIds: memory.sourceEntryIds,
        text: memory.text,
      }));
    smoke.push({
      sampleId: input.conversation.sampleId,
      questionIndex,
      category: qa.category,
      question: qa.question,
      evidence: qa.evidence,
      goldEntryIds,
      matches,
    });
    if (goldEntryIds.length === 0 || matches.length === 0) {
      console.error(
        `locomo-reranker-probe smoke skipped ${input.conversation.sampleId} q${questionIndex}: ` +
        'zero mapped gold entries or zero matched memories',
      );
      smoke.pop();
      continue;
    }
    if (smoke.length >= input.samples) break;
  }

  console.error('locomo-reranker-probe smoke gold matching:');
  for (const item of smoke) {
    console.error(`- ${item.sampleId} q${item.questionIndex} cat${item.category}: ${item.question}`);
    console.error(`  evidence=${JSON.stringify(item.evidence)} goldEntryIds=${JSON.stringify(item.goldEntryIds)}`);
    for (const match of item.matches) {
      console.error(`  match ${match.memoryId} sourceEntryIds=${JSON.stringify(match.sourceEntryIds)} text="${excerpt(match.text)}"`);
    }
  }

  const requiredSamples = Math.min(input.samples, Math.max(2, targets.length));
  if (smoke.length < requiredSamples) {
    throw new Error(
      `smoke gate failed: needed ${requiredSamples} non-empty gold-memory matching samples, got ${smoke.length}`,
    );
  }
  return smoke;
}

function buildQuestionResult(input: {
  scorer: Scorer;
  sampleId: string;
  questionIndex: number;
  category: number;
  question: string;
  goldEntryIds: number[];
  pool: MemorySearchResult[];
  scores: number[];
  latencyMs: number;
}): QuestionArmResult {
  const goldSet = new Set(input.goldEntryIds);
  const ranked = sortByScore(input.pool, input.scores);
  const rankById = new Map(ranked.map((item, index) => [item.result.entry.id, index + 1]));
  const topHits = Object.fromEntries(REPORT_K.map(k => [
    `top${k}`,
    ranked.slice(0, k).some(item => isGoldMemory(item.result, goldSet)),
  ])) as Record<`top${typeof REPORT_K[number]}`, boolean>;

  const goldScores: number[] = [];
  const noiseScores: number[] = [];
  const candidates = input.pool.map((result, index) => {
    const gold = isGoldMemory(result, goldSet);
    const score = input.scores[index] ?? Number.NEGATIVE_INFINITY;
    if (Number.isFinite(score)) {
      if (gold) goldScores.push(score);
      else noiseScores.push(score);
    }
    return {
      baselineRank: index + 1,
      rerankRank: rankById.get(result.entry.id) ?? -1,
      memoryId: result.entry.id,
      text: result.entry.text,
      sourceEntryIds: sourceEntryIds(result.entry.metadata),
      gold,
      score,
      baselineFusedScore: result.fusedScore,
    };
  });

  return {
    sampleId: input.sampleId,
    questionIndex: input.questionIndex,
    category: input.category,
    question: input.question,
    goldEntryIds: input.goldEntryIds,
    poolSize: input.pool.length,
    latencyMs: input.latencyMs,
    topHits,
    scoredGold: goldScores.length,
    scoredNoise: noiseScores.length,
    scoreSeparation: goldScores.length > 0 && noiseScores.length > 0
      ? mean(goldScores) - mean(noiseScores)
      : null,
    candidates,
  };
}

function aggregateArm(
  arm: ArmId,
  label: string,
  questions: QuestionArmResult[],
  category: number | 'all',
): ArmCategoryMetrics {
  const scoped = category === 'all'
    ? questions
    : questions.filter(question => question.category === category);
  const latencies = scoped.map(question => question.latencyMs).filter(Number.isFinite);
  const goldScores: number[] = [];
  const noiseScores: number[] = [];
  for (const question of scoped) {
    for (const candidate of question.candidates) {
      if (!Number.isFinite(candidate.score)) continue;
      if (candidate.gold) goldScores.push(candidate.score);
      else noiseScores.push(candidate.score);
    }
  }
  return {
    arm,
    label,
    category,
    questions: scoped.length,
    top1HitRate: scoped.length > 0 ? mean(scoped.map(question => question.topHits.top1 ? 1 : 0)) : 0,
    top2HitRate: scoped.length > 0 ? mean(scoped.map(question => question.topHits.top2 ? 1 : 0)) : 0,
    top5HitRate: scoped.length > 0 ? mean(scoped.map(question => question.topHits.top5 ? 1 : 0)) : 0,
    scoreSeparation: goldScores.length > 0 && noiseScores.length > 0
      ? mean(goldScores) - mean(noiseScores)
      : null,
    scoredGold: goldScores.length,
    scoredNoise: noiseScores.length,
    p50LatencyMs: quantile(latencies, 0.50),
    p95LatencyMs: quantile(latencies, 0.95),
  };
}

async function loadScorers(options: RerankerProbeOptions, cacheDir: string): Promise<Scorer[]> {
  return [
    new QwenBiScorer(),
    await MiniLmBiScorer.load(cacheDir),
    await BgeCrossScorer.load(options, cacheDir),
  ];
}

export async function runLocomoRerankerProbe(
  options: RerankerProbeOptions,
): Promise<RerankerProbeResult> {
  if (!options.snapshotDir) throw new Error('--snapshot-dir is required');
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const miniLmDir = modelDir(cacheDir, MINILM_MODEL_ID);
  const bgeDir = modelDir(cacheDir, PRIMARY_RERANKER_MODEL.modelId);

  const conversation = loadLocomo().find(item => item.sampleId === options.conversation);
  if (!conversation) throw new Error(`conversation not found: ${options.conversation}`);
  const snapshotPath = findSnapshotPath(options.snapshotDir, conversation);
  if (!snapshotPath) {
    throw new Error(`${conversation.sampleId}: no restored snapshot found in ${options.snapshotDir}`);
  }

  const smoke = await smokeGoldMatching({
    conversation,
    snapshotPath,
    categories: options.categories,
    samples: options.smokeSamples,
  });

  const scorers = await loadScorers(options, cacheDir);
  const real = await createRealMemoryRiver(undefined, snapshotPath);
  const byArm = new Map<ArmId, QuestionArmResult[]>(
    scorers.map(scorer => [scorer.id, []]),
  );
  const warnings: string[] = [];

  try {
    const targets = conversation.qa
      .map((qa, questionIndex) => ({ qa, questionIndex }))
      .filter(({ qa }) => options.categories.includes(qa.category));
    if (targets.length === 0) {
      warnings.push(`${conversation.sampleId}: no questions found for categories ${options.categories.join(',')}`);
    }

    for (const { qa, questionIndex } of targets) {
      const goldEntryIds = goldEntryIdsForQuestion(conversation, snapshotPath, qa.evidence);
      if (goldEntryIds.length === 0) {
        warnings.push(`${conversation.sampleId} q${questionIndex}: no mapped gold entryIds`);
      }
      const pool = (await real.river.searchMemory(qa.question, CRAG_RERANKER_POOL_K))
        .slice(0, CRAG_RERANKER_POOL_K);

      for (const scorer of scorers) {
        try {
          const { scores, latencyMs } = await scorer.score(qa.question, pool);
          byArm.get(scorer.id)!.push(buildQuestionResult({
            scorer,
            sampleId: conversation.sampleId,
            questionIndex,
            category: qa.category,
            question: qa.question,
            goldEntryIds,
            pool,
            scores,
            latencyMs,
          }));
        } catch (error) {
          throw new Error(`${scorer.label} failed while scoring ${conversation.sampleId} q${questionIndex}: ${
            error instanceof Error ? error.message : String(error)
          }`);
        }
      }
    }
  } finally {
    await real.cleanup();
  }

  const categoriesForReport: Array<number | 'all'> = [...options.categories, 'all'];
  const arms = scorers.map(scorer => {
    const perQuestion = byArm.get(scorer.id) ?? [];
    return {
      arm: scorer.id,
      label: scorer.label,
      model: scorer.model,
      loadMs: scorer.loadMs,
      perQuestion,
      metrics: categoriesForReport.map(category =>
        aggregateArm(scorer.id, scorer.label, perQuestion, category)),
    };
  });

  return {
    metricLabel: `ThreeArmRelevanceScorerGate(${conversation.sampleId}_cat${options.categories.join('-')})`,
    description:
      'Retrieval-only LoCoMo relevance-scorer comparison over the same real.river.searchMemory(question, 50) pool.',
    antiCheat:
      'Scorers see only (query, memory text/vector). Gold evidence and category are used only after scoring for metrics.',
    scope: {
      conversation: conversation.sampleId,
      categories: options.categories,
      poolK: CRAG_RERANKER_POOL_K,
    },
    offline: {
      hfRemoteDisabled: true,
      cacheDir,
      miniLmDir,
      bgeDir,
    },
    smoke,
    arms,
    table: arms.flatMap(arm => arm.metrics),
    warnings,
    ambiguities: [
      'Qwen-bi uses the current production CRAG semantics: one query-mode Qwen embedding scored against each candidate stored vector from the recall pool.',
      'The inherited probe is conversation-scoped, so the default run remains conv-26 unless --conversation is supplied.',
      'Score separation is aggregated over all scored pool candidates in scope: mean(gold scores) minus mean(non-gold scores).',
    ],
  };
}

export function renderLocomoRerankerProbe(result: RerankerProbeResult): string {
  const rows = result.table.map(metric => {
    const arm = metric.category === 'all'
      ? `${metric.label} (cat${result.scope.categories.join('+')})`
      : `${metric.label} (cat${metric.category})`;
    return `| ${arm} | ${pct(metric.top2HitRate)} | ${fixed(metric.scoreSeparation)} | ${ms(metric.p50LatencyMs)} | ${ms(metric.p95LatencyMs)} |`;
  });

  const lines = [
    '# Three-Arm Relevance Scorer Gate Experiment',
    '',
    `${result.metricLabel} (${result.scope.conversation}; pool@${result.scope.poolK})`,
    result.description,
    result.antiCheat,
    '',
    `Offline HF cache: ${result.offline.cacheDir}`,
    `MiniLM cache: ${result.offline.miniLmDir}`,
    `BGE cache: ${result.offline.bgeDir}`,
    '',
    '| Arm | top-2 hit rate | score separation | P50 latency | P95 latency |',
    '|---|---:|---:|---:|---:|',
    ...rows,
    '',
    'Auxiliary top-k hit rates:',
    '',
    '| Arm | questions | top-1 | top-5 | scored gold | scored non-gold |',
    '|---|---:|---:|---:|---:|---:|',
    ...result.table.map(metric => {
      const arm = metric.category === 'all'
        ? `${metric.label} (cat${result.scope.categories.join('+')})`
        : `${metric.label} (cat${metric.category})`;
      return `| ${arm} | ${metric.questions} | ${pct(metric.top1HitRate)} | ${pct(metric.top5HitRate)} | ${metric.scoredGold} | ${metric.scoredNoise} |`;
    }),
    '',
    'Smoke gate matched gold memories:',
    ...result.smoke.map(item =>
      `- ${item.sampleId} q${item.questionIndex} cat${item.category}: ` +
      `${item.matches.length} matches for goldEntryIds ${JSON.stringify(item.goldEntryIds)}`),
    '',
    'Ambiguities resolved:',
    ...result.ambiguities.map(item => `- ${item}`),
  ];

  if (result.warnings.length > 0) {
    lines.push('', 'Warnings:', ...result.warnings.map(warning => `- ${warning}`));
  }
  return lines.join('\n');
}

export async function runCli(input: string[]): Promise<number> {
  try {
    const options = parseArgs(input);
    const result = await runLocomoRerankerProbe(options);
    const markdown = renderLocomoRerankerProbe(result);
    const json = JSON.stringify(result, null, 2);
    if (options.outMarkdown) fs.writeFileSync(options.outMarkdown, `${markdown}\n`, 'utf8');
    if (options.outJson) fs.writeFileSync(options.outJson, `${json}\n`, 'utf8');
    console.log(markdown);
    if (!options.outJson) console.log(`\n${json}`);
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`locomo-reranker-probe fatal:\n${detail}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runCli(process.argv.slice(2));
}
