import { openRequiredTable, parseMetadata, parseSince, sqlString, type SinceInfo } from './shared.js';
import { connectDb } from './shared.js';

const TABLE_NAME = 'subsystem_effectiveness';
const DEFAULT_LIMIT = 100_000;
const ATTRIBUTION_SUBSYSTEMS = new Set(['causal']);

const COLOR = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
};

export interface EffectivenessOptions {
  since: string;
  subsystem: string[] | null;
  raw: number;
  meta: boolean;
  metaKeys: string[] | null;
}

export interface EffectivenessRow {
  id: string;
  ts: string;
  subsystem: string;
  event: string;
  entityId: string;
  relatedId: string;
  sessionKey: string;
  sessionId: string;
  queryHash: string;
  outcome: string;
  count: number;
  score: number;
  durationMs: number;
  metadata: string;
  metadataObj: Record<string, unknown>;
}

export interface Health {
  severity: 'healthy' | 'warn' | 'critical';
  notes: string[];
}

export interface EffectivenessSubsystemSummary {
  name: string;
  rows: EffectivenessRow[];
  outcomes: Map<string, number>;
  methods: Map<string, number>;
  scores: number[];
  isAttribution: boolean;
  health: Health | null;
}

export interface EffectivenessSummary {
  window: SinceInfo;
  totalEvents: number;
  rows: EffectivenessRow[];
  subsystems: EffectivenessSubsystemSummary[];
}

function color(text: string, code: string): string {
  return process.stdout.isTTY ? `${code}${text}${COLOR.reset}` : text;
}

function buildWhere(args: EffectivenessOptions, sinceInfo: SinceInfo): string | null {
  const conditions: string[] = [];
  if (sinceInfo.sinceIso) conditions.push(`\`ts\` > ${sqlString(sinceInfo.sinceIso)}`);
  if (args.subsystem?.length === 1) {
    conditions.push(`\`subsystem\` = ${sqlString(args.subsystem[0])}`);
  } else if (args.subsystem && args.subsystem.length > 1) {
    conditions.push(`\`subsystem\` IN (${args.subsystem.map(sqlString).join(',')})`);
  }
  return conditions.length > 0 ? conditions.join(' AND ') : null;
}

function normalizeRows(rows: Record<string, unknown>[]): EffectivenessRow[] {
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
    count: Number(row.count ?? 0),
    score: Number(row.score ?? 0),
    durationMs: Number(row.durationMs ?? 0),
    metadata: typeof row.metadata === 'bigint' ? row.metadata.toString() : String(row.metadata ?? ''),
    metadataObj: parseMetadata(row.metadata),
  }));
}

async function readRows(
  dbPath: string,
  args: EffectivenessOptions,
  sinceInfo: SinceInfo,
): Promise<EffectivenessRow[]> {
  const db = await connectDb(dbPath);
  const table = await openRequiredTable(db, dbPath, TABLE_NAME);
  let query = table.query();
  const where = buildWhere(args, sinceInfo);
  if (where) query = query.where(where);
  return normalizeRows(await query.limit(DEFAULT_LIMIT).toArray() as Record<string, unknown>[]);
}

