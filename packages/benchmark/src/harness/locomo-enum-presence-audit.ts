#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

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

const PRONOUN_RE = /^(?:他|她|它|they|them|he|she|him|her|it)$/i;

interface AuditOptions {
  snapshotDir?: string;
  conversation?: string;
  category?: number;
  limit?: number;
  maxQuestions?: number;
  rebuildSnapshot?: boolean;
  json?: boolean;
}

interface EvidenceAudit {
  evidence: string;
  sessionKey?: string;
  entryId?: number;
  transcriptPresent: boolean;
  notePresent: boolean;
  graphPresent: boolean;
  noteMemoryIds: string[];
  graphTriples: Array<{
    sourceMemoryId: string;
    subject: string;
    relation: string;
    object: string;
  }>;
}

interface QuestionAudit {
  sampleId: string;
  questionIndex: number;
  category: number;
  question: string;
  evidence: EvidenceAudit[];
}

interface PresenceMetrics {
  questions: number;
  evidenceItems: number;
  transcriptPresent: number;
  notePresent: number;
  graphPresent: number;
  transcriptPresenceRate: number;
  notePresenceRate: number;
  graphPresenceRate: number;
  // Per-question set completeness: every gold sibling present at the layer.
  // graphComplete implies the full enumeration set is assembled in the graph.
  noteCompleteQuestions: number;
  graphCompleteQuestions: number;
  noteCompleteRate: number;
  graphCompleteRate: number;
}

interface CategorySummary extends PresenceMetrics {
  category: number;
}

interface AuditResult {
  conversations: number;
  overall: PresenceMetrics;
  byCategory: CategorySummary[];
  pronounTripleHits: number;
  graphSurfaceStrings: Array<{
    count: number;
    subject: string;
    relation: string;
    object: string;
  }>;
  questions: QuestionAudit[];
  warnings: string[];
}

function summarize(questions: QuestionAudit[]): PresenceMetrics {
  const evidence = questions.flatMap(question => question.evidence);
  const transcriptPresent = evidence.filter(item => item.transcriptPresent).length;
  const noteDenominator = evidence.filter(item => item.transcriptPresent);
  const notePresent = noteDenominator.filter(item => item.notePresent).length;
  const graphDenominator = evidence.filter(item => item.notePresent);
  const graphPresent = graphDenominator.filter(item => item.graphPresent).length;

  const withEvidence = questions.filter(question => question.evidence.length > 0);
  const noteCompleteQuestions = withEvidence
    .filter(question => question.evidence.every(item => item.notePresent)).length;
  const graphCompleteQuestions = withEvidence
    .filter(question => question.evidence.every(item => item.graphPresent)).length;

  return {
    questions: questions.length,
    evidenceItems: evidence.length,
    transcriptPresent,
    notePresent,
    graphPresent,
    transcriptPresenceRate: evidence.length > 0 ? transcriptPresent / evidence.length : 0,
    notePresenceRate: noteDenominator.length > 0 ? notePresent / noteDenominator.length : 0,
    graphPresenceRate: graphDenominator.length > 0 ? graphPresent / graphDenominator.length : 0,
    noteCompleteQuestions,
    graphCompleteQuestions,
    noteCompleteRate: withEvidence.length > 0 ? noteCompleteQuestions / withEvidence.length : 0,
    graphCompleteRate: withEvidence.length > 0 ? graphCompleteQuestions / withEvidence.length : 0,
  };
}

function usage(): void {
  console.error(
    'Usage: mr-bench locomo-enum-presence-audit --snapshot-dir DIR ' +
    '[--conversation conv-26] [--category N] [--limit N] [--max-questions N] [--json]',
  );
}

