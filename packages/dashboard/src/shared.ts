import * as lancedb from '@lancedb/lancedb';

export interface SinceInfo {
  label: string;
  sinceIso: string | null;
  sinceMs: number | null;
  from: Date | null;
  to: Date;
}

export function parseSince(value: string, now = new Date()): SinceInfo {
  if (value === 'all') {
    return { label: 'all time', sinceIso: null, sinceMs: null, from: null, to: now };
  }
  const match = /^(\d+)([hdm])$/.exec(value);
  if (!match) throw new Error('--since must be Nh, Nd, Nm, or all');
  const amount = Number(match[1]);
  const unit = match[2];
  const unitMs = unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 60_000;
  const from = new Date(now.getTime() - amount * unitMs);
  const label = unit === 'h'
    ? `last ${amount}h`
    : unit === 'd'
      ? `last ${amount}d`
      : `last ${amount}m`;
  return { label, sinceIso: from.toISOString(), sinceMs: from.getTime(), from, to: now };
}

export async function connectDb(dbPath: string): Promise<lancedb.Connection> {
  try {
    return await lancedb.connect(dbPath);
  } catch (error) {
    throw new Error(`failed to connect DB ${dbPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function openRequiredTable(
  db: lancedb.Connection,
  dbPath: string,
  tableName: string,
): Promise<lancedb.Table> {
  const tableNames = await db.tableNames();
  if (!tableNames.includes(tableName)) {
    throw new Error(`table "${tableName}" not found in ${dbPath}; available=${tableNames.join(', ')}`);
  }
  return db.openTable(tableName);
}

export function parseMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  try {
    return JSON.parse(String(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
