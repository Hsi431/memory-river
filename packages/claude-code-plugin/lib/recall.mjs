import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createMemoryRiverClient } from './http.mjs';

export const RECALL_HEADER = '[memory-river recall — 供參考的長期記憶,與本輪無關就忽略]\n';

export function shouldSkipPrompt(prompt) {
  if (typeof prompt !== 'string') {
    return true;
  }
  return prompt.trim().length < 8 || prompt.trimStart().startsWith('/');
}

function entryId(value) {
  const id = value?.entry?.id ?? value?.id ?? value?.entryId;
  if (typeof id === 'string' || typeof id === 'number') {
    return String(id);
  }
  return null;
}

function safeSessionFileName(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');
}

function cacheFilePath(sessionId, tmpDir = process.env.TMPDIR || os.tmpdir()) {
  return path.join(tmpDir, 'memory-river-cc', `${safeSessionFileName(sessionId)}.json`);
}

async function readInjectedIds(sessionId, tmpDir) {
  if (!sessionId) {
    return new Set();
  }

  try {
    const raw = await readFile(cacheFilePath(sessionId, tmpDir), 'utf8');
    const parsed = JSON.parse(raw);
    const ids = Array.isArray(parsed) ? parsed : parsed?.ids;
    return new Set(Array.isArray(ids) ? ids.map(String) : []);
  } catch {
    return new Set();
  }
}

async function writeInjectedIds(sessionId, ids, tmpDir) {
  if (!sessionId) {
    return;
  }

  try {
    const filePath = cacheFilePath(sessionId, tmpDir);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({ ids: [...ids] }), 'utf8');
  } catch {
    // Cache failures must not suppress recall output.
  }
}

export function filterRecallBlock(block, allowedIds) {
  if (typeof block !== 'string' || !block.trim()) {
    return '';
  }

  if (!allowedIds) {
    return block;
  }

  try {
    const parsed = JSON.parse(block);
    if (Array.isArray(parsed)) {
      const filtered = parsed.filter((item) => {
        const id = entryId(item);
        return id === null || allowedIds.has(id);
      });
      return filtered.length > 0 ? JSON.stringify(filtered, null, 2) : '';
    }
  } catch {
    // Non-JSON blocks are still valid service output; use them as-is.
  }

  return block;
}

export async function handleRecallInject(event, {
  baseUrl,
  client,
  fetchImpl,
  tmpDir,
} = {}) {
  try {
    const prompt = typeof event?.prompt === 'string' ? event.prompt : '';
    if (shouldSkipPrompt(prompt)) {
      return null;
    }

    const activeClient = client ?? createMemoryRiverClient({ baseUrl, fetchImpl });
    const response = await activeClient.recall(prompt, 5);
    const results = Array.isArray(response?.results) ? response.results : [];
    if (results.length === 0) {
      return null;
    }

    const ids = results.map(entryId).filter((id) => id !== null);
    const sessionId = typeof event?.session_id === 'string' ? event.session_id : '';
    const injectedIds = await readInjectedIds(sessionId, tmpDir);
    const freshIds = ids.length > 0 ? ids.filter((id) => !injectedIds.has(id)) : [];

    if (ids.length > 0 && freshIds.length === 0) {
      return null;
    }

    const allowedIds = ids.length > 0 ? new Set(freshIds) : null;
    const block = filterRecallBlock(response?.block, allowedIds);
    if (!block.trim()) {
      return null;
    }

    for (const id of freshIds) {
      injectedIds.add(id);
    }
    await writeInjectedIds(sessionId, injectedIds, tmpDir);

    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `${RECALL_HEADER}${block}`,
      },
    };
  } catch {
    return null;
  }
}

export async function runRecallInject(input, options = {}) {
  try {
    const event = JSON.parse(input || '{}');
    const output = await handleRecallInject(event, options);
    return output ? JSON.stringify(output) : '';
  } catch {
    return '';
  }
}
