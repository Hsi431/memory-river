#!/usr/bin/env node

/**
 * locomo-cat1-waterfall — gold-atom first-failure waterfall for cat1 questions.
 *
 * For each gold atom in a cat1 question, determines the FIRST layer at which the
 * atom disappears from the pipeline:
 *
 *   L1 STORE: atom text appears in the restored store (raw transcript OR distilled
 *             note/memory row OR graph triple).
 *   L2 RECALL@K: `river.recall(question, K)` results contain the atom (K=50 gate;
 *                K=100 also recorded).
 *   L3 AUTORECALL delivered: atom appears in the injectedContext produced by
 *                assembleContext — deterministic autoRecall-only (LOWER BOUND; no
 *                agentic memory_recall/memory_rehydrate tool channels). This
 *                intentionally isolates the autoRecall/selection budget layer.
 *
 * Classification per atom (first failure):
 *   'store_missing'     — not in L1
 *   'retrieval_missing' — in L1, not in L2@50
 *   'selection_missing' — in L2@50, not in L3
 *   'delivered'         — in L3
 *
 * Requires: --snapshot-dir DIR --conversation conv-26
 * Does NOT require DeepSeek or Gemini.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { boundedIncludes } from '../dimensions/locomo-item-overlap.js';
import {
  findSnapshotPath,
  type GraphTripleRow,
  type MemoryRow,
  readJsonl,
  readLanceRows,
} from './locomo-provenance.js';
import { loadLocomo } from './locomo.js';
import { ollamaHealthy } from './real-embedder.js';
import { createRealMemoryRiver } from './real-river.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type WaterfallClass = 'store_missing' | 'retrieval_missing' | 'selection_missing' | 'delivered';

interface WaterfallOptions {
  snapshotDir: string;
  conversation: string;
  category: number;
  outJson?: string;
  outMarkdown?: string;
}

interface AtomWaterfallResult {
  atom: string;
  inStore: boolean;
  inRecall50: boolean;
  inRecall100: boolean;
  inAutoRecall: boolean;
  classification: WaterfallClass;
}

interface QuestionWaterfallResult {
  sampleId: string;
  questionIndex: number;
  category: number;
  question: string;
  atoms: AtomWaterfallResult[];
  atomsMeasured: number;
  classCounts: Record<WaterfallClass, number>;
  classPct: Record<WaterfallClass, number>;
  recall100AdditionalHits: number;
}

interface WaterfallResult {
  metricLabel: string;
  description: string;
  assumptions: string[];
  metrics: {
    conversation: string;
    category: number;
    questions: number;
    atomsMeasured: number;
    classCounts: Record<WaterfallClass, number>;
    classPct: Record<WaterfallClass, number>;
    recall100AdditionalHits: number;
    waterfallHint: string;
  };
  questions: QuestionWaterfallResult[];
  warnings: string[];
}

// ── Atom normalisation (same as locomo-delivered-context.ts) ──────────────────

function normalizeAtomText(input: string): string {
  return input.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function isExcludedAtom(atom: string): boolean {
  return atom.length <= 3 || /^\d+$/.test(atom);
}

// ── Gold items fixture ────────────────────────────────────────────────────────

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

function goldAtomsForQuestion(sampleId: string, questionIndex: number): string[] {
  const fixture = loadCat1GoldItems();
  return fixture.sampleId === sampleId ? fixture.items[String(questionIndex)] ?? [] : [];
}

// ── L1: store text assembly ───────────────────────────────────────────────────

async function buildStoreText(snapshotPath: string): Promise<string> {
  // Transcripts: walk the transcripts subdirectory and join all JSONL entries.
  const transcriptsDir = path.join(snapshotPath, 'data', 'transcripts');
  const transcriptTexts: string[] = [];
  if (fs.existsSync(transcriptsDir)) {
    const files = fs.readdirSync(transcriptsDir).filter(name => name.endsWith('.jsonl'));
    for (const file of files) {
      const entries = readJsonl(path.join(transcriptsDir, file));
      for (const entry of entries) {
        if (entry.user) transcriptTexts.push(entry.user);
        if (entry.assistant) transcriptTexts.push(entry.assistant);
      }
    }
  }

  // Memories (distilled notes): id, text from the memories LanceDB table.
  const memories = (await readLanceRows<MemoryRow>(
    snapshotPath,
    'memories',
    ['id', 'text', 'metadata', 'category', 'status'],
  )).filter(row => row.id !== 'init_00000000000000000000000000000000');
  const memoryTexts = memories.map(row => row.text).filter(Boolean);

  // Graph triples: subject, relation, object fields.
  const triples = (await readLanceRows<GraphTripleRow>(
    snapshotPath,
    'graph_triples',
    ['id', 'subject', 'relation', 'object', 'sourceMemoryId'],
  )).filter(row => !row.id.startsWith('init_'));
  const tripleTexts = triples.map(row => `${row.subject} ${row.relation} ${row.object}`);

  return [...transcriptTexts, ...memoryTexts, ...tripleTexts].join(' ');
}

// ── Pure classification function (unit-testable, no I/O) ─────────────────────

/**
 * Classify atoms into waterfall buckets given pre-assembled text layers.
 * Pure function — no I/O, no network. Suitable for unit testing.
 *
 * @param atoms     - raw gold atom strings (from fixture)
 * @param storeText - normalised text of the full restored store
 * @param recall50Text  - normalised concatenation of recall(@50) result texts
 * @param recall100Text - normalised concatenation of recall(@100) result texts
 * @param injectedText  - normalised text from assembleContext system messages
 */
