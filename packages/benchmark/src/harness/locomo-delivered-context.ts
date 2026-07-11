#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runOtter, type DeliveredContextCapture } from '../agent/otter.js';
import { boundedIncludes } from '../dimensions/locomo-item-overlap.js';
import { createIdxRehydrator } from '../dimensions/locomo-rehydrator.js';
import { gradeLocomoAnswer } from '../dimensions/locomo.js';
import { deepseekChatCompletion, extractContent } from './deepseek-llm.js';
import { createGeminiJudge, geminiJudgeAvailable } from './gemini-llm.js';
import { loadLocomo, type LocomoConversation } from './locomo.js';
import {
  buildEvidenceEntryMap,
  evidenceDiaIds,
  findSnapshotPath,
  sourceEntryIds,
} from './locomo-provenance.js';
import { deepseekApiKey } from './provider-keys.js';
import { createRealMemoryRiver } from './real-river.js';

type CoverageBucket = 'full' | 'partial' | 'zero';
type ContextChannel = 'autoRecall' | 'memory_recall' | 'memory_rehydrate';
type AtomUtilizationBucket = 'absent' | 'present_used' | 'present_unused_early' | 'present_unused_late';

export const CAT1_FANOUT_QUERY_COUNT = 5;
export const CAT1_FANOUT_RECALL_LIMIT = 2;
export const CAT1_FANOUT_MEAN_GAIN_THRESHOLD = 0.15;
export const CAT1_FANOUT_FULL_COVERAGE_MULTIPLIER = 2;
export const CAT1_FANOUT_DEAD_GAIN_THRESHOLD = 0.05;
export const CAT1_FANOUT_REWRITE_PROMPT_TEMPLATE =
  'You generate retrieval queries for a memory benchmark answerer.\n' +
  'Use only the question text below. Do not assume or add facts beyond the question.\n' +
  'Return exactly five concise retrieval sub-queries as a JSON array of strings.\n' +
  'Do not include explanations, numbering, or Markdown.\n\n' +
  'QUESTION:\n{{QUESTION}}';

interface DeliveredContextOptions {
  snapshotDir?: string;
  conversation: string;
  category: number;
  outJson?: string;
  outMarkdown?: string;
}

interface QuestionDeliveredContextResult {
  sampleId: string;
  questionIndex: number;
  category: number;
  question: string;
  goldEntryIds: number[];
  goldCount: number;
  deliveredEntryIds: number[];
  deliveredByChannel: {
    autoRecall: number[];
    memory_recall: number[];
    memory_rehydrate: number[];
  };
  deliveredTextChunks: Record<ContextChannel, string[]>;
  deliveredCharCounts: Record<ContextChannel, number>;
  fanoutSubQueries: string[];
  deliveredCoveredEntryIds: number[];
  deliveredCovered: number;
  deliveredCoverage: number;
  coverageBucket: CoverageBucket;
  goldAtomHitsContextAll: string[];
  goldAtomHitsContextRecallOnly: string[];
  goldAtomHitsContextRehydrateOnly: string[];
  goldAtomRecallContextAll: number;
  goldAtomRecallContextRecallOnly: number;
  goldAtomRecallContextRehydrateOnly: number;
  goldAtomsMeasured: number;
  goldAtomsTotal: number;
  // Axis 1 – position decile of each gold atom in the delivered context
  goldAtomPositionDecileHist: number[];
  meanGoldAtomDecile: number | null;
  // Axis 2 – answer utilization (present-but-unused)
  goldAtomsPresent: number;
  goldAtomsPresentAndUsed: number;
  goldAtomsPresentNotUsed: number;
  utilizationRate: number | null;
  // Cross-tab bucket counts per question
  atomBucketCounts: Record<AtomUtilizationBucket, number>;
  correct: boolean;
  judgeParseFailure: boolean;
}

