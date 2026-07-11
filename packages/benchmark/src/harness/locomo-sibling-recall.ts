#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

import type { MemorySearchResult } from '@memory-river/core';

import { buildEnumerationPlan } from './enumeration-plan.js';
import { loadLocomo, type LocomoConversation } from './locomo.js';
import {
  buildEvidenceEntryMap,
  evidenceDiaIds,
  findSnapshotPath,
  type GraphTripleRow,
  type MemoryRow,
  readLanceRows,
  sourceEntryIds,
} from './locomo-provenance.js';
import { createRealMemoryRiver } from './real-river.js';

interface SiblingRecallOptions {
  snapshotDir?: string;
  conversation?: string;
  category: number;
  k: number;
  json?: boolean;
}

interface PresenceCounts {
  goldEntryIds: number;
  notePresent: number;
  graphPresent: number;
}

interface QuestionResult {
  sampleId: string;
  questionIndex: number;
  category: number;
  question: string;
  plan?: {
    anchors: string[];
    setMode: string;
    relationText?: string;
    direction?: string;
  };
  plannerSkipped: boolean;
  fallbackUsed: boolean;
  goldEntryIds: number[];
  returnedMemoryIds: string[];
  coveredGoldEntryIds: number[];
  siblingRecall: number | null;
  noiseAt10: number | null;
}

interface SiblingRecallMetrics {
  conversations: number;
  category: number;
  k: number;
  questions: number;
  scoredQuestions: number;
  plannerSkipped: number;
  plannerSkippedRate: number;
  fallbackUsed: number;
  fallbackUsedRate: number;
  meanSiblingRecallAtK: number;
  graphPresenceRate: number;
  notePresenceRate: number;
  noiseAt10: number;
  presence: PresenceCounts;
}

interface SiblingRecallResult {
  metricLabel: string;
  description: string;
  metrics: SiblingRecallMetrics;
  questions: QuestionResult[];
  warnings: string[];
}

function usage(): void {
  console.error(
    'Usage: mr-bench locomo-sibling-recall --snapshot-dir DIR ' +
    '[--conversation conv-26] [--category N default 1] [--k N] [--json]',
  );
}

function parsePositiveInteger(option: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${option} requires a positive integer`);
  }
  return parsed;
}

function parseArgs(args: string[]): SiblingRecallOptions {
  const options: SiblingRecallOptions = { category: 1, k: 10 };
  const rest = [...args];
  while (rest.length > 0) {
    const option = rest.shift();
    if (option === '--snapshot-dir') {
      options.snapshotDir = rest.shift();
      if (!options.snapshotDir || options.snapshotDir.startsWith('--')) {
        throw new Error('--snapshot-dir requires a directory path');
      }
    } else if (option === '--conversation') {
      options.conversation = rest.shift();
      if (!options.conversation || options.conversation.startsWith('--')) {
        throw new Error('--conversation requires a LoCoMo sample id such as conv-26');
      }
    } else if (option === '--category') {
      options.category = parsePositiveInteger(option, rest.shift());
    } else if (option === '--k') {
      options.k = parsePositiveInteger(option, rest.shift());
    } else if (option === '--json') {
      options.json = true;
    } else if (option === '--help' || option === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${option}`);
    }
  }
  return options;
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
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

async function loadPresence(snapshotPath: string): Promise<{
  memoryIdsByEntryId: Map<number, string[]>;
  triplesByMemoryId: Map<string, GraphTripleRow[]>;
}> {
  const memories = (await readLanceRows<MemoryRow>(
    snapshotPath,
    'memories',
    ['id', 'text', 'metadata', 'category', 'status'],
  )).filter(row => row.id !== 'init_00000000000000000000000000000000');
  const triples = (await readLanceRows<GraphTripleRow>(
    snapshotPath,
    'graph_triples',
    ['id', 'subject', 'relation', 'object', 'sourceMemoryId'],
  )).filter(row => !row.id.startsWith('init_'));

  const memoryIdsByEntryId = new Map<number, string[]>();
  for (const memory of memories) {
    for (const entryId of sourceEntryIds(memory.metadata)) {
      const ids = memoryIdsByEntryId.get(entryId) ?? [];
      ids.push(memory.id);
      memoryIdsByEntryId.set(entryId, ids);
    }
  }

  const triplesByMemoryId = new Map<string, GraphTripleRow[]>();
  for (const triple of triples) {
    const rows = triplesByMemoryId.get(triple.sourceMemoryId) ?? [];
    rows.push(triple);
    triplesByMemoryId.set(triple.sourceMemoryId, rows);
  }
  return { memoryIdsByEntryId, triplesByMemoryId };
}