function groupBy(
  rows: EffectivenessRow[],
  keyFn: (row: EffectivenessRow) => string,
): Map<string, EffectivenessRow[]> {
  const groups = new Map<string, EffectivenessRow[]>();
  for (const row of rows) {
    const key = keyFn(row) || '(blank)';
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

function inc(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function pct(count: number, total: number): string {
  return total ? `${((count / total) * 100).toFixed(1)}%` : '0.0%';
}

function ratio(count: number, total: number): number {
  return total ? (count / total) * 100 : 0;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[index];
}

function fmtScore(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : '0.000';
}

function fmtTime(date: Date | null): string {
  if (!date) return 'beginning';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fmtOutcome(name: string, count: number, total: number): string {
  const text = `${name.padEnd(8)} ${String(count).padStart(4)} (${pct(count, total).padStart(6)})`;
  if (name === 'used') return color(text, COLOR.green);
  if (name === 'partial') return color(text, COLOR.yellow);
  if (name === 'unused') return color(text, COLOR.gray);
  if (name === 'skipped') return color(text, COLOR.dim);
  return text;
}

function severityIcon(severity: Health['severity']): string {
  if (severity === 'healthy') return color('✓', COLOR.green);
  if (severity === 'warn') return color('⚠', COLOR.yellow);
  return color('✗', COLOR.red);
}

function distanceFromRange(value: number, min: number, max: number): number {
  if (value < min) return min - value;
  if (value > max) return value - max;
  return 0;
}

function evaluateHealth(
  rows: EffectivenessRow[],
  outcomes: Map<string, number>,
  scores: number[],
): Health {
  const total = rows.length;
  const skipped = outcomes.get('skipped') ?? 0;
  const nonSkipped = total - skipped;
  const usedRatio = ratio(outcomes.get('used') ?? 0, nonSkipped);
  const partialRatio = ratio(outcomes.get('partial') ?? 0, nonSkipped);
  const unusedRatio = ratio(outcomes.get('unused') ?? 0, nonSkipped);
  const skippedRatio = ratio(skipped, total);
  const median = percentile(scores, 0.5);
  const notes: string[] = [];
  let severity: Health['severity'] = 'healthy';

  if (total < 5) {
    severity = 'critical';
    notes.push('sample size < 5');
  }

  const checks: Array<[string, number, number, number]> = [
    ['used', usedRatio, 15, 50],
    ['partial', partialRatio, 5, 20],
    ['unused', unusedRatio, 30, 70],
  ];
  const deviations = checks
    .map(([name, value, min, max]) => ({ name, value, distance: distanceFromRange(value, min, max) }))
    .filter(item => item.distance > 0);

  if (nonSkipped === 0 && total >= 5) {
    if (severity !== 'critical') severity = 'warn';
    notes.push('all events skipped');
  } else if (deviations.length === 0) {
    notes.push('outcome distribution healthy');
  } else {
    const severe = deviations.some(item => item.distance > 10);
    if (severe) severity = 'critical';
    else if (severity !== 'critical') severity = 'warn';
    notes.push(deviations.map(item => `${item.name} ${item.value.toFixed(1)}%`).join(', '));
  }

  if (median === 0 && total > 10) {
    severity = 'critical';
    notes.push('score median 0.000 with >10 events');
  }
  if (skippedRatio > 80 && severity !== 'critical') {
    severity = 'warn';
    notes.push(`skipped ratio ${skippedRatio.toFixed(1)}%`);
  }

  return { severity, notes };
}

function analyzeSubsystem(name: string, rows: EffectivenessRow[]): EffectivenessSubsystemSummary {
  const isAttribution = ATTRIBUTION_SUBSYSTEMS.has(name);
  const outcomes = new Map<string, number>();
  const methods = new Map<string, number>();
  const scores: number[] = [];
  for (const row of rows) {
    inc(outcomes, row.outcome || '(blank)');
    const method = row.metadataObj.method;
    if (method) inc(methods, String(method));
    if (Number.isFinite(row.score)) scores.push(row.score);
  }
  return {
    name,
    rows,
    outcomes,
    methods,
    scores,
    isAttribution,
    health: isAttribution ? evaluateHealth(rows, outcomes, scores) : null,
  };
}

export function summarizeEffectiveness(
  rows: EffectivenessRow[],
  args: EffectivenessOptions,
  sinceInfo: SinceInfo,
): EffectivenessSummary {
  const groups = groupBy(rows, row => row.subsystem);
  const subsystemNames = args.subsystem?.length ? args.subsystem : [...groups.keys()].sort();
  return {
    window: sinceInfo,
    totalEvents: rows.length,
    rows,
    subsystems: subsystemNames
      .map(name => analyzeSubsystem(name, groups.get(name) ?? []))
      .filter(summary => summary.rows.length > 0),
  };
}

export async function getEffectivenessSummary(
  dbPath: string,
  args: EffectivenessOptions,
): Promise<EffectivenessSummary> {
  const sinceInfo = parseSince(args.since);
  const rows = await readRows(dbPath, args, sinceInfo);
  return summarizeEffectiveness(rows, args, sinceInfo);
}

function printBar(): void {
  console.log('═'.repeat(59));
}

function printDashboard(
  dbPath: string,
  args: EffectivenessOptions,
  summary: EffectivenessSummary,
): void {
  const { rows, window: sinceInfo } = summary;
  printBar();
  console.log('Memory River Subsystem Effectiveness Dashboard');
  console.log(`DB: ${dbPath}`);
  console.log(`Window: ${sinceInfo.label}  (${fmtTime(sinceInfo.from)} → ${fmtTime(sinceInfo.to)})`);
  console.log(`Total events: ${rows.length}`);
  printBar();

  if (rows.length === 0) {
    if (args.subsystem?.length) {
      for (const subsystem of args.subsystem) {
        console.log(`▌ ${subsystem.padEnd(46)} no events in window`);
      }
    } else {
      console.log('no events in window');
    }
    return;
  }

  const summaries: EffectivenessSubsystemSummary[] = [];
  const summaryByName = new Map(summary.subsystems.map(item => [item.name, item]));
  const subsystemNames = args.subsystem?.length
    ? args.subsystem
    : summary.subsystems.map(item => item.name);

  for (const name of subsystemNames) {
    const subsystemSummary = summaryByName.get(name);
    if (!subsystemSummary) {
      console.log(`▌ ${name.padEnd(46)} no events in window`);
      continue;
    }
    summaries.push(subsystemSummary);
    const { rows: subsystemRows, outcomes, methods, scores, health, isAttribution } = subsystemSummary;
    const outcomeEntries = [...outcomes.entries()].sort((a, b) => {
      const order = ['used', 'partial', 'unused', 'skipped'];
      const ai = order.indexOf(a[0]);
      const bi = order.indexOf(b[0]);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return a[0].localeCompare(b[0]);
    });
    const methodEntries = [...methods.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const kind = isAttribution ? '[attribution]' : '[flow]';
    console.log(`▌ ${name.padEnd(46)} ${String(subsystemRows.length).padStart(6)} events  ${kind}`);
    console.log(`outcome:    ${outcomeEntries.map(([key, count]) => fmtOutcome(key, count, subsystemRows.length)).join('   ')}`);
    if (isAttribution && health) {
      console.log(`score:      min ${fmtScore(percentile(scores, 0))}  median ${fmtScore(percentile(scores, 0.5))}  p75 ${fmtScore(percentile(scores, 0.75))}  max ${fmtScore(percentile(scores, 1))}`);
      console.log(`method:     ${methodEntries.length ? methodEntries.map(([key, count]) => `${key} ${count}`).join('   ') : '(none)'}`);
      console.log(`${severityIcon(health.severity)} ${health.notes.join('; ')}`);
    } else {
      console.log('(flow events, no health rules applied)');
    }
  }

  printBar();
  console.log('Health flags');
  printBar();
  const attributionSummaries = summaries.filter(summary => summary.isAttribution);
  if (attributionSummaries.length === 0) console.log('(no attribution subsystems in window)');
  for (const summary of attributionSummaries) {
    if (summary.health) {
      console.log(`${severityIcon(summary.health.severity)} ${summary.name.padEnd(8)} ${summary.health.notes.join('; ')}`);
    }
  }
}

function rawSnippet(row: EffectivenessRow): string {
  const metadata = row.metadataObj;
  const snippet = metadata.outputSnippet
    ?? metadata.injectedSnippet
    ?? metadata.snippet
    ?? metadata.reason
    ?? '';
  return String(snippet).replace(/\s+/g, ' ').slice(0, 120);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function inlineValue(value: unknown): string {
  if (value === undefined || value === null) return '(none)';
  return JSON.stringify(value, jsonReplacer);
}

function printMetadata(row: EffectivenessRow, args: EffectivenessOptions): void {
  if (!args.meta) return;
  const metadata = row.metadataObj;
  const keys = Object.keys(metadata);
  if (keys.length === 0 && !args.metaKeys) {
    console.log('  metadata: (empty)');
    return;
  }
  if (args.metaKeys) {
    const fields = args.metaKeys.map(key => `${key}: ${inlineValue(metadata[key])}`);
    console.log(`  metadata: { ${fields.join(', ')} }`);
    return;
  }
  const json = JSON.stringify(metadata, jsonReplacer, 2);
  if (!json || json === '{}') {
    console.log('  metadata: (empty)');
    return;
  }
  const lines = json.split('\n');
  console.log(`  metadata: ${lines[0]}`);
  for (const line of lines.slice(1)) console.log(`  ${line}`);
}

function printRawWithMetadata(
  rows: EffectivenessRow[],
  limit: number,
  args: EffectivenessOptions,
): void {
  if (!limit) return;
  printBar();
  console.log(`Raw events (latest ${limit})`);
  printBar();
  const latest = [...rows]
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, limit);
  for (const row of latest) {
    const snippet = rawSnippet(row);
    console.log(`[${row.ts}] ${row.subsystem} ${row.outcome} score=${fmtScore(row.score)} len=${snippet.length} snippet="${snippet}"`);
    printMetadata(row, args);
  }
}

export async function runEffectiveness(dbPath: string, args: EffectivenessOptions): Promise<void> {
  const summary = await getEffectivenessSummary(dbPath, args);
  printDashboard(dbPath, args, summary);
  printRawWithMetadata(summary.rows, args.raw, args);
}
