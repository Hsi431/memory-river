import { connectDb, openRequiredTable, parseMetadata, parseSince } from './shared.js';

const TABLE_NAME = 'night_consolidation_stats';
const DEFAULT_LIMIT = 50_000;

export interface NightOptions {
  since: string;
}

export interface NightRow extends Record<string, unknown> {
  ts: number;
  phase: string;
  outcome?: string;
  runId?: string;
  durationMs?: number;
  scheduledFor?: number;
  candidateCount?: number;
  attemptedCount?: number;
  failedCount?: number;
  errorMessage?: string;
  metadata?: unknown;
  metadataObj: Record<string, unknown>;
}

export interface NightRun {
  runId: string;
  rows: NightRow[];
  firstTs: number;
  lastTs: number;
  verdict: { key: string; label: string };
  source: unknown;
}

function iso(ts: unknown): string {
  return Number.isFinite(Number(ts)) ? new Date(Number(ts)).toISOString() : 'n/a';
}

function seconds(ms: unknown): string {
  if (!Number.isFinite(Number(ms))) return '';
  return `${Math.round(Number(ms) / 1000)}s`;
}

function phaseHas(run: NightRun, phase: string, predicate: (row: NightRow) => boolean = () => true): boolean {
  return run.rows.some(row => row.phase === phase && predicate(row));
}

function getSource(run: NightRun): unknown {
  for (const row of run.rows) {
    if (row.metadataObj.source) return row.metadataObj.source;
  }
  return 'unknown';
}

function classify(run: NightRun, nowMs: number): { key: string; label: string } {
  const hasRunCompletedOk = phaseHas(run, 'run_completed', row => row.outcome === 'ok');
  const hasRecoveryTriggered = phaseHas(run, 'recovery_triggered');
  const hasZeroCandidates = phaseHas(run, 'zero_candidates', row => row.outcome === 'skipped');
  const hasRunStarted = phaseHas(run, 'run_started');
  const hasRunFailed = phaseHas(run, 'run_failed');
  const hasLlmFailed = phaseHas(run, 'llm_failed');
  const hasPartialWriteFail = phaseHas(run, 'execute_completed', row => Number(row.failedCount) > 0);
  const hasScheduleCreated = phaseHas(run, 'schedule_created');
  const hasTimerFired = phaseHas(run, 'timer_fired');
  const hasScheduledSkip = phaseHas(
    run,
    'recovery_skipped',
    row => row.metadataObj.source === 'scheduled_timer',
  );
  const futureSchedule = phaseHas(
    run,
    'schedule_created',
    row => Number(row.scheduledFor) > nowMs && !hasTimerFired,
  );
  const skippedRecentOnly = run.rows.length > 0
    && run.rows.every(row => row.phase === 'recovery_skipped' && row.metadataObj.reason === 'recent_run');
  const incomplete = hasRunStarted && !phaseHas(run, 'run_completed') && !hasRunFailed;

  if (hasRunFailed) return { key: 'run-failed', label: '❌ run-failed' };
  if (hasLlmFailed) return { key: 'llm-failed', label: '❌ llm-failed' };
  if (hasPartialWriteFail) return { key: 'partial-write-fail', label: '❌ partial-write-fail' };
  if (hasScheduleCreated && !hasTimerFired && !hasScheduledSkip && !futureSchedule) {
    return { key: 'timer-dead', label: '❌ timer-dead' };
  }
  if (incomplete) return { key: 'incomplete', label: '❓ incomplete' };
  if (futureSchedule) return { key: 'scheduled-pending', label: '✅ scheduled-pending' };
  if (hasRecoveryTriggered && hasRunCompletedOk) return { key: 'recovered', label: '⚠️ recovered' };
  if (hasRunCompletedOk) return { key: 'healthy', label: '✅ healthy' };
  if (skippedRecentOnly) return { key: 'skipped-recent', label: '✅ skipped-recent' };
  if (hasZeroCandidates) return { key: 'skipped-empty', label: '✅ skipped-empty' };
  return { key: 'incomplete', label: '❓ incomplete' };
}

function nullable(value: unknown): number | string {
  return value === null || value === undefined ? 'n/a' : Number(value);
}

function compactPhase(row: NightRow): string {
  if (row.phase === 'query_completed') {
    return `${row.phase}${row.outcome ? ` (${row.outcome}, cand=${nullable(row.candidateCount)})` : ''}`;
  }
  if (row.phase === 'execute_completed') {
    return `${row.phase} (${row.outcome ?? 'n/a'}, attempted=${nullable(row.attemptedCount)} fail=${nullable(row.failedCount)})`;
  }
  if (row.phase === 'recovery_skipped') {
    return `${row.phase} (${String(row.metadataObj.reason ?? 'unknown')})`;
  }
  if (row.phase === 'run_completed') {
    return `${row.phase} (${row.outcome ?? 'n/a'})`;
  }
  return row.outcome ? `${row.phase} (${row.outcome})` : row.phase;
}