function coveredGoldEntryIds(results: MemorySearchResult[], goldEntryIds: Set<number>): number[] {
  const covered = new Set<number>();
  for (const result of results) {
    for (const sourceEntryId of sourceEntryIds(result.entry.metadata)) {
      if (goldEntryIds.has(sourceEntryId)) covered.add(sourceEntryId);
    }
  }
  return uniqueNumbers([...covered]);
}

function returnedMemoryIds(results: MemorySearchResult[]): string[] {
  return results.map(result => result.entry.id);
}

function noiseAt10(results: MemorySearchResult[], goldEntryIds: Set<number>): number | null {
  if (results.length === 0) return null;
  const noisy = results.filter(result =>
    sourceEntryIds(result.entry.metadata).every(entryId => !goldEntryIds.has(entryId))
  ).length;
  return noisy / results.length;
}

async function scoreConversation(
  conversation: LocomoConversation,
  snapshotPath: string,
  category: number,
  k: number,
): Promise<{ questions: QuestionResult[]; presence: PresenceCounts; warnings: string[] }> {
  const presenceData = await loadPresence(snapshotPath);
  const real = await createRealMemoryRiver(undefined, snapshotPath);
  try {
    const preflight = await real.river.enumerate({
      anchors: [conversation.speakerA],
      setMode: 'union',
      direction: 'both',
    }, 1);
    if (preflight.length === 0) {
      throw new Error(
        `${conversation.sampleId}: enumerate preflight returned 0 for known anchor ` +
        `${JSON.stringify(conversation.speakerA)}; restored graph may be empty or drifted`,
      );
    }

    const questions: QuestionResult[] = [];
    const warnings: string[] = [];
    const presence: PresenceCounts = { goldEntryIds: 0, notePresent: 0, graphPresent: 0 };
    const targets = conversation.qa
      .map((qa, questionIndex) => ({ qa, questionIndex }))
      .filter(({ qa }) => qa.category === category);

    for (const { qa, questionIndex } of targets) {
      const goldEntryIds = goldEntryIdsForQuestion(conversation, snapshotPath, qa.evidence);
      for (const entryId of goldEntryIds) {
        presence.goldEntryIds++;
        const memoryIds = presenceData.memoryIdsByEntryId.get(entryId) ?? [];
        if (memoryIds.length > 0) presence.notePresent++;
        if (memoryIds.some(memoryId => (presenceData.triplesByMemoryId.get(memoryId) ?? []).length > 0)) {
          presence.graphPresent++;
        }
      }
      if (goldEntryIds.length === 0) {
        warnings.push(`${conversation.sampleId} q${questionIndex}: no mapped gold entryIds`);
      }

      const planResult = buildEnumerationPlan(qa.question, conversation);
      if (planResult.plannerSkipped || !planResult.plan) {
        questions.push({
          sampleId: conversation.sampleId,
          questionIndex,
          category: qa.category,
          question: qa.question,
          plannerSkipped: true,
          fallbackUsed: false,
          goldEntryIds,
          returnedMemoryIds: [],
          coveredGoldEntryIds: [],
          siblingRecall: null,
          noiseAt10: null,
        });
        continue;
      }

      const goldSet = new Set(goldEntryIds);
      const resultsAtK = goldEntryIds.length > 0
        ? await real.river.enumerate(planResult.plan, k)
        : [];
      const resultsAt10 = goldEntryIds.length > 0
        ? (k === 10 ? resultsAtK : await real.river.enumerate(planResult.plan, 10))
        : [];
      const covered = coveredGoldEntryIds(resultsAtK, goldSet);
      questions.push({
        sampleId: conversation.sampleId,
        questionIndex,
        category: qa.category,
        question: qa.question,
        plan: planResult.plan,
        plannerSkipped: false,
        fallbackUsed: planResult.fallbackUsed,
        goldEntryIds,
        returnedMemoryIds: returnedMemoryIds(resultsAtK),
        coveredGoldEntryIds: covered,
        siblingRecall: goldEntryIds.length > 0 ? covered.length / goldEntryIds.length : null,
        noiseAt10: goldEntryIds.length > 0 ? noiseAt10(resultsAt10, goldSet) : null,
      });
    }

    return { questions, presence, warnings };
  } finally {
    await real.cleanup();
  }
}