interface DeliveredContextResult {
  metricLabel: string;
  description: string;
  assumptions: string[];
  metrics: {
    conversation: string;
    category: number;
    questions: number;
    meanDeliveredCoverage: number;
    meanGoldAtomRecallContextAll: number;
    meanGoldAtomRecallContextRecallOnly: number;
    meanGoldAtomRecallContextRehydrateOnly: number;
    fullGoldAtomRecallContextAll: number;
    fullGoldAtomRecallContextRecallOnly: number;
    fullGoldAtomRecallContextRehydrateOnly: number;
    goldAtomsMeasured: number;
    goldAtomsTotal: number;
    fanoutEnabled: boolean;
    fanoutQueryCount: number;
    fanoutRecallLimit: number;
    thresholds: {
      meanGain: number;
      fullCoverageMultiplier: number;
      deadGain: number;
    };
    counts: Record<CoverageBucket, number>;
    accuracy_full: number | null;
    accuracy_partial: number | null;
    accuracy_zero: number | null;
    // Overall cross-tab atom classification
    atomBucketCounts: Record<AtomUtilizationBucket, number>;
    atomBucketPct: Record<AtomUtilizationBucket, number>;
    gateHint: string;
  };
  questions: QuestionDeliveredContextResult[];
  warnings: string[];
}

function usage(): void {
  console.error(
    'Usage: mr-bench locomo-delivered-context --snapshot-dir DIR ' +
    '[--conversation conv-26] [--category 1] [--out-json FILE] [--out-md FILE]',
  );
}

