import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createToolExecutor } from '@memory-river/adapter-mcp';
import {
  parseEntryIds,
  type ContextMessage,
  type MemoryRiver,
  type RehydrateRequest,
  type SessionHint,
} from '@memory-river/core';

const { version: SERVICE_VERSION } = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BODY_BYTES = 64 * 1024 * 1024;

export interface MemoryRiverHttpServiceOptions {
  river: MemoryRiver;
  dataDir: string;
  sessionKey: string;
  port?: number;
  version?: string;
  startedAt?: number;
}

export interface MemoryRiverHttpService {
  server: Server;
  url: string;
  close(): Promise<void>;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body === undefined ? null : body));
}

function sendError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { error: message });
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const match = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/i.exec(host);
  return match !== null && (match[1] === undefined || Number(match[1]) <= 65535);
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname.toLowerCase() === '127.0.0.1' ||
        url.hostname.toLowerCase() === 'localhost' ||
        url.hostname.toLowerCase() === '[::1]') &&
      url.username === '' && url.password === '' && url.pathname === '/' &&
      url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}

export function isAllowedRequest(
  headers: Pick<IncomingMessage['headers'], 'host' | 'origin'>,
): boolean {
  if (!isLoopbackHost(headers.host)) return false;
  const origin = headers.origin;
  return origin === undefined || isLoopbackOrigin(origin);
}

export function requestPath(request: IncomingMessage): string | null {
  try {
    return new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return null;
  }
}

class BodyTooLargeError extends Error {}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    if (tooLarge) continue;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) throw new BodyTooLargeError();
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}

function asObject(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function boundedNumberOrDefault(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Math.min(maximum, Math.max(minimum, numberOrDefault(value, fallback)));
}

function isValidSessionKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]+$/.test(value) && !value.includes('..');
}

function sessionFromBody(body: Record<string, unknown>, sessionKey: string): SessionHint {
  if (body.session !== null && typeof body.session === 'object' && !Array.isArray(body.session)) {
    return body.session as SessionHint;
  }
  return { sessionKey: typeof body.sessionKey === 'string' ? body.sessionKey : sessionKey };
}

async function recallBlock(
  river: MemoryRiver,
  sessionKey: string,
  query: string,
  limit: number,
  results: Awaited<ReturnType<MemoryRiver['recall']>>,
): Promise<string> {
  const replayRiver = {
    ...river,
    recall: async () => results,
  } as MemoryRiver;
  const executor = createToolExecutor(replayRiver, sessionKey);
  const payload = await executor.memory_recall({ query, limit });
  return JSON.stringify(payload, null, 2);
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: Required<Pick<MemoryRiverHttpServiceOptions, 'river' | 'sessionKey' | 'version' | 'startedAt'>>,
): Promise<void> {
  if (!isAllowedRequest(request.headers)) {
    sendError(response, 403, 'forbidden host or origin');
    return;
  }

  const path = requestPath(request);
  if (path === null) {
    sendError(response, 400, 'invalid request URL');
    return;
  }

  if (request.method === 'GET' && path === '/health') {
    sendJson(response, 200, {
      ok: true,
      version: options.version,
      uptimeSec: Math.floor((Date.now() - options.startedAt) / 1000),
    });
    return;
  }

  if (request.method !== 'POST') {
    sendError(response, 404, 'not found');
    return;
  }

  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    sendError(response, 415, 'content type must be application/json');
    return;
  }

  let body: Record<string, unknown>;
  try {
    const bodyLimit = path === '/archive-transcript' ? MAX_ARCHIVE_BODY_BYTES : MAX_REQUEST_BODY_BYTES;
    body = asObject(await readJsonBody(request, bodyLimit));
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendError(response, 413, 'request body too large');
      return;
    }
    sendError(response, 400, 'invalid JSON');
    return;
  }

  try {
    if (path === '/recall') {
      const query = typeof body.query === 'string' ? body.query : '';
      const limit = boundedNumberOrDefault(body.limit, 5, 1, 100);
      const results = await options.river.recall(query, limit);
      sendJson(response, 200, {
        results,
        block: await recallBlock(options.river, options.sessionKey, query, limit, results),
      });
      return;
    }

    if (path === '/store') {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) throw new Error('store requires non-empty text');
      await options.river.remember(text, {
        category: typeof body.category === 'string' ? body.category : undefined,
        importance: numberOrDefault(body.importance, 0.7),
        metadata: { sessionKey: options.sessionKey },
      });
      sendJson(response, 200, { ok: true });
      return;
    }

    if (path === '/rehydrate') {
      if (body.sessionKey !== undefined && !isValidSessionKey(body.sessionKey)) {
        sendError(response, 400, 'invalid sessionKey');
        return;
      }
      const requestBody: RehydrateRequest = {
        mode: 'entry_ids',
        sessionKey: typeof body.sessionKey === 'string' ? body.sessionKey : options.sessionKey,
        entryIds: typeof body.entryIds === 'string'
          ? parseEntryIds(body.entryIds)
          : Array.isArray(body.entryIds) ? body.entryIds.filter(Number.isInteger) : [],
        bleed: boundedNumberOrDefault(body.bleed, 2, 0, 20),
        limit: boundedNumberOrDefault(body.limit, 10, 1, 100),
      };
      sendJson(response, 200, await options.river.rehydrate(requestBody));
      return;
    }

    if (path === '/archive-transcript') {
      if (body.sessionKey !== undefined && !isValidSessionKey(body.sessionKey)) {
        sendError(response, 400, 'invalid sessionKey');
        return;
      }
      const session = sessionFromBody(body, options.sessionKey);
      if (session.sessionKey !== undefined && !isValidSessionKey(session.sessionKey)) {
        sendError(response, 400, 'invalid sessionKey');
        return;
      }
      const messages = Array.isArray(body.messages) ? body.messages as ContextMessage[] : [];
      if (messages.some(message => message?.role !== 'user' && message?.role !== 'assistant')) {
        sendError(response, 400, 'archive messages must have user or assistant roles');
        return;
      }
      const result = await options.river.archiveTranscript(session, messages);
      sendJson(response, 200, result);
      return;
    }

    sendError(response, 404, 'not found');
  } catch (error) {
    sendError(response, 500, error instanceof Error ? error.message : String(error));
  }
}

export function createMemoryRiverHttpServer(
  options: MemoryRiverHttpServiceOptions,
): Server {
  const startedAt = options.startedAt ?? Date.now();
  const routeOptions = {
    river: options.river,
    sessionKey: options.sessionKey,
    version: options.version ?? SERVICE_VERSION,
    startedAt,
  };
  return createServer((request, response) => {
    void routeRequest(request, response, routeOptions).catch(() => {
      if (!response.headersSent) sendError(response, 500, 'internal server error');
    });
  });
}

export async function listenMemoryRiverHttpService(
  options: MemoryRiverHttpServiceOptions,
): Promise<MemoryRiverHttpService> {
  const port = options.port ?? 4791;
  const server = createMemoryRiverHttpServer(options);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}
