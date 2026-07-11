export const DEFAULT_MEMORY_RIVER_URL = 'http://127.0.0.1:4791';

function timeoutSignal(timeoutMs) {
  if (globalThis.AbortSignal && typeof globalThis.AbortSignal.timeout === 'function') {
    return globalThis.AbortSignal.timeout(timeoutMs);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  return controller.signal;
}

export function createMemoryRiverClient({
  baseUrl = process.env.MEMORY_RIVER_URL || DEFAULT_MEMORY_RIVER_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedBaseUrl = String(baseUrl || DEFAULT_MEMORY_RIVER_URL).replace(/\/+$/, '');

  async function postJson(path, body, timeoutMs) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('fetch is unavailable');
    }

    const response = await fetchImpl(`${normalizedBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: timeoutSignal(timeoutMs),
    });

    if (!response || !response.ok) {
      const status = response && 'status' in response ? response.status : 'unknown';
      throw new Error(`memory-river ${path} failed: ${status}`);
    }

    return response.json();
  }

  return {
    recall(query, limit = 5) {
      return postJson('/recall', { query, limit }, 1500);
    },

    archiveTranscript(session, messages) {
      return postJson('/archive-transcript', { session, messages }, 30000);
    },
  };
}