function parsePositiveInteger(option: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${option} requires a positive integer`);
  }
  return parsed;
}

function parseArgs(args: string[]): DeliveredContextOptions {
  const options: DeliveredContextOptions = { conversation: 'conv-26', category: 1 };
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
      options.category = parsePositiveInteger(option, rest.shift());
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

function uniqueNumbers(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function normalizeAtomText(input: string): string {
  return input.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function isExcludedAtom(atom: string): boolean {
  return atom.length <= 3 || /^\d+$/.test(atom);
}

interface Cat1GoldItemsFixture {
  sampleId: string;
  items: Record<string, string[]>;
}

let cachedGoldItems: Cat1GoldItemsFixture | undefined;

function locomoCat1GoldItemsPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', 'fixtures', 'locomo-cat1-gold-items.json'),
    path.join(here, '..', '..', 'src', 'fixtures', 'locomo-cat1-gold-items.json'),
  ];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error('locomo-cat1-gold-items.json not found');
  return found;
}

function loadCat1GoldItems(): Cat1GoldItemsFixture {
  if (!cachedGoldItems) {
    cachedGoldItems = JSON.parse(
      fs.readFileSync(locomoCat1GoldItemsPath(), 'utf8'),
    ) as Cat1GoldItemsFixture;
  }
  return cachedGoldItems;
}

export function measureAtomRecallInContext(
  contextText: string,
  sampleId: string,
  questionIndex: number,
): { hits: string[]; measured: number; total: number; recall: number } {
  const fixture = loadCat1GoldItems();
  const atoms = fixture.sampleId === sampleId ? fixture.items[String(questionIndex)] ?? [] : [];
  const context = normalizeAtomText(contextText);
  const hits: string[] = [];
  let measured = 0;

  for (const atom of atoms) {
    const normalizedAtom = normalizeAtomText(atom);
    if (isExcludedAtom(normalizedAtom)) continue;
    measured++;
    if (boundedIncludes(context, normalizedAtom)) hits.push(atom);
  }

  return {
    hits,
    measured,
    total: atoms.length,
    recall: measured > 0 ? hits.length / measured : 0,
  };
}

/** Finds the first character offset of `needle` (normalized) within `haystack` (normalized).
 * Returns -1 if not found. Uses the same bounded predicate as measureAtomRecallInContext, but
 * also returns the offset so we can compute position decile. */
export function goldAtomFirstOffset(contextNormalized: string, atomNormalized: string): number {
  const escaped = atomNormalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu');
  const match = re.exec(contextNormalized);
  return match ? match.index : -1;
}

/** Classifies measured gold atoms into the four cross-tab buckets.
 * Requires the same `contextNormalized` that was used to compute `goldAtomHitsContextAll`
 * (i.e., `normalizeAtomText(allText)`), plus `answerNormalized` for utilization detection. */
export function classifyGoldAtoms(input: {
  atoms: string[];
  contextNormalized: string;
  answerNormalized: string;
}): {
  buckets: Array<{ atom: string; bucket: AtomUtilizationBucket; decile: number | null }>;
  goldAtomPositionDecileHist: number[];
  meanGoldAtomDecile: number | null;
  goldAtomsPresent: number;
  goldAtomsPresentAndUsed: number;
  goldAtomsPresentNotUsed: number;
  utilizationRate: number | null;
  atomBucketCounts: Record<AtomUtilizationBucket, number>;
} {
  const hist: number[] = Array.from({ length: 10 }, () => 0);
  const deciles: number[] = [];
  let present = 0;
  let presentUsed = 0;
  const counts: Record<AtomUtilizationBucket, number> = {
    absent: 0,
    present_used: 0,
    present_unused_early: 0,
    present_unused_late: 0,
  };
  const buckets: Array<{ atom: string; bucket: AtomUtilizationBucket; decile: number | null }> = [];

  for (const atom of input.atoms) {
    const normalized = normalizeAtomText(atom);
    if (isExcludedAtom(normalized)) continue;

    const offset = goldAtomFirstOffset(input.contextNormalized, normalized);
    if (offset === -1) {
      counts.absent++;
      buckets.push({ atom, bucket: 'absent', decile: null });
      continue;
    }

    present++;
    const contextLen = input.contextNormalized.length;
    const decile = contextLen > 0 ? Math.min(9, Math.floor((offset / contextLen) * 10)) : 0;
    hist[decile]++;
    deciles.push(decile);

    const inAnswer = boundedIncludes(input.answerNormalized, normalized);
    if (inAnswer) {
      presentUsed++;
      counts.present_used++;
      buckets.push({ atom, bucket: 'present_used', decile });
    } else if (decile < 4) {
      counts.present_unused_early++;
      buckets.push({ atom, bucket: 'present_unused_early', decile });
    } else {
      counts.present_unused_late++;
      buckets.push({ atom, bucket: 'present_unused_late', decile });
    }
  }

  const meanGoldAtomDecile = deciles.length > 0
    ? deciles.reduce((sum, d) => sum + d, 0) / deciles.length
    : null;

  return {
    buckets,
    goldAtomPositionDecileHist: hist,
    meanGoldAtomDecile,
    goldAtomsPresent: present,
    goldAtomsPresentAndUsed: presentUsed,
    goldAtomsPresentNotUsed: present - presentUsed,
    utilizationRate: present > 0 ? presentUsed / present : null,
    atomBucketCounts: counts,
  };
}

function sumAtomBucketCounts(
  questions: QuestionDeliveredContextResult[],
): Record<AtomUtilizationBucket, number> {
  const total: Record<AtomUtilizationBucket, number> = {
    absent: 0,
    present_used: 0,
    present_unused_early: 0,
    present_unused_late: 0,
  };
  for (const question of questions) {
    total.absent += question.atomBucketCounts.absent;
    total.present_used += question.atomBucketCounts.present_used;
    total.present_unused_early += question.atomBucketCounts.present_unused_early;
    total.present_unused_late += question.atomBucketCounts.present_unused_late;
  }
  return total;
}

function atomBucketPctFor(counts: Record<AtomUtilizationBucket, number>): Record<AtomUtilizationBucket, number> {
  const total = counts.absent + counts.present_used + counts.present_unused_early + counts.present_unused_late;
  if (total === 0) {
    return { absent: 0, present_used: 0, present_unused_early: 0, present_unused_late: 0 };
  }
  return {
    absent: counts.absent / total,
    present_used: counts.present_used / total,
    present_unused_early: counts.present_unused_early / total,
    present_unused_late: counts.present_unused_late / total,
  };
}

function gateHintFor(counts: Record<AtomUtilizationBucket, number>): string {
  const buckets: AtomUtilizationBucket[] = ['absent', 'present_used', 'present_unused_early', 'present_unused_late'];
  let dominant: AtomUtilizationBucket = buckets[0];
  for (const bucket of buckets) {
    if (counts[bucket] > counts[dominant]) dominant = bucket;
  }
  return `${dominant} dominates`;
}

function parseFanoutSubQueries(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start) throw new Error('fanout response was not JSON');
    parsed = JSON.parse(raw.slice(start, end + 1));
  }
  if (!Array.isArray(parsed)) throw new Error('fanout response must be a JSON array');
  const subQueries = parsed.map(item => typeof item === 'string' ? item.trim() : '').filter(Boolean);
  if (subQueries.length !== CAT1_FANOUT_QUERY_COUNT) {
    throw new Error(`fanout response must contain exactly ${CAT1_FANOUT_QUERY_COUNT} sub-queries`);
  }
  return subQueries;
}

export async function generateFanoutSubQueries(input: {
  apiKey: string;
  model: string;
  question: string;
}): Promise<string[]> {
  const prompt = CAT1_FANOUT_REWRITE_PROMPT_TEMPLATE.replace('{{QUESTION}}', input.question);
  const completion = await deepseekChatCompletion({
    apiKey: input.apiKey,
    model: input.model,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 512,
  });
  return parseFanoutSubQueries(extractContent(completion.message));
}

function formatFanoutMemoryChunk(results: Awaited<ReturnType<LocomoDeliveredRiver['searchMemory']>>): string {
  return results
    .map((result, index) => {
      const ids = sourceEntryIds(result.entry.metadata);
      const prefix = ids.length > 0
        ? `[F${index + 1} sourceEntryIds=${JSON.stringify(ids)}]`
        : `[F${index + 1}]`;
      return `${prefix} • ${result.entry.text}`;
    })
    .join('\n');
}

interface LocomoDeliveredRiver {
  searchMemory(query: string, limit?: number): Promise<Array<{
    entry: { id: string; text: string; metadata?: string };
  }>>;
}

export async function buildFanoutContext(input: {
  river: LocomoDeliveredRiver;
  questionIndex: number;
  question: string;
  apiKey: string;
  model: string;
  deliveredContext: DeliveredContextCapture;
}): Promise<string[]> {
  const subQueries = await generateFanoutSubQueries({
    apiKey: input.apiKey,
    model: input.model,
    question: input.question,
  });
  subQueries.forEach((subQuery, index) => {
    console.error(JSON.stringify({
      event: 'cat1_fanout_sub_query',
      questionIndex: input.questionIndex,
      ordinal: index + 1,
      subQuery,
    }));
  });

  const seenMemoryIds = new Set<string>();
  const chunks: string[] = [];
  for (const subQuery of subQueries) {
    const results = await input.river.searchMemory(subQuery, CAT1_FANOUT_RECALL_LIMIT);
    const uniqueResults = results.filter(result => {
      if (seenMemoryIds.has(result.entry.id)) return false;
      seenMemoryIds.add(result.entry.id);
      return true;
    });
    for (const result of uniqueResults) {
      const ids = sourceEntryIds(result.entry.metadata);
      ids.forEach(id => {
        input.deliveredContext.entryIds.add(id);
        input.deliveredContext.channels.autoRecall.add(id);
      });
    }
    const chunk = formatFanoutMemoryChunk(uniqueResults);
    if (chunk) chunks.push(chunk);
  }

  if (chunks.length > 0) {
    input.deliveredContext.textChunks.autoRecall.push(chunks.join('\n\n'));
  }
  return subQueries;
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

function newDeliveredContextCapture(): DeliveredContextCapture {
  return {
    entryIds: new Set<number>(),
    channels: {
      autoRecall: new Set<number>(),
      memory_recall: new Set<number>(),
      memory_rehydrate: new Set<number>(),
    },
    textChunks: {
      autoRecall: [],
      memory_recall: [],
      memory_rehydrate: [],
    },
  };
}

function bucketFor(coverage: number): CoverageBucket {
  if (coverage === 1) return 'full';
  if (coverage > 0) return 'partial';
  return 'zero';
}

function accuracyForBucket(
  questions: QuestionDeliveredContextResult[],
  bucket: CoverageBucket,
): number | null {
  const matching = questions.filter(question => question.coverageBucket === bucket);
  if (matching.length === 0) return null;
  return matching.filter(question => question.correct).length / matching.length;
}

function textChunksFromCapture(
  result: { deliveredContext?: { textChunks: Record<ContextChannel, string[]> } },
  deliveredContext: DeliveredContextCapture,
): Record<ContextChannel, string[]> {
  return result.deliveredContext?.textChunks ?? deliveredContext.textChunks;
}

function charCountsFor(chunks: Record<ContextChannel, string[]>): Record<ContextChannel, number> {
  return {
    autoRecall: chunks.autoRecall.reduce((sum, chunk) => sum + chunk.length, 0),
    memory_recall: chunks.memory_recall.reduce((sum, chunk) => sum + chunk.length, 0),
    memory_rehydrate: chunks.memory_rehydrate.reduce((sum, chunk) => sum + chunk.length, 0),
  };
}

function joinContext(chunks: string[]): string {
  return chunks.filter(Boolean).join('\n\n');
}

export async function runLocomoDeliveredContext(
  options: DeliveredContextOptions,
): Promise<DeliveredContextResult> {
  if (!deepseekApiKey()) throw new Error('DEEPSEEK_API_KEY is required for the Otter answer path');
  if (!geminiJudgeAvailable()) throw new Error('GEMINI_API_KEY is required for judge correctness');

  const conversation = loadLocomo().find(item => item.sampleId === options.conversation);
  if (!conversation) throw new Error(`conversation not found: ${options.conversation}`);
  const snapshotPath = findSnapshotPath(options.snapshotDir!, conversation);
  if (!snapshotPath) {
    throw new Error(`${conversation.sampleId}: no restored snapshot found in ${options.snapshotDir}`);
  }

  const real = await createRealMemoryRiver(undefined, snapshotPath);
  const judge = createGeminiJudge();
  const warnings: string[] = [];
  try {
    const convKey = `locomo-${conversation.sampleId}`;
    const sessionKeys = conversation.sessions.map(session => `${convKey}-s${session.index}`);
    const rehydrateById = createIdxRehydrator(
      path.join(real.dataDir, 'transcripts'),
      sessionKeys,
    );
    const targets = conversation.qa
      .map((qa, questionIndex) => ({ qa, questionIndex }))
      .filter(({ qa }) => qa.category === options.category);
    const questions: QuestionDeliveredContextResult[] = [];
    const fanoutEnabled = process.env.MR_CAT1_FANOUT === '1';
    const answerModel = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';

    for (const { qa, questionIndex } of targets) {
      const deliveredContext = newDeliveredContextCapture();
      const fanoutSubQueries = fanoutEnabled
        ? await buildFanoutContext({
            river: real.river,
            questionIndex,
            question: qa.question,
            apiKey: deepseekApiKey()!,
            model: answerModel,
            deliveredContext,
          })
        : [];
      const extraAutoRecallContext = fanoutEnabled
        ? [...deliveredContext.textChunks.autoRecall]
        : undefined;
      const result = await runOtter({
        llm: {
          apiKey: deepseekApiKey()!,
          model: answerModel,
        },
        river: real.river,
        question: qa.question,
        sessionKeys,
        conversationKey: convKey,
        rehydrateById,
        deliveredContext,
        extraAutoRecallContext,
      });
      const grade = await gradeLocomoAnswer(judge, {
        question: qa.question,
        answer: qa.answer,
        evidence: qa.evidence,
        category: String(qa.category),
        sourceIndex: qa.sourceIndex,
      }, result.answer);

      const goldEntryIds = goldEntryIdsForQuestion(conversation, snapshotPath, qa.evidence);
      if (goldEntryIds.length === 0) {
        warnings.push(`${conversation.sampleId} q${questionIndex}: no mapped gold entryIds`);
      }
      const goldSet = new Set(goldEntryIds);
      const deliveredEntryIds = result.deliveredContext?.entryIds ?? uniqueNumbers(deliveredContext.entryIds);
      const deliveredCoveredEntryIds = deliveredEntryIds.filter(entryId => goldSet.has(entryId));
      const deliveredCoverage = goldEntryIds.length > 0
        ? deliveredCoveredEntryIds.length / goldEntryIds.length
        : 0;
      const deliveredTextChunks = textChunksFromCapture(result, deliveredContext);
      const deliveredCharCounts = charCountsFor(deliveredTextChunks);
      const recallOnlyText = joinContext([
        ...deliveredTextChunks.autoRecall,
        ...deliveredTextChunks.memory_recall,
      ]);
      const allText = joinContext([
        ...deliveredTextChunks.autoRecall,
        ...deliveredTextChunks.memory_recall,
        ...deliveredTextChunks.memory_rehydrate,
      ]);
      const rehydrateOnlyText = joinContext(deliveredTextChunks.memory_rehydrate);
      const atomRecallOnly = measureAtomRecallInContext(
        recallOnlyText,
        conversation.sampleId,
        questionIndex,
      );
      const atomAll = measureAtomRecallInContext(
        allText,
        conversation.sampleId,
        questionIndex,
      );
      const atomRehydrateOnly = measureAtomRecallInContext(
        rehydrateOnlyText,
        conversation.sampleId,
        questionIndex,
      );

      // Axis 1 (position decile) + Axis 2 (utilization) + cross-tab.
      // Position basis: normalizeAtomText(allText) — the same string used to compute
      // goldAtomHitsContextAll via measureAtomRecallInContext/boundedIncludes above.
      // This equals the full delivered text (autoRecall + memory_recall + memory_rehydrate chunks),
      // which is the context the answerer saw minus the SYSTEM_PROMPT preamble (which contains
      // no gold atoms). normalizeAtomText lowercases and collapses whitespace identically to
      // how measureAtomRecallInContext normalises before calling boundedIncludes.
      const fixture = loadCat1GoldItems();
      const allAtoms = fixture.sampleId === conversation.sampleId
        ? fixture.items[String(questionIndex)] ?? []
        : [];
      const contextNormalized = normalizeAtomText(allText);
      const answerNormalized = normalizeAtomText(result.answer);
      const atomClassification = classifyGoldAtoms({
        atoms: allAtoms,
        contextNormalized,
        answerNormalized,
      });

      if (process.env.MR_DC_DUMP) {
        fs.appendFileSync(process.env.MR_DC_DUMP, JSON.stringify({
          questionIndex,
          question: qa.question,
          goldAnswer: qa.answer,
          modelAnswer: result.answer,
          correct: grade.correct,
          bucket: bucketFor(deliveredCoverage),
          coverage: deliveredCoverage,
          fanoutSubQueries,
          deliveredCharCounts,
          goldAtomRecallContextAll: atomAll.recall,
          goldAtomRecallContextRecallOnly: atomRecallOnly.recall,
          goldAtomRecallContextRehydrateOnly: atomRehydrateOnly.recall,
          goldAtomsMeasured: atomRecallOnly.measured,
          goldAtomsTotal: atomRecallOnly.total,
        }) + '\n');
      }
      questions.push({
        sampleId: conversation.sampleId,
        questionIndex,
        category: qa.category,
        question: qa.question,
        goldEntryIds,
        goldCount: goldEntryIds.length,
        deliveredEntryIds,
        deliveredByChannel: result.deliveredContext?.channels ?? {
          autoRecall: uniqueNumbers(deliveredContext.channels.autoRecall),
          memory_recall: uniqueNumbers(deliveredContext.channels.memory_recall),
          memory_rehydrate: uniqueNumbers(deliveredContext.channels.memory_rehydrate),
        },
        deliveredTextChunks,
        deliveredCharCounts,
        fanoutSubQueries,
        deliveredCoveredEntryIds,
        deliveredCovered: deliveredCoveredEntryIds.length,
        deliveredCoverage,
        coverageBucket: bucketFor(deliveredCoverage),
        goldAtomHitsContextAll: atomAll.hits,
        goldAtomHitsContextRecallOnly: atomRecallOnly.hits,
        goldAtomHitsContextRehydrateOnly: atomRehydrateOnly.hits,
        goldAtomRecallContextAll: atomAll.recall,
        goldAtomRecallContextRecallOnly: atomRecallOnly.recall,
        goldAtomRecallContextRehydrateOnly: atomRehydrateOnly.recall,
        goldAtomsMeasured: atomRecallOnly.measured,
        goldAtomsTotal: atomRecallOnly.total,
        goldAtomPositionDecileHist: atomClassification.goldAtomPositionDecileHist,
        meanGoldAtomDecile: atomClassification.meanGoldAtomDecile,
        goldAtomsPresent: atomClassification.goldAtomsPresent,
        goldAtomsPresentAndUsed: atomClassification.goldAtomsPresentAndUsed,
        goldAtomsPresentNotUsed: atomClassification.goldAtomsPresentNotUsed,
        utilizationRate: atomClassification.utilizationRate,
        atomBucketCounts: atomClassification.atomBucketCounts,
        correct: grade.correct,
        judgeParseFailure: grade.parseFailure,
      });
    }

    return {
      metricLabel: 'DeliveredCoverageVsAccuracy(real_otter_answer_path)',
      description:
        'Read-only diagnostic: union of sourceEntryIds/entryIds actually delivered to Otter, paired with judge.correct.',
      assumptions: [
        'Skill capsules and GWM status text do not carry cat1 sibling gold sourceEntryIds; if a future channel exposes memory sourceEntryIds, add it as a delivered channel.',
        'Gold mapping reuses buildEvidenceEntryMap + evidenceDiaIds from locomo-provenance; no cross-language string matching is used.',
      ],
      metrics: {
        conversation: conversation.sampleId,
        category: options.category,
        questions: questions.length,
        meanDeliveredCoverage: mean(questions.map(question => question.deliveredCoverage)),
        meanGoldAtomRecallContextAll: mean(questions.map(question => question.goldAtomRecallContextAll)),
        meanGoldAtomRecallContextRecallOnly: mean(questions.map(question => question.goldAtomRecallContextRecallOnly)),
        meanGoldAtomRecallContextRehydrateOnly: mean(questions.map(question => question.goldAtomRecallContextRehydrateOnly)),
        fullGoldAtomRecallContextAll: questions.filter(question => question.goldAtomRecallContextAll === 1).length,
        fullGoldAtomRecallContextRecallOnly: questions.filter(question => question.goldAtomRecallContextRecallOnly === 1).length,
        fullGoldAtomRecallContextRehydrateOnly: questions.filter(question => question.goldAtomRecallContextRehydrateOnly === 1).length,
        goldAtomsMeasured: questions.reduce((sum, question) => sum + question.goldAtomsMeasured, 0),
        goldAtomsTotal: questions.reduce((sum, question) => sum + question.goldAtomsTotal, 0),
        fanoutEnabled,
        fanoutQueryCount: CAT1_FANOUT_QUERY_COUNT,
        fanoutRecallLimit: CAT1_FANOUT_RECALL_LIMIT,
        thresholds: {
          meanGain: CAT1_FANOUT_MEAN_GAIN_THRESHOLD,
          fullCoverageMultiplier: CAT1_FANOUT_FULL_COVERAGE_MULTIPLIER,
          deadGain: CAT1_FANOUT_DEAD_GAIN_THRESHOLD,
        },
        counts: {
          full: questions.filter(question => question.coverageBucket === 'full').length,
          partial: questions.filter(question => question.coverageBucket === 'partial').length,
          zero: questions.filter(question => question.coverageBucket === 'zero').length,
        },
        accuracy_full: accuracyForBucket(questions, 'full'),
        accuracy_partial: accuracyForBucket(questions, 'partial'),
        accuracy_zero: accuracyForBucket(questions, 'zero'),
        atomBucketCounts: sumAtomBucketCounts(questions),
        atomBucketPct: atomBucketPctFor(sumAtomBucketCounts(questions)),
        gateHint: gateHintFor(sumAtomBucketCounts(questions)),
      },
      questions,
      warnings,
    };
  } finally {
    await real.cleanup();
  }
}

export function renderLocomoDeliveredContext(result: DeliveredContextResult): string {
  const { metrics } = result;
  const lines = [
    '# LoCoMo Delivered Context Diagnostic',
    '',
    `${result.metricLabel}: mean delivered coverage ${pct(metrics.meanDeliveredCoverage)} (${metrics.questions} cat${metrics.category} questions)`,
    result.description,
    '',
    `Conversation: ${metrics.conversation}`,
    `Fanout: ${metrics.fanoutEnabled ? 'on' : 'off'} (N=${metrics.fanoutQueryCount}, recallLimit=${metrics.fanoutRecallLimit})`,
    `Bucket counts: full=${metrics.counts.full}, partial=${metrics.counts.partial}, zero=${metrics.counts.zero}`,
    `Atom denominator: measured=${metrics.goldAtomsMeasured}, total=${metrics.goldAtomsTotal}`,
    `Atom recall primary (autoRecall+memory_recall): mean=${pct(metrics.meanGoldAtomRecallContextRecallOnly)}, full=${metrics.fullGoldAtomRecallContextRecallOnly}`,
    `Atom recall all context: mean=${pct(metrics.meanGoldAtomRecallContextAll)}, full=${metrics.fullGoldAtomRecallContextAll}`,
    `Atom recall rehydrate-only (separate): mean=${pct(metrics.meanGoldAtomRecallContextRehydrateOnly)}, full=${metrics.fullGoldAtomRecallContextRehydrateOnly}`,
    `Fanout thresholds: meanGain>=${(metrics.thresholds.meanGain * 100).toFixed(0)}pp or fullCoverageMultiplier>=${metrics.thresholds.fullCoverageMultiplier}x; deadGain<${(metrics.thresholds.deadGain * 100).toFixed(0)}pp`,
    `Accuracy full: ${pct(metrics.accuracy_full)}`,
    `Accuracy partial: ${pct(metrics.accuracy_partial)}`,
    `Accuracy zero: ${pct(metrics.accuracy_zero)}`,
    '',
    `Atom cross-tab: absent=${metrics.atomBucketCounts.absent} (${pct(metrics.atomBucketPct.absent)}), present_used=${metrics.atomBucketCounts.present_used} (${pct(metrics.atomBucketPct.present_used)}), present_unused_early=${metrics.atomBucketCounts.present_unused_early} (${pct(metrics.atomBucketPct.present_unused_early)}), present_unused_late=${metrics.atomBucketCounts.present_unused_late} (${pct(metrics.atomBucketPct.present_unused_late)})`,
    `Gate hint: ${metrics.gateHint}`,
    '',
    '| q | gold | covered | bucket | atoms measured/total | recall-only | all | rehydrate-only | chars auto/recall/rehydrate | correct |',
    '|---:|---:|---:|---|---:|---:|---:|---:|---:|---|',
    ...result.questions.map(question =>
      `| ${question.questionIndex} | ${question.goldCount} | ${question.deliveredCovered} | ${question.coverageBucket} | ` +
      `${question.goldAtomsMeasured}/${question.goldAtomsTotal} | ` +
      `${pct(question.goldAtomRecallContextRecallOnly)} | ${pct(question.goldAtomRecallContextAll)} | ` +
      `${pct(question.goldAtomRecallContextRehydrateOnly)} | ` +
      `${question.deliveredCharCounts.autoRecall}/${question.deliveredCharCounts.memory_recall}/${question.deliveredCharCounts.memory_rehydrate} | ` +
      `${question.correct ? 'yes' : 'no'} |`
    ),
    '',
    'Assumptions:',
    ...result.assumptions.map(assumption => `- ${assumption}`),
  ];
  if (result.warnings.length > 0) {
    lines.push('', 'Warnings:', ...result.warnings.map(warning => `- ${warning}`));
  }
  return lines.join('\n');
}

export async function runCli(input: string[]): Promise<number> {
  try {
    const options = parseArgs(input);
    const result = await runLocomoDeliveredContext(options);
    const markdown = renderLocomoDeliveredContext(result);
    const json = JSON.stringify(result, null, 2);
    if (options.outMarkdown) fs.writeFileSync(options.outMarkdown, `${markdown}\n`, 'utf8');
    if (options.outJson) fs.writeFileSync(options.outJson, `${json}\n`, 'utf8');
    console.log(markdown);
    if (!options.outJson) console.log(`\n${json}`);
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`locomo-delivered-context fatal:\n${detail}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runCli(process.argv.slice(2));
}
