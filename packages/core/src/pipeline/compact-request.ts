import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export const COMPACT_REQUEST_VERSION = 1;
export const COMPACT_REQUEST_FILENAME_PREFIX = 'compact_request_';

export interface AsyncCompactRequest {
  trackingKey: string;
  sessionId?: string;
  sessionKey?: string;
  originalTokens: number;
  compressedTokens: number;
  timestamp: number;
}

export interface CompactRequestInboxItem {
  type: 'compact_request';
  version: 1;
  requestId: string;
  trackingKey: string;
  sessionId?: string;
  sessionKey?: string;
  originalTokens: number;
  compressedTokens: number;
  createdAt: number;
  source: 'asyncCompactAfterAssemble';
}

export class CompactRequestSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompactRequestSchemaError';
  }
}

export function buildCompactRequestFilename(item: CompactRequestInboxItem): string {
  return `${COMPACT_REQUEST_FILENAME_PREFIX}${item.createdAt}_${item.requestId}.json`;
}

export function isCompactRequestFilename(name: string): boolean {
  return name.startsWith(COMPACT_REQUEST_FILENAME_PREFIX) && name.endsWith('.json');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CompactRequestSchemaError(`${field} must be a non-empty string`);
  }
}

export function validateCompactRequest(raw: unknown): asserts raw is CompactRequestInboxItem {
  if (!raw || typeof raw !== 'object') {
    throw new CompactRequestSchemaError('compact request must be an object');
  }

  const item = raw as Record<string, unknown>;
  if (item.type !== 'compact_request') throw new CompactRequestSchemaError('type must be compact_request');
  if (item.version !== COMPACT_REQUEST_VERSION) throw new CompactRequestSchemaError('version must be 1');
  assertNonEmptyString(item.requestId, 'requestId');
  assertNonEmptyString(item.trackingKey, 'trackingKey');
  if (!isFiniteNumber(item.originalTokens)) throw new CompactRequestSchemaError('originalTokens must be a finite number');
  if (!isFiniteNumber(item.compressedTokens)) throw new CompactRequestSchemaError('compressedTokens must be a finite number');
  if (!isFiniteNumber(item.createdAt)) throw new CompactRequestSchemaError('createdAt must be a finite number');
  if (item.source !== 'asyncCompactAfterAssemble') {
    throw new CompactRequestSchemaError('source must be asyncCompactAfterAssemble');
  }
  if (item.sessionId !== undefined && typeof item.sessionId !== 'string') {
    throw new CompactRequestSchemaError('sessionId must be a string when present');
  }
  if (item.sessionKey !== undefined && typeof item.sessionKey !== 'string') {
    throw new CompactRequestSchemaError('sessionKey must be a string when present');
  }
}

export async function writeCompactRequest(
  inboxPath: string,
  item: CompactRequestInboxItem,
): Promise<string> {
  validateCompactRequest(item);
  await fs.mkdir(inboxPath, { recursive: true });

  const filename = buildCompactRequestFilename(item);
  const finalPath = path.join(inboxPath, filename);
  const tmpPath = path.join(inboxPath, `.${item.requestId}.tmp`);
  await fs.writeFile(tmpPath, JSON.stringify(item, null, 2), 'utf-8');
  await fs.rename(tmpPath, finalPath);
  return finalPath;
}

export async function readCompactRequest(filePath: string): Promise<CompactRequestInboxItem> {
  const raw = JSON.parse(await fs.readFile(filePath, 'utf-8')) as unknown;
  validateCompactRequest(raw);
  return raw;
}
