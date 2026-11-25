import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createMemoryRiverHttpServer } from '../dist/index.js';

async function requestJson(server, url, body) {
  const request = Readable.from([JSON.stringify(body)]);
  request.method = 'POST';
  request.url = url;
  request.headers = { host: '127.0.0.1:4791', 'content-type': 'application/json' };

  return await new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      writeHead(statusCode) {
        this.statusCode = statusCode;
      },
      end(chunk) {
        try {
          resolve({ status: this.statusCode, body: JSON.parse(chunk?.toString() || 'null') });
        } catch (error) {
          reject(error);
        }
      },
    };
    server.emit('request', request, response);
  });
}

test('HTTP session keys reject traversal and accept valid keys', async () => {
  const rehydrated = [];
  const archived = [];
  const server = createMemoryRiverHttpServer({
    river: {
      async rehydrate(request) {
        rehydrated.push(request);
        return [];
      },
      async archiveTranscript(session, messages) {
        archived.push({ session, messages });
        return { ok: true };
      },
    },
    dataDir: '/tmp/http-session-key-validation',
    sessionKey: 'http-session-key-test',
  });

  for (const sessionKey of ['../x', 'has/slash', '']) {
    const rehydrateResult = await requestJson(server, '/rehydrate', { sessionKey, entryIds: [] });
    assert.equal(rehydrateResult.status, 400, `rehydrate ${JSON.stringify(sessionKey)}`);

    const archiveResult = await requestJson(server, '/archive-transcript', { sessionKey, messages: [] });
    assert.equal(archiveResult.status, 400, `archive fallback ${JSON.stringify(sessionKey)}`);

    const nestedResult = await requestJson(server, '/archive-transcript', {
      session: { sessionKey },
      messages: [],
    });
    assert.equal(nestedResult.status, 400, `archive session ${JSON.stringify(sessionKey)}`);
  }

  const rehydrateResult = await requestJson(server, '/rehydrate', {
    sessionKey: 'valid.key-123:session',
    entryIds: [],
  });
  assert.equal(rehydrateResult.status, 200);
  assert.equal(rehydrated[0].sessionKey, 'valid.key-123:session');

  const archiveResult = await requestJson(server, '/archive-transcript', {
    session: { sessionKey: 'cc-valid_session-1' },
    messages: [],
  });
  assert.equal(archiveResult.status, 200);
  assert.equal(archived[0].session.sessionKey, 'cc-valid_session-1');
});
