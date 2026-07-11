#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as lancedb from '@lancedb/lancedb';

const TABLE_NAME = 'subsystem_effectiveness';
const DEFAULT_DB_PATH = path.join(process.env.HOME ?? '/root', '.openclaw/memory/lancedb-v6-qwen');
const DAY_MS = 86_400_000;
const PLACEHOLDERS = [
  ['gwm', 'GWM', 'PR-E5'],
  ['causal_chain', 'Causal Chain', 'PR-E6'],
  ['skill_capsule', 'Skill Capsule', 'PR-E3'],
];

function parseArgs(argv) {
  const args = {
    days: 7,
    subsystem: null,
    verbose: false,
    json: false,
    since: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--verbose') {
      args.verbose = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--days') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) throw new Error('--days must be a positive number');
      args.days = value;
    } else if (arg === '--subsystem') {
      const value = argv[++i];
      if (!value) throw new Error('--subsystem requires a value');
      args.subsystem = value;
    } else if (arg === '--since') {
      const value = argv[++i];
      if (!value || Number.isNaN(Date.parse(value))) throw new Error('--since must be an ISO timestamp');
      args.since = new Date(value).toISOString();
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/inspect-effectiveness.mjs [options]

Reads subsystem_effectiveness from ~/.openclaw/memory/lancedb-v6-qwen.

Options:
  --days N         Inspect last N days (default: 7)
  --subsystem X    Inspect one subsystem
  --verbose        Print per-event detail
  --json           Print machine-readable JSON
  --since ISO_TS   Override --days with an exact lower bound`);
}

function sqlStringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function parseMetadata(value) {
  if (!value) return {};
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return {};
  }
}

function redact(text) {
  return String(text ?? '')
    .replace(/ghp_[A-Za-z0-9_]+/g, 'ghp_[REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL_REDACTED]')
    .replace(/(password|密碼|登入資訊)([^，。,\n]*)/gi, '$1[REDACTED]')
    .replace(/token=[A-Za-z0-9_-]+/gi, 'token=[REDACTED]');
}

function pct(numerator, denominator) {
  if (!denominator) return '0.0%';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function percentValue(numerator, denominator) {
  return denominator ? (numerator / denominator) * 100 : 0;
}

function inc(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function topEntries(map, n = 5) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function normalizeRows(rows) {
  return rows.map(row => ({
    id: String(row.id ?? ''),
    ts: String(row.ts ?? ''),
    subsystem: String(row.subsystem ?? ''),
    event: String(row.event ?? ''),
    entityId: String(row.entityId ?? ''),
    relatedId: String(row.relatedId ?? ''),
    sessionKey: String(row.sessionKey ?? ''),
    sessionId: String(row.sessionId ?? ''),
    queryHash: String(row.queryHash ?? ''),
    outcome: String(row.outcome ?? ''),
    count: Number(row.count) || 0,
    score: Number(row.score) || 0,
    durationMs: Number(row.durationMs) || 0,
    metadata: String(row.metadata ?? ''),
    metadataObj: parseMetadata(row.metadata),
  }));
}

async function readRows(dbPath, args, sinceIso) {
  let db;
  try {
    db = await lancedb.connect(dbPath);
  } catch (err) {
    throw new Error(`failed to connect DB ${dbPath}: ${err?.message ?? err}`);
  }

  const tableNames = await db.tableNames();
  if (!tableNames.includes(TABLE_NAME)) {
    return { rows: [], missingTable: true };
  }

  const conditions = [`ts >= ${sqlStringLiteral(sinceIso)}`];
  if (args.subsystem) conditions.push(`subsystem = ${sqlStringLiteral(args.subsystem)}`);

  const table = await db.openTable(TABLE_NAME);
  const rows = await table.query().where(conditions.join(' AND ')).limit(100_000).toArray();
  return { rows: normalizeRows(rows), missingTable: false };
}

function buildSummary(rows, dbPath, args, sinceIso, untilIso, missingTable) {
  const bySubsystem = {};
  for (const row of rows) bySubsystem[row.subsystem] = (bySubsystem[row.subsystem] ?? 0) + 1;
  return {
    title: args.since ? `since ${sinceIso}` : `last ${args.days} days`,
    totalEvents: rows.length,
    bySubsystem,
    dbPath,
    range: {
      since: sinceIso,
      until: untilIso,
    },
    missingTable,
  };
}

function analyzeHooks(rows) {
  const hookRows = rows.filter(row => row.subsystem === 'hooks');
  const triggered = hookRows.filter(row => row.event === 'hook_triggered');
  const retainedRows = hookRows.filter(row => row.event === 'hook_crag_retained');
  const promptIncluded = hookRows.filter(row => row.event === 'hook_prompt_included');
  const retained = retainedRows.filter(row => row.outcome === 'retained');
  const dropped = retainedRows.filter(row => row.outcome === 'dropped');
  const uniqueTriggeredQueries = new Set(triggered.map(row => row.queryHash).filter(Boolean));
  const uniqueTriggeredMemories = new Set(triggered.map(row => row.entityId).filter(Boolean));
  const keywordCounts = new Map();
  const memoryCounts = new Map();

  for (const row of triggered) {
    const keyword = row.metadataObj?.keyword;
    if (keyword) inc(keywordCounts, redact(keyword));
  }
  for (const row of promptIncluded) {
    if (row.entityId) inc(memoryCounts, row.entityId.slice(0, 8));
  }

  const cragRetention = percentValue(retained.length, retainedRows.length);
  const retainedToIncluded = percentValue(promptIncluded.length, retained.length);
  const endToEnd = percentValue(promptIncluded.length, triggered.length);
  let verdict = '✅ healthy: hooks have measurable end-to-end inclusion';
  if (triggered.length === 0) verdict = '❌ silent: no hook triggered';
  else if (endToEnd < 30) verdict = '⚠️ low_inclusion: hook prompt inclusion below 30%';
  else if (cragRetention < 50) verdict = '⚠️ low_crag_retention: hook CRAG retention below 50%';

  return {
    eventCount: hookRows.length,
    triggered: {
      count: triggered.length,
      uniqueQueries: uniqueTriggeredQueries.size,
      uniqueMemories: uniqueTriggeredMemories.size,
    },
    cragRetained: {
      retained: retained.length,
      dropped: dropped.length,
      total: retainedRows.length,
      retainedPct: cragRetention,
      droppedPct: percentValue(dropped.length, retainedRows.length),
    },
    promptIncluded: promptIncluded.length,
    rates: {
      triggerToCragRetained: cragRetention,
      cragRetainedToPromptIncluded: retainedToIncluded,
      triggerToPromptIncluded: endToEnd,
    },
    topTriggeredKeywords: topEntries(keywordCounts),
    topRecallMemories: topEntries(memoryCounts),
    verdict,
    rows: hookRows,
  };
}

function analyzeConflict(rows) {
  const conflictRows = rows.filter(row => row.subsystem === 'conflict');
  const attempted = conflictRows.filter(row => row.event === 'conflict_detect_attempted');
  const candidates = conflictRows.filter(row => row.event === 'conflict_candidates_found');
  const judged = conflictRows.filter(row => row.event === 'conflict_llm_judged');
  const resolved = conflictRows.filter(row => row.event === 'conflict_resolution_fired');
  const attemptedByOutcome = countByOutcome(attempted);
  const candidatesByOutcome = countByOutcome(candidates);
  const judgedByOutcome = countByOutcome(judged);
  const resolvedByOutcome = countByOutcome(resolved);
  const entered = attemptedByOutcome.entered ?? 0;
  const hasCandidates = candidatesByOutcome.has_candidates ?? 0;
  const conflictFound = judgedByOutcome.conflict_found ?? 0;
  const llmFailed = judgedByOutcome.llm_failed ?? 0;
  const candidateCounts = candidates
    .filter(row => row.outcome === 'has_candidates')
    .map(row => row.count);
  const avgCandidateCount = candidateCounts.length
    ? candidateCounts.reduce((sum, value) => sum + value, 0) / candidateCounts.length
    : 0;
  const llmFailedRate = percentValue(llmFailed, judged.length);

  let verdict = '✅ healthy: full funnel firing, no LLM failure spike';
  if (attempted.length === 0) verdict = '❌ detector_dead: no conflict detect attempts';
  else if (entered === 0) verdict = '⚠️ all_category_skipped: all attempts skipped by category';
  else if (hasCandidates === 0) verdict = '⚠️ no_candidates_only: entered but never finds candidates';
  else if (llmFailedRate > 20) verdict = '⚠️ llm_failed_high: more than 20% LLM failures';

  return {
    eventCount: conflictRows.length,
    attempted: attemptedByOutcome,
    candidates: {
      ...candidatesByOutcome,
      avgCount: avgCandidateCount,
    },
    judged: judgedByOutcome,
    resolved: resolvedByOutcome,
    funnel: {
      entered,
      hasCandidates,
      hasCandidatesPctOfEntered: percentValue(hasCandidates, entered),
      conflictFound,
      conflictFoundPctOfEntered: percentValue(conflictFound, entered),
      conflictFoundPctOfCandidates: percentValue(conflictFound, hasCandidates),
      resolvedOk: resolvedByOutcome.ok ?? 0,
    },
    verdict,
    rows: conflictRows,
  };
}

export function analyzePluginInit(rows, nowMs = Date.now()) {
  const initRows = rows
    .filter(row => row.subsystem === 'plugin' && row.event === 'init_completed')
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const last = initRows[initRows.length - 1] ?? null;
  let verdict = '⚠️ no_init_record (old deployment may not have restarted)';

  if (last) {
    const lastTs = Date.parse(last.ts);
    if (last.outcome === 'failed') {
      verdict = '❌ init_failed';
    } else if (last.outcome === 'succeeded' && Number.isFinite(lastTs) && nowMs - lastTs < DAY_MS) {
      verdict = '✅ healthy';
    } else if (last.outcome === 'succeeded') {
      verdict = '⚠️ stale_init_record';
    }
  }

  return {
    eventCount: initRows.length,
    last,
    verdict,
    rows: initRows,
  };
}

function countByOutcome(rows) {
  const counts = {};
  for (const row of rows) counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
  return counts;
}

function buildReport(rows, args, dbPath, sinceIso, untilIso, missingTable) {
  const summary = buildSummary(rows, dbPath, args, sinceIso, untilIso, missingTable);
  return {
    summary,
    pluginInit: analyzePluginInit(rows),
    hooks: analyzeHooks(rows),
    conflict: analyzeConflict(rows),
    placeholders: PLACEHOLDERS.map(([subsystem, title, pr]) => ({
      subsystem,
      title,
      eventCount: rows.filter(row => row.subsystem === subsystem).length,
      pending: pr,
    })),
  };
}

function printSummary(report) {
  const { summary } = report;
  console.log(`=== Subsystem Effectiveness (${summary.title}) ===`);
  console.log(`Total events: ${summary.totalEvents}`);
  if (summary.missingTable) {
    console.log(`Table "${TABLE_NAME}" not found; no events yet.`);
  }
  console.log('By subsystem:');
  const entries = Object.entries(summary.bySubsystem).sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) {
    console.log('  (no events yet)');
  } else {
    for (const [subsystem, count] of entries) {
      console.log(`  ${subsystem.padEnd(12)} ${String(count).padStart(6)} events`);
    }
  }
  console.log(`DB: ${summary.dbPath}`);
  console.log(`Range: ${summary.range.since.slice(0, 10)} ~ ${summary.range.until.slice(0, 10)}`);
  console.log('');
}

function printPluginInit(pluginInit, verbose) {
  console.log('--- Plugin Init ---');
  if (!pluginInit.last) {
    console.log('(no init_completed event recorded yet)');
    console.log('');
    console.log(`Verdict:\n  ${pluginInit.verdict}`);
    console.log('');
    return;
  }

  console.log(`last init_completed: ${pluginInit.last.ts}`);
  console.log(`outcome:             ${pluginInit.last.outcome}`);
  if (pluginInit.last.metadata) {
    console.log(`metadata:            ${pluginInit.last.metadata}`);
  }
  console.log('');
  console.log(`Verdict:\n  ${pluginInit.verdict}`);
  if (verbose) printRows(pluginInit.rows);
  console.log('');
}

function printHooks(hooks, verbose) {
  console.log('--- Hooks Funnel ---');
  if (hooks.eventCount === 0) {
    console.log('(no events recorded yet)');
    console.log('');
    console.log(`Verdict:\n  ${hooks.verdict}`);
    console.log('');
    return;
  }

  console.log(`hook_triggered:        ${hooks.triggered.count} events  (unique queries: ${hooks.triggered.uniqueQueries}, unique memories: ${hooks.triggered.uniqueMemories})`);
  console.log('hook_crag_retained:');
  console.log(`  retained:            ${hooks.cragRetained.retained} (${hooks.cragRetained.retainedPct.toFixed(1)}%)`);
  console.log(`  dropped:             ${hooks.cragRetained.dropped} (${hooks.cragRetained.droppedPct.toFixed(1)}%)`);
  console.log(`hook_prompt_included:  ${hooks.promptIncluded} events`);
  console.log('');
  console.log(`Trigger → CRAG retained: ${hooks.rates.triggerToCragRetained.toFixed(1)}%`);
  console.log(`CRAG retained → Prompt included: ${hooks.rates.cragRetainedToPromptIncluded.toFixed(1)}%`);
  console.log(`Trigger → Prompt included (end-to-end): ${hooks.rates.triggerToPromptIncluded.toFixed(1)}%`);
  console.log('');
  printTop('Top triggered keywords (top 5):', hooks.topTriggeredKeywords);
  printTop('Top recall memories (top 5):', hooks.topRecallMemories);
  console.log('');
  console.log(`Verdict:\n  ${hooks.verdict}`);
  if (verbose) printRows(hooks.rows);
  console.log('');
}

function printConflict(conflict, verbose) {
  console.log('--- Conflict Funnel ---');
  if (conflict.eventCount === 0) {
    console.log('(no events recorded yet)');
    console.log('');
    console.log(`Verdict:\n  ${conflict.verdict}`);
    console.log('');
    return;
  }

  console.log('conflict_detect_attempted:');
  console.log(`  entered:            ${conflict.attempted.entered ?? 0}`);
  console.log(`  category_skipped:   ${conflict.attempted.category_skipped ?? 0}`);
  console.log('conflict_candidates_found:');
  console.log(`  no_candidates:      ${conflict.candidates.no_candidates ?? 0}`);
  console.log(`  has_candidates:     ${conflict.candidates.has_candidates ?? 0}  (avg count: ${conflict.candidates.avgCount.toFixed(1)})`);
  console.log('conflict_llm_judged:');
  console.log(`  no_conflict:        ${conflict.judged.no_conflict ?? 0}`);
  console.log(`  conflict_found:     ${conflict.judged.conflict_found ?? 0}`);
  console.log(`  llm_failed:         ${conflict.judged.llm_failed ?? 0}`);
  console.log('conflict_resolution_fired:');
  console.log(`  ok:                 ${conflict.resolved.ok ?? 0}`);
  console.log(`  failed:             ${conflict.resolved.failed ?? 0}`);
  console.log('');
  console.log('Funnel:');
  console.log(`  Entered:            ${conflict.funnel.entered}`);
  console.log(`  Has candidates:     ${conflict.funnel.hasCandidates} (${conflict.funnel.hasCandidatesPctOfEntered.toFixed(1)}%)`);
  console.log(`  Conflict found:     ${conflict.funnel.conflictFound} (${conflict.funnel.conflictFoundPctOfEntered.toFixed(1)}% of entered, ${conflict.funnel.conflictFoundPctOfCandidates.toFixed(1)}% of candidates)`);
  console.log(`  Resolved ok:        ${conflict.funnel.resolvedOk} oldIds`);
  console.log('');
  console.log(`Verdict:\n  ${conflict.verdict}`);
  if (verbose) printRows(conflict.rows);
  console.log('');
}

function printPlaceholders(report, args) {
  for (const item of report.placeholders) {
    if (args.subsystem && args.subsystem !== item.subsystem) continue;
    if (item.subsystem === 'gwm') console.log('--- GWM ---');
    else console.log(`--- ${item.title} ---`);
    if (item.eventCount === 0) {
      console.log(`(no events recorded yet — instrumentation pending ${item.pending})`);
    } else {
      console.log(`${item.eventCount} events recorded; detailed report pending ${item.pending}.`);
    }
    console.log('');
  }
}

function printTop(title, entries) {
  console.log(title);
  if (entries.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const entry of entries) {
    console.log(`  ${entry.key}: ${entry.count}`);
  }
}

function printRows(rows) {
  if (rows.length === 0) return;
  console.log('');
  console.log('Detail:');
  for (const row of rows) {
    const metadata = row.metadata ? ` metadata=${JSON.stringify(row.metadataObj)}` : '';
    console.log(`  - ts=${row.ts} subsystem=${row.subsystem} event=${row.event} outcome=${row.outcome} entityId=${row.entityId} relatedId=${row.relatedId} queryHash=${row.queryHash} count=${row.count} score=${row.score} durationMs=${row.durationMs}${metadata}`);
  }
}

function printReport(report, args) {
  printSummary(report);
  if (!args.subsystem || args.subsystem === 'plugin') printPluginInit(report.pluginInit, args.verbose);
  if (!args.subsystem || args.subsystem === 'hooks') printHooks(report.hooks, args.verbose);
  if (!args.subsystem || args.subsystem === 'conflict') printConflict(report.conflict, args.verbose);
  printPlaceholders(report, args);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = process.env.MEMORY_DB_PATH ?? DEFAULT_DB_PATH;
  const untilIso = new Date().toISOString();
  const sinceIso = args.since ?? new Date(Date.now() - args.days * DAY_MS).toISOString();
  const { rows, missingTable } = await readRows(dbPath, args, sinceIso);
  const report = buildReport(rows, args, dbPath, sinceIso, untilIso, missingTable);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report, args);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('[inspect-effectiveness] fatal:', err?.message ?? err);
    process.exit(1);
  });
}
