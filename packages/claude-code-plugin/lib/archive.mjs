import { readFile, stat } from 'node:fs/promises';

import { createMemoryRiverClient } from './http.mjs';
import { tailArchiveMessages, transcriptJsonlToMessages } from './transcript.mjs';

export async function handleArchiveSession(event, {
  baseUrl,
  client,
  fetchImpl,
  stderr = process.stderr,
} = {}) {
  try {
    const transcriptPath = typeof event?.transcript_path === 'string' ? event.transcript_path : '';
    const sessionId = typeof event?.session_id === 'string' ? event.session_id : '';
    if (!transcriptPath || !sessionId) {
      return null;
    }

    let fileStat;
    try {
      fileStat = await stat(transcriptPath);
    } catch {
      return null;
    }
    if (!fileStat.isFile() || fileStat.size === 0) {
      return null;
    }

    const raw = await readFile(transcriptPath, 'utf8');
    if (!raw.trim()) {
      return null;
    }

    const messages = tailArchiveMessages(transcriptJsonlToMessages(raw), stderr);
    if (messages.length === 0) {
      return null;
    }

    const activeClient = client ?? createMemoryRiverClient({ baseUrl, fetchImpl });
    await activeClient.archiveTranscript({ sessionKey: `cc-${sessionId}` }, messages);
    return null;
  } catch {
    return null;
  }
}

export async function runArchiveSession(input, options = {}) {
  try {
    const event = JSON.parse(input || '{}');
    await handleArchiveSession(event, options);
  } catch {
    // Fail open.
  }
  return '';
}