function summarizeRun(run: NightRun): {
  started?: NightRow;
  completed?: NightRow;
  triggered?: NightRow;
  schedule?: NightRow;
  last?: NightRow;
} {
  return {
    started: run.rows.find(row => row.phase === 'run_started'),
    completed: run.rows.find(row => row.phase === 'run_completed'),
    triggered: run.rows.find(row => row.phase === 'recovery_triggered'),
    schedule: run.rows.find(row => row.phase === 'schedule_created'),
    last: run.rows[run.rows.length - 1],
  };
}

function printRun(run: NightRun, index: number): void {
  const verdict = run.verdict;
  const summary = summarizeRun(run);
  const duration = summary.completed?.durationMs ?? (
    summary.started && summary.completed ? Number(summary.completed.ts) - Number(summary.started.ts) : null
  );

  console.log(`[${index}] runId=${run.runId} source=${String(run.source)}`);
  if (summary.triggered) console.log(`    triggered:  ${iso(summary.triggered.ts)}`);
  if (summary.schedule) console.log(`    scheduled:  ${iso(summary.schedule.scheduledFor)} created=${iso(summary.schedule.ts)}`);
  if (summary.started) console.log(`    started:    ${iso(summary.started.ts)}`);
  if (summary.completed) console.log(`    completed:  ${iso(summary.completed.ts)}${duration !== null ? ` (${seconds(duration)})` : ''}`);
  if (!summary.completed && summary.last) console.log(`    last_phase: ${summary.last.phase} at ${iso(summary.last.ts)}`);
  console.log(`    verdict:    ${verdict.label}`);
  console.log(`    phases:     ${run.rows.map(compactPhase).join(' → ')}`);
  console.log('');
}

async function readRows(dbPath: string, sinceMs: number | null): Promise<Record<string, unknown>[]> {
  const db = await connectDb(dbPath);
  const table = await openRequiredTable(db, dbPath, TABLE_NAME);
  let query = table.query();
  if (sinceMs !== null) query = query.where(`\`ts\` > ${Math.floor(sinceMs)}`);
  return query.limit(DEFAULT_LIMIT).toArray() as Promise<Record<string, unknown>[]>;
}

function groupRows(rows: Record<string, unknown>[]): NightRun[] {
  const groups = new Map<string, NightRun>();
  for (const raw of rows) {
    const row = {
      ...raw,
      ts: Number(raw.ts),
      phase: String(raw.phase ?? ''),
      metadataObj: parseMetadata(raw.metadata),
    } as NightRow;
    const runId = row.runId || '<missing-runId>';
    const run = groups.get(runId) ?? {
      runId,
      rows: [],
      firstTs: 0,
      lastTs: 0,
      verdict: { key: '', label: '' },
      source: 'unknown',
    };
    run.rows.push(row);
    groups.set(runId, run);
  }

  const runs = [...groups.values()];
  for (const run of runs) {
    run.rows.sort((a, b) => a.ts - b.ts);
    run.firstTs = run.rows[0]?.ts || 0;
    run.lastTs = run.rows[run.rows.length - 1]?.ts || 0;
  }
  return runs.sort((a, b) => b.firstTs - a.firstTs);
}

export interface NightSummary {
  window: ReturnType<typeof parseSince>;
  totalRuns: number;
  verdicts: Record<string, number>;
  runs: NightRun[];
}

export function summarizeNight(
  rows: Record<string, unknown>[],
  since: ReturnType<typeof parseSince>,
  nowMs = Date.now(),
): NightSummary {
  const runs = groupRows(rows);
  const verdicts: Record<string, number> = {};
  for (const run of runs) {
    run.verdict = classify(run, nowMs);
    run.source = getSource(run);
    verdicts[run.verdict.label] = (verdicts[run.verdict.label] ?? 0) + 1;
  }
  return { window: since, totalRuns: runs.length, verdicts, runs };
}

export async function getNightSummary(dbPath: string, args: NightOptions): Promise<NightSummary> {
  const since = parseSince(args.since);
  return summarizeNight(await readRows(dbPath, since.sinceMs), since);
}

function printSummary(summary: NightSummary, dbPath: string): void {
  const { runs, window: since, verdicts } = summary;

  console.log('NightConsolidator Stats Inspection');
  console.log(`DB: ${dbPath}`);
  console.log(`Window: ${since.label} (${since.from?.toISOString().slice(0, 10) ?? 'beginning'} ~ ${since.to.toISOString().slice(0, 10)})`);
  console.log('');
  console.log(`Total runs: ${runs.length}`);
  if (runs.length === 0) {
    console.log('No runs in window');
    return;
  }
  console.log('By verdict:');
  for (const [label, count] of Object.entries(verdicts).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${label}: ${count}`);
  }
  console.log('');
  console.log('Run details (newest first):');
  console.log('');
}

export async function runNight(dbPath: string, args: NightOptions): Promise<void> {
  const summary = await getNightSummary(dbPath, args);
  printSummary(summary, dbPath);
  summary.runs.forEach((run, index) => printRun(run, index + 1));
}