export function classifyAtomWaterfall(input: {
  atoms: string[];
  storeText: string;
  recall50Text: string;
  recall100Text: string;
  injectedText: string;
}): AtomWaterfallResult[] {
  const results: AtomWaterfallResult[] = [];
  for (const atom of input.atoms) {
    const normalizedAtom = normalizeAtomText(atom);
    if (isExcludedAtom(normalizedAtom)) continue;

    const inStore = boundedIncludes(input.storeText, normalizedAtom);
    const inRecall50 = boundedIncludes(input.recall50Text, normalizedAtom);
    const inRecall100 = boundedIncludes(input.recall100Text, normalizedAtom);
    const inAutoRecall = boundedIncludes(input.injectedText, normalizedAtom);

    let classification: WaterfallClass;
    if (!inStore) {
      classification = 'store_missing';
    } else if (!inRecall50) {
      classification = 'retrieval_missing';
    } else if (!inAutoRecall) {
      classification = 'selection_missing';
    } else {
      classification = 'delivered';
    }

    results.push({ atom, inStore, inRecall50, inRecall100, inAutoRecall, classification });
  }
  return results;
}

// ── Aggregation helpers ───────────────────────────────────────────────────────

function zeroCounts(): Record<WaterfallClass, number> {
  return { store_missing: 0, retrieval_missing: 0, selection_missing: 0, delivered: 0 };
}

function addCounts(
  target: Record<WaterfallClass, number>,
  source: Record<WaterfallClass, number>,
): void {
  for (const key of Object.keys(source) as WaterfallClass[]) {
    target[key] += source[key];
  }
}

function toPct(counts: Record<WaterfallClass, number>): Record<WaterfallClass, number> {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (total === 0) return { store_missing: 0, retrieval_missing: 0, selection_missing: 0, delivered: 0 };
  const result = {} as Record<WaterfallClass, number>;
  for (const key of Object.keys(counts) as WaterfallClass[]) {
    result[key] = counts[key] / total;
  }
  return result;
}

function countAtoms(atoms: AtomWaterfallResult[]): Record<WaterfallClass, number> {
  const counts = zeroCounts();
  for (const atom of atoms) {
    counts[atom.classification]++;
  }
  return counts;
}

function waterfallHintFor(counts: Record<WaterfallClass, number>): string {
  const classes: WaterfallClass[] = ['store_missing', 'retrieval_missing', 'selection_missing', 'delivered'];
  let dominant = classes[0];
  for (const cls of classes) {
    if (counts[cls] > counts[dominant]) dominant = cls;
  }
  return `${dominant} dominates`;
}

// ── CLI argument parsing ──────────────────────────────────────────────────────

