import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createToolExecutor } from '@memory-river/adapter-mcp';
import type {
  ContextMessage,
  MemoryRiver,
  RehydrateRequest,
  SessionHint,
} from '@memory-river/core';

const { version: SERVICE_VERSION } = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

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

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
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
  options: Required<Pick<MemoryRiverHttpServiceOptions, 'river' | 'dataDir' | 'sessionKey' | 'version' | 'startedAt'>>,
): Promise<void> {
  const path = requestPath(request);

  if (request.method === 'GET' && path === '/health') {
    sendJson(response, 200, {
      ok: true,
      version: options.version,
      dataDir: options.dataDir,
      uptimeSec: Math.floor((Date.now() - options.startedAt) / 1000),
    });
    return;
  }

  if (request.method !== 'POST') {
    sendError(response, 404, 'not found');
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = asObject(await readJsonBody(request));
  } catch {
    sendError(response, 400, 'invalid JSON');
    return;
  }

  try {
    if (path === '/recall') {
      const query = typeof body.query === 'string' ? body.query : '';
      const limit = numberOrDefault(body.limit, 5);
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
      const requestBody: RehydrateRequest = {
        mode: 'entry_ids',
        sessionKey: typeof body.sessionKey === 'string' ? body.sessionKey : options.sessionKey,
        entryIds: Array.isArray(body.entryIds) ? body.entryIds.filter(Number.isInteger) : [],
        bleed: numberOrDefault(body.bleed, 2),
        limit: numberOrDefault(body.limit, 10),
      };
      sendJson(response, 200, await options.river.rehydrate(requestBody));
      return;
    }

    if (path === '/archive-transcript') {
      const session = sessionFromBody(body, options.sessionKey);
      const messages = Array.isArray(body.messages) ? body.messages as ContextMessage[] : [];
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
    dataDir: options.dataDir,
    sessionKey: options.sessionKey,
    version: options.version ?? SERVICE_VERSION,
    startedAt,
  };
  return createServer((request, response) => {
    void routeRequest(request, response, routeOptions);
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