function parsePositiveInteger(option: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${option} requires a positive integer`);
  }
  return parsed;
}

function parseArgs(args: string[]): AuditOptions {
  const options: AuditOptions = {};
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
    } else if (option === '--limit') {
      options.limit = parsePositiveInteger(option, rest.shift());
    } else if (option === '--max-questions') {
      options.maxQuestions = parsePositiveInteger(option, rest.shift());
    } else if (option === '--rebuild-snapshot') {
      options.rebuildSnapshot = true;
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

async function auditConversation(
  conversation: LocomoConversation,
  snapshotPath: string,
  category?: number,
  maxQuestions?: number,
): Promise<{ questions: QuestionAudit[]; warnings: string[] }> {
  const evidenceEntryMap = buildEvidenceEntryMap(conversation, snapshotPath);
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

  const questions = conversation.qa
    .map((qa, questionIndex) => ({ qa, questionIndex }))
    .filter(({ qa }) => category === undefined || qa.category === category)
    .slice(0, maxQuestions);
  const warnings: string[] = [];

  return {
    warnings,
    questions: questions.map(({ qa, questionIndex }) => {
      const evidence = qa.evidence.flatMap(item => evidenceDiaIds(item).map(diaId => {
        const mapped = evidenceEntryMap.get(diaId);
        if (!mapped) {
          warnings.push(
            `${conversation.sampleId} q${questionIndex} evidence ${diaId}: no dia_id -> transcript entry mapping`,
          );
        }
        const noteMemoryIds = mapped ? memoryIdsByEntryId.get(mapped.entryId) ?? [] : [];
        const graphTriples = noteMemoryIds.flatMap(memoryId => triplesByMemoryId.get(memoryId) ?? []);
        return {
          evidence: diaId,
          sessionKey: mapped?.sessionKey,
          entryId: mapped?.entryId,
          transcriptPresent: !!mapped,
          notePresent: noteMemoryIds.length > 0,
          graphPresent: graphTriples.length > 0,
          noteMemoryIds,
          graphTriples: graphTriples.map(triple => ({
            sourceMemoryId: triple.sourceMemoryId,
            subject: triple.subject,
            relation: triple.relation,
            object: triple.object,
          })),
        };
      }));

      return {
        sampleId: conversation.sampleId,
        questionIndex,
        category: qa.category,
        question: qa.question,
        evidence,
      };
    }),
  };
}

export async function runLocomoEnumPresenceAudit(options: AuditOptions): Promise<AuditResult> {
  if (!options.snapshotDir) throw new Error('--snapshot-dir is required');
  if (options.rebuildSnapshot) {
    throw new Error(
      '--rebuild-snapshot is not supported by this read-only audit entry. ' +
      'Build snapshots with mr-bench locomo, then rerun the audit against --snapshot-dir.',
    );
  }

  const conversations = loadLocomo()
    .filter(conversation => !options.conversation || conversation.sampleId === options.conversation)
    .slice(0, options.limit ?? undefined);
  if (conversations.length === 0) {
    throw new Error(`no LoCoMo conversations matched ${options.conversation ?? '(all)'}`);
  }

  const auditedQuestions: QuestionAudit[] = [];
  const warnings: string[] = [];
  let auditedConversations = 0;
  for (const conversation of conversations) {
    const snapshotPath = findSnapshotPath(options.snapshotDir, conversation);
    if (!snapshotPath) {
      warnings.push(`${conversation.sampleId}: no restored snapshot found in ${options.snapshotDir}`);
      continue;
    }
    auditedConversations++;
    const result = await auditConversation(
      conversation, snapshotPath, options.category, options.maxQuestions);
    auditedQuestions.push(...result.questions);
    warnings.push(...result.warnings);
  }

  const evidence = auditedQuestions.flatMap(question => question.evidence);
  const categories = [...new Set(auditedQuestions.map(question => question.category))]
    .sort((left, right) => left - right);
  const byCategory: CategorySummary[] = categories.map(category => ({
    category,
    ...summarize(auditedQuestions.filter(question => question.category === category)),
  }));
  const graphSurfaceCounts = new Map<string, {
    count: number;
    subject: string;
    relation: string;
    object: string;
  }>();
  let pronounTripleHits = 0;
  for (const item of evidence) {
    for (const triple of item.graphTriples) {
      if (PRONOUN_RE.test(triple.subject) || PRONOUN_RE.test(triple.object)) pronounTripleHits++;
      const key = `${triple.subject}\u001f${triple.relation}\u001f${triple.object}`;
      const current = graphSurfaceCounts.get(key) ?? {
        count: 0,
        subject: triple.subject,
        relation: triple.relation,
        object: triple.object,
      };
      current.count++;
      graphSurfaceCounts.set(key, current);
    }
  }

  return {
    conversations: auditedConversations,
    overall: summarize(auditedQuestions),
    byCategory,
    pronounTripleHits,
    graphSurfaceStrings: [...graphSurfaceCounts.values()]
      .sort((left, right) => right.count - left.count || left.subject.localeCompare(right.subject))
      .slice(0, 50),
    questions: auditedQuestions,
    warnings,
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function renderMetrics(label: string, metrics: PresenceMetrics): string[] {
  return [
    `## ${label} — ${metrics.questions} questions, ${metrics.evidenceItems} evidence`,
    `TranscriptPresenceRate: ${pct(metrics.transcriptPresenceRate)} (${metrics.transcriptPresent}/${metrics.evidenceItems})`,
    `NotePresenceRate: ${pct(metrics.notePresenceRate)} (${metrics.notePresent}/${metrics.transcriptPresent})`,
    `GraphPresenceRate: ${pct(metrics.graphPresenceRate)} (${metrics.graphPresent}/${metrics.notePresent})`,
    `Set-completeness (all siblings present) — notes: ${pct(metrics.noteCompleteRate)} (${metrics.noteCompleteQuestions}/${metrics.questions}), graph: ${pct(metrics.graphCompleteRate)} (${metrics.graphCompleteQuestions}/${metrics.questions})`,
  ];
}

export function renderLocomoEnumPresenceAudit(result: AuditResult): string {
  const lines = [
    '# LoCoMo Enumeration Presence Audit',
    '',
    `Conversations: ${result.conversations}`,
    '',
    ...renderMetrics('Overall', result.overall),
  ];
  for (const summary of result.byCategory) {
    lines.push('', ...renderMetrics(`cat${summary.category}`, summary));
  }
  lines.push(
    '',
    `Pronoun graph triple hits: ${result.pronounTripleHits}`,
    '',
    'Top graph surface strings:',
    ...result.graphSurfaceStrings.slice(0, 20).map(item =>
      `- ${item.count}x ${item.subject} --${item.relation}--> ${item.object}`,
    ),
  );
  if (result.warnings.length > 0) {
    lines.push('', 'Warnings:', ...result.warnings.map(warning => `- ${warning}`));
  }
  return lines.join('\n');
}

export async function runCli(input: string[]): Promise<number> {
  try {
    const options = parseArgs(input);
    const result = await runLocomoEnumPresenceAudit(options);
    console.log(
      options.json
        ? JSON.stringify(result, null, 2)
        : renderLocomoEnumPresenceAudit(result),
    );
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`locomo-enum-presence-audit fatal:\n${detail}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runCli(process.argv.slice(2));
}
