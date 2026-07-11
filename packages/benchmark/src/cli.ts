#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

import {
  dimensions,
  type BenchmarkOptions,
  type DimensionName,
} from './dimensions/index.js';
import { checkAnswerShape } from './harness/answer-shape-smoke.js';
import { runCli as runLocomoCat1WaterfallCli } from './harness/locomo-cat1-waterfall.js';
import { runCli as runLocomoDeliveredContextCli } from './harness/locomo-delivered-context.js';
import { runCli as runLocomoEnumNoiseAuditCli } from './harness/locomo-enum-noise-audit.js';
import { runCli as runLocomoEnumPresenceAuditCli } from './harness/locomo-enum-presence-audit.js';
import { runCli as runLocomoSiblingRecallCli } from './harness/locomo-sibling-recall.js';
import { deepseekApiKey } from './harness/provider-keys.js';
import {
  createReport,
  renderInstrumentationSummary,
  renderMarkdown,
  writeJsonReport,
  type BenchmarkResult,
} from './report.js';

function usage(): void {
  console.error(
    'Usage: mr-bench lifecycle|evidence|recovery|retrieval|crag|locomo|zh-chat|locomo-enum-presence-audit|locomo-enum-noise-audit|locomo-sibling-recall|locomo-delivered-context|locomo-cat1-waterfall|all ' +
    '[--out report.json] [--limit N] [--max-questions N] [--category N] [--sample N] [--seed N] [--judge-all] [--skip-preflight] [--snapshot-dir DIR] [--rebuild-snapshot]',
  );
}

// Dimensions that route through the answer model (otter agent + judge); these are
// the ones a dropped/truncated model answer would silently corrupt.
const ANSWER_MODEL_DIMENSIONS = new Set<DimensionName>(['locomo', 'zh-chat']);

function parsePositiveInteger(option: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${option} requires a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(option: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${option} requires a non-negative integer`);
  }
  return parsed;
}

function parseArgs(input: string[]): {
  command: DimensionName | 'all';
  out?: string;
  options: BenchmarkOptions;
  skipPreflight: boolean;
} {
  const args = [...input];
  const command = args.shift();
  if (!command || (command !== 'all' && !(command in dimensions))) {
    throw new Error(`unknown dimension: ${command ?? '(missing)'}`);
  }

  let out: string | undefined;
  let skipPreflight = false;
  const options: BenchmarkOptions = {};
  while (args.length > 0) {
    const option = args.shift();
    if (option === '--skip-preflight') {
      skipPreflight = true;
    } else if (option === '--out') {
      if (out) throw new Error('--out may only be specified once');
      out = args.shift();
      if (!out || out.startsWith('--')) throw new Error('--out requires a file path');
    } else if (option === '--limit') {
      options.limit = parsePositiveInteger(option, args.shift());
    } else if (option === '--max-questions') {
      options.maxQuestions = parsePositiveInteger(option, args.shift());
    } else if (option === '--category') {
      options.category = parsePositiveInteger(option, args.shift());
    } else if (option === '--sample') {
      options.sample = parsePositiveInteger(option, args.shift());
    } else if (option === '--seed') {
      options.seed = parseNonNegativeInteger(option, args.shift());
    } else if (option === '--judge-all') {
      options.judgeAll = true;
    } else if (option === '--snapshot-dir') {
      options.snapshotDir = args.shift();
      if (!options.snapshotDir || options.snapshotDir.startsWith('--')) {
        throw new Error('--snapshot-dir requires a directory path');
      }
    } else if (option === '--rebuild-snapshot') {
      options.rebuildSnapshot = true;
    } else {
      throw new Error(`unknown argument: ${option}`);
    }
  }
  return { command: command as DimensionName | 'all', out, options, skipPreflight };
}

/**
 * Pre-flight answer-shape gate: before any answer-model dimension runs, verify the
 * harness actually captures the configured model's output. Aborts the run if
 * answers would be empty/truncated (the failure that wasted 5.7h on pro). No-op
 * when no answer-model dimension is selected or DEEPSEEK_API_KEY is unset.
 */
async function preflightAnswerShape(names: DimensionName[]): Promise<void> {
  const needsAnswerModel = names.some(name => ANSWER_MODEL_DIMENSIONS.has(name));
  if (!needsAnswerModel || !deepseekApiKey()) return;
  const report = await checkAnswerShape();
  console.error(
    `[preflight] answer-shape ${report.model}: nonEmpty=${(report.nonEmptyRate * 100).toFixed(0)}% ` +
    `truncated=${report.truncatedCount} reasoningOnly=${report.reasoningOnlyCount}`,
  );
  if (!report.pass) {
    throw new Error(
      'answer-shape preflight FAILED — model answers would be dropped/truncated. ' +
      'Raise DEEPSEEK_MAX_TOKENS or fix the harness, then retry (or pass --skip-preflight to override).',
    );
  }
}

export async function runCli(input: string[]): Promise<number> {
  let out: string | undefined;
  const results: BenchmarkResult[] = [];
  let latestProgress: BenchmarkResult | undefined;
  try {
    if (input.includes('--help') || input.includes('-h')) {
      usage();
      return 0;
    }
    if (input[0] === 'locomo-enum-presence-audit') {
      return await runLocomoEnumPresenceAuditCli(input.slice(1));
    }
    if (input[0] === 'locomo-enum-noise-audit') {
      return await runLocomoEnumNoiseAuditCli(input.slice(1));
    }
    if (input[0] === 'locomo-sibling-recall') {
      return await runLocomoSiblingRecallCli(input.slice(1));
    }
    if (input[0] === 'locomo-delivered-context') {
      return await runLocomoDeliveredContextCli(input.slice(1));
    }
    if (input[0] === 'locomo-cat1-waterfall') {
      return await runLocomoCat1WaterfallCli(input.slice(1));
    }
    const parsed = parseArgs(input);
    const { command, options } = parsed;
    out = parsed.out;
    const names = command === 'all'
      ? Object.keys(dimensions) as DimensionName[]
      : [command];
    if (!parsed.skipPreflight) await preflightAnswerShape(names);
    if (out) writeJsonReport(out, createReport(results));
    for (const name of names) {
      const dimensionOptions: BenchmarkOptions = {
        ...options,
        onProgress(progress) {
          latestProgress = progress;
          if (!out) return;
          writeJsonReport(out, createReport([...results, progress]));
        },
      };
      results.push(await dimensions[name](dimensionOptions));
      latestProgress = undefined;
      if (out) writeJsonReport(out, createReport(results));
    }
    const report = createReport(results);
    console.log(renderMarkdown(report));
    const summary = renderInstrumentationSummary(report);
    if (summary) console.log(summary);
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`mr-bench fatal:\n${detail}`);
    if (out) {
      writeJsonReport(out, {
        ...createReport(latestProgress ? [...results, latestProgress] : results),
        fatalError: detail,
      });
    }
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runCli(process.argv.slice(2));
}
