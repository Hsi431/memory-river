import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createMemoryRiverHttpServer } from '../dist/index.js';

async function requestJson(server, body) {
  const request = Readable.from([JSON.stringify(body)]);
  request.method = 'POST';
  request.url = '/archive-transcript';
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

test('HTTP archive-transcript rejects system messages before writing', async () => {
  const archived = [];
  const server = createMemoryRiverHttpServer({
    river: {
      async archiveTranscript(...args) {
        archived.push(args);
        return { ok: true };
      },
    },
    dataDir: '/tmp/http-archive-system-role',
    sessionKey: 'http-system-message-test',
  });

  const result = await requestJson(server, {
    messages: [{ role: 'system', content: 'untrusted prompt' }],
  });

  assert.equal(result.status, 400);
  assert.deepEqual(archived, []);
});
