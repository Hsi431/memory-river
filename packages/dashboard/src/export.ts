import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { connectDb, openRequiredTable, parseMetadata } from './shared.js';

const EXCLUDED_STATUSES = new Set(['trashed', 'deprecated', 'superseded']);

interface ExportMemory {
  id: string;
  text: string;
  category: string;
  status: string;
  importance: number;
  healthScore: number | null;
  updatedAt: unknown;
}

function normalizeMemory(row: Record<string, unknown>): ExportMemory {
  const metadata = parseMetadata(row.metadata);
  const health = parseMetadata(metadata.health);
  const healthScore = Number(health.healthScore);
  return {
    id: String(row.id ?? ''),
    text: String(row.text ?? ''),
    category: String(row.category ?? ''),
    status: String(row.status ?? ''),
    importance: Number(row.importance ?? 0),
    healthScore: Number.isFinite(healthScore) ? healthScore : null,
    updatedAt: row.updatedAt ?? '',
  };
}

function sortableUpdatedAt(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  const text = String(value ?? '');
  const numeric = Number(text);
  if (text !== '' && Number.isFinite(numeric)) return numeric;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function compareMemories(left: ExportMemory, right: ExportMemory): number {
  const leftTime = sortableUpdatedAt(left.updatedAt);
  const rightTime = sortableUpdatedAt(right.updatedAt);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  const updatedAtOrder = String(right.updatedAt).localeCompare(String(left.updatedAt));
  return updatedAtOrder || left.id.localeCompare(right.id);
}

function yamlValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'bigint') return String(value);
  return JSON.stringify(String(value));
}

function activeMemories(rows: Record<string, unknown>[]): ExportMemory[] {
  return rows
    .map(normalizeMemory)
    .filter(memory => !EXCLUDED_STATUSES.has(memory.status.toLowerCase()))
    .sort(compareMemories);
}

function buildMarkdown(memories: ExportMemory[]): string {
  if (memories.length === 0) return '';

  return `${memories.map(memory => [
    `## ${memory.id}`,
    '',
    '```yaml',
    `id: ${yamlValue(memory.id)}`,
    `category: ${yamlValue(memory.category)}`,
    `status: ${yamlValue(memory.status)}`,
    `importance: ${yamlValue(memory.importance)}`,
    `healthScore: ${yamlValue(memory.healthScore)}`,
    `updatedAt: ${yamlValue(memory.updatedAt)}`,
    '```',
    '',
    memory.text,
  ].join('\n')).join('\n\n')}\n`;
}

export async function runExport(dbPath: string, outputPath: string): Promise<void> {
  const db = await connectDb(dbPath);
  const table = await openRequiredTable(db, dbPath, 'memories');
  const rows = await table.query().toArray() as Record<string, unknown>[];
  const memories = activeMemories(rows);
  const markdown = buildMarkdown(memories);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, markdown, 'utf8');
  console.log(`Exported ${memories.length} memories to ${outputPath}`);
}