export async function runLocomoSiblingRecall(options: SiblingRecallOptions): Promise<SiblingRecallResult> {
  if (!options.snapshotDir) throw new Error('--snapshot-dir is required');

  const conversations = loadLocomo()
    .filter(conversation => !options.conversation || conversation.sampleId === options.conversation);
  if (conversations.length === 0) {
    throw new Error(`no LoCoMo conversations matched ${options.conversation ?? '(all)'}`);
  }

  const questions: QuestionResult[] = [];
  const warnings: string[] = [];
  const presence: PresenceCounts = { goldEntryIds: 0, notePresent: 0, graphPresent: 0 };
  let scoredConversations = 0;
  for (const conversation of conversations) {
    const snapshotPath = findSnapshotPath(options.snapshotDir, conversation);
    if (!snapshotPath) {
      warnings.push(`${conversation.sampleId}: no restored snapshot found in ${options.snapshotDir}`);
      continue;
    }
    scoredConversations++;
    const result = await scoreConversation(conversation, snapshotPath, options.category, options.k);
    questions.push(...result.questions);
    warnings.push(...result.warnings);
    presence.goldEntryIds += result.presence.goldEntryIds;
    presence.notePresent += result.presence.notePresent;
    presence.graphPresent += result.presence.graphPresent;
  }

  const scored = questions.filter(question =>
    !question.plannerSkipped && question.siblingRecall !== null
  );
  const plannerSkipped = questions.filter(question => question.plannerSkipped).length;
  const fallbackUsed = scored.filter(question => question.fallbackUsed).length;
  const noiseValues = scored
    .map(question => question.noiseAt10)
    .filter((value): value is number => value !== null);

  return {
    metricLabel: `SiblingRecall@${options.k}(memory_layer_direct)`,
    description:
      'Oracle/deterministic enumeration plan over memory layer only; bypasses the answer model and overstates product behavior.',
    metrics: {
      conversations: scoredConversations,
      category: options.category,
      k: options.k,
      questions: questions.length,
      scoredQuestions: scored.length,
      plannerSkipped,
      plannerSkippedRate: questions.length > 0 ? plannerSkipped / questions.length : 0,
      fallbackUsed,
      fallbackUsedRate: scored.length > 0 ? fallbackUsed / scored.length : 0,
      meanSiblingRecallAtK: mean(scored.map(question => question.siblingRecall ?? 0)),
      graphPresenceRate: presence.notePresent > 0 ? presence.graphPresent / presence.notePresent : 0,
      notePresenceRate: presence.goldEntryIds > 0 ? presence.notePresent / presence.goldEntryIds : 0,
      noiseAt10: mean(noiseValues),
      presence,
    },
    questions,
    warnings,
  };
}

export function renderLocomoSiblingRecall(result: SiblingRecallResult): string {
  const { metrics } = result;
  const lines = [
    '# LoCoMo Sibling Recall',
    '',
    `${result.metricLabel}: ${pct(metrics.meanSiblingRecallAtK)} (${metrics.scoredQuestions} scored cat${metrics.category} questions)`,
    result.description,
    '',
    `Conversations: ${metrics.conversations}`,
    `PlannerSkipped: ${metrics.plannerSkipped} / ${metrics.questions} (${pct(metrics.plannerSkippedRate)})`,
    `FallbackUsed: ${metrics.fallbackUsed} / ${metrics.scoredQuestions} (${pct(metrics.fallbackUsedRate)})`,
    `GraphPresenceRate: ${pct(metrics.graphPresenceRate)} (${metrics.presence.graphPresent}/${metrics.presence.notePresent})`,
    `NotePresenceRate: ${pct(metrics.notePresenceRate)} (${metrics.presence.notePresent}/${metrics.presence.goldEntryIds})`,
    `Noise@10: ${pct(metrics.noiseAt10)}`,
  ];
  if (result.warnings.length > 0) {
    lines.push('', 'Warnings:', ...result.warnings.map(warning => `- ${warning}`));
  }
  return lines.join('\n');
}

export async function runCli(input: string[]): Promise<number> {
  try {
    const options = parseArgs(input);
    const result = await runLocomoSiblingRecall(options);
    console.log(
      options.json
        ? JSON.stringify(result, null, 2)
        : renderLocomoSiblingRecall(result),
    );
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`locomo-sibling-recall fatal:\n${detail}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runCli(process.argv.slice(2));
}