function usage(): void {
  console.error(
    'Usage: mr-bench locomo-cat1-waterfall --snapshot-dir DIR ' +
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

function parseArgs(args: string[]): WaterfallOptions {
  const options: Partial<WaterfallOptions> = { conversation: 'conv-26', category: 1 };
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
  return options as WaterfallOptions;
}

// ── Main run function ─────────────────────────────────────────────────────────

export async function runLocomoCat1Waterfall(
  options: WaterfallOptions,
): Promise<WaterfallResult> {
  if (!(await ollamaHealthy())) {
    throw new Error(
      'Ollama is not reachable or the embedding model is not pulled. ' +
      'Start Ollama and pull the model before running this harness.',
    );
  }

  const conversation = loadLocomo().find(item => item.sampleId === options.conversation);
  if (!conversation) throw new Error(`conversation not found: ${options.conversation}`);
  const snapshotPath = findSnapshotPath(options.snapshotDir, conversation);
  if (!snapshotPath) {
    throw new Error(
      `${conversation.sampleId}: no restored snapshot found in ${options.snapshotDir}`,
    );
  }

  const real = await createRealMemoryRiver(undefined, snapshotPath);
  const warnings: string[] = [];

  try {
    // L1: assemble the full store text once (shared across questions).
    const storeTextRaw = await buildStoreText(snapshotPath);
    const storeText = normalizeAtomText(storeTextRaw);

    const targets = conversation.qa
      .map((qa, questionIndex) => ({ qa, questionIndex }))
      .filter(({ qa }) => qa.category === options.category);

    if (targets.length === 0) {
      warnings.push(`No cat${options.category} questions found in ${conversation.sampleId}`);
    }

    const questionResults: QuestionWaterfallResult[] = [];
    let anyRecallNonEmpty = false;

    for (const { qa, questionIndex } of targets) {
      const atoms = goldAtomsForQuestion(conversation.sampleId, questionIndex);
      if (atoms.length === 0) {
        warnings.push(
          `${conversation.sampleId} q${questionIndex}: no gold atoms in fixture — skipping`,
        );
        continue;
      }

      // L2: call river.recall() for K=50 and K=100.
      // `recall` is the primary semantic search entry point on MemoryRiver,
      // mirroring what the engine uses for autoRecall (same vector path).
      const recall50Results = await real.river.recall(qa.question, 50);
      const recall100Results = await real.river.recall(qa.question, 100);

      if (recall50Results.length > 0 || recall100Results.length > 0) {
        anyRecallNonEmpty = true;
      }

      // Extract text from MemorySearchResult[].
      // MemorySearchResult.entry is a MemoryEntry; MemoryEntry.text is the memory text.
      // This matches how otter.ts reads it: result.entry.text (see otter.ts ~line 373).
      const recall50Text = normalizeAtomText(
        recall50Results
          .map(r => r.entry.text)
          .filter(t => t && t !== '_SYSTEM_INIT_')
          .join(' '),
      );
      const recall100Text = normalizeAtomText(
        recall100Results
          .map(r => r.entry.text)
          .filter(t => t && t !== '_SYSTEM_INIT_')
          .join(' '),
      );

      // L3: assembleContext — deterministic autoRecall only.
      // Mirrors exactly the assembleContext call in otter.ts runOtter():
      //   const assembled = await (river as any).assembleContext(
      //     [{ role: 'user', content: input.question }],
      //     undefined,
      //     { onAutoRecallResults() {} },
      //   );
      // NOTE: L3 here is deterministic autoRecall ONLY (no agentic memory_recall/
      // memory_rehydrate tool channels), so it is a LOWER BOUND on what the full
      // agentic answerer delivers. This is intentional — it isolates the
      // autoRecall/selection budget layer.
      const assembled = await (real.river as any).assembleContext(
        [{ role: 'user', content: qa.question }],
        undefined,
        { onAutoRecallResults() {} },
      );
      const injectedContext = (assembled.messages as Array<{ role: string; content: unknown }>)
        .filter(message => message.role === 'system')
        .map(message => {
          const content = message.content;
          if (typeof content === 'string') return content;
          if (Array.isArray(content)) {
            return (content as Array<{ type?: string; text?: string }>)
              .filter(part => part.type === undefined || part.type === 'text')
              .map(part => part.text ?? '')
              .filter(Boolean)
              .join('\n');
          }
          return '';
        })
        .filter(Boolean)
        .join('\n\n');
      const injectedText = normalizeAtomText(injectedContext);

      const atomResults = classifyAtomWaterfall({
        atoms,
        storeText,
        recall50Text,
        recall100Text,
        injectedText,
      });

      if (atomResults.length === 0) {
        warnings.push(
          `${conversation.sampleId} q${questionIndex}: all atoms were excluded (short/numeric)`,
        );
      }

      const classCounts = countAtoms(atomResults);

      // recall100AdditionalHits: atoms that appear in recall@100 but NOT in recall@50.
      const recall100AdditionalHits = atomResults.filter(
        a => a.inRecall100 && !a.inRecall50,
      ).length;

      questionResults.push({
        sampleId: conversation.sampleId,
        questionIndex,
        category: qa.category,
        question: qa.question,
        atoms: atomResults,
        atomsMeasured: atomResults.length,
        classCounts,
        classPct: toPct(classCounts),
        recall100AdditionalHits,
      });
    }

    if (targets.length > 0 && !anyRecallNonEmpty) {
      warnings.push(
        'SANITY: recall() returned 0 results for ALL questions — embedder or store may be empty',
      );
    }

    // Aggregate across all questions.
    const overallCounts = zeroCounts();
    let totalAtomsMeasured = 0;
    let totalRecall100AdditionalHits = 0;
    for (const q of questionResults) {
      addCounts(overallCounts, q.classCounts);
      totalAtomsMeasured += q.atomsMeasured;
      totalRecall100AdditionalHits += q.recall100AdditionalHits;
    }

    return {
      metricLabel: 'Cat1AtomWaterfall(first_failure_layer)',
      description:
        'Read-only diagnostic: for each cat1 gold atom, finds the first pipeline layer ' +
        'at which the atom is absent (store → recall@50 → autoRecall injected context). ' +
        'No DeepSeek or Gemini required. L3 is autoRecall-only (lower bound).',
      assumptions: [
        'L1 store text = raw transcript JSONL entries + memories table text + graph triple subject/relation/object, ' +
        'all concatenated and normalised with normalizeAtomText.',
        'L2 uses river.recall() (semantic vector search), K=50 gate, K=100 also recorded.',
        'L3 uses assembleContext with onAutoRecallResults:{} — deterministic autoRecall only, ' +
        'not the full agentic tool path (memory_recall / memory_rehydrate are not invoked). ' +
        'This is a LOWER BOUND on what the full agentic answerer delivers.',
        'Atom matching uses boundedIncludes + normalizeAtomText from locomo-item-overlap, ' +
        'identical to locomo-delivered-context. Atoms with length ≤ 3 or purely numeric are excluded.',
      ],
      metrics: {
        conversation: conversation.sampleId,
        category: options.category,
        questions: questionResults.length,
        atomsMeasured: totalAtomsMeasured,
        classCounts: overallCounts,
        classPct: toPct(overallCounts),
        recall100AdditionalHits: totalRecall100AdditionalHits,
        waterfallHint: waterfallHintFor(overallCounts),
      },
      questions: questionResults,
      warnings,
    };
  } finally {
    await real.cleanup();
  }
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function renderLocomoCat1Waterfall(result: WaterfallResult): string {
  const { metrics } = result;
  const lines = [
    '# LoCoMo cat1 Atom Waterfall',
    '',
    `${result.metricLabel} — ${metrics.questions} questions, ${metrics.atomsMeasured} atoms measured`,
    result.description,
    '',
    `Conversation: ${metrics.conversation}  Category: ${metrics.category}`,
    '',
    '## Overall class distribution',
    `store_missing:     ${metrics.classCounts.store_missing} (${pct(metrics.classPct.store_missing)})`,
    `retrieval_missing: ${metrics.classCounts.retrieval_missing} (${pct(metrics.classPct.retrieval_missing)})`,
    `selection_missing: ${metrics.classCounts.selection_missing} (${pct(metrics.classPct.selection_missing)})`,
    `delivered:         ${metrics.classCounts.delivered} (${pct(metrics.classPct.delivered)})`,
    `recall@100 additional hits (in @100 not @50): ${metrics.recall100AdditionalHits}`,
    `Waterfall hint: ${metrics.waterfallHint}`,
    '',
    '## Per-question',
    '| q | atoms | store_missing | retrieval_missing | selection_missing | delivered | @100_extra |',
    '|---:|---:|---:|---:|---:|---:|---:|',
    ...result.questions.map(q =>
      `| ${q.questionIndex} | ${q.atomsMeasured} | ` +
      `${q.classCounts.store_missing} | ` +
      `${q.classCounts.retrieval_missing} | ` +
      `${q.classCounts.selection_missing} | ` +
      `${q.classCounts.delivered} | ` +
      `${q.recall100AdditionalHits} |`,
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

// ── CLI entry point ───────────────────────────────────────────────────────────

export async function runCli(input: string[]): Promise<number> {
  try {
    const options = parseArgs(input);
    const result = await runLocomoCat1Waterfall(options);
    const markdown = renderLocomoCat1Waterfall(result);
    const json = JSON.stringify(result, null, 2);
    if (options.outMarkdown) fs.writeFileSync(options.outMarkdown, `${markdown}\n`, 'utf8');
    if (options.outJson) fs.writeFileSync(options.outJson, `${json}\n`, 'utf8');
    console.log(markdown);
    if (!options.outJson) console.log(`\n${json}`);
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`locomo-cat1-waterfall fatal:\n${detail}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runCli(process.argv.slice(2));
}
