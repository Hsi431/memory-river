import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultPortCheck } from '../dist/doctor.js';

test('doctor accepts a busy port when the Memory River health endpoint answers', async () => {
  const requests = [];
  const port = 4791;
  const healthy = await defaultPortCheck(port, {
    canListen: async () => false,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ ok: true, version: '0.2.0' }) };
    },
  });

  assert.equal(healthy, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `http://127.0.0.1:${port}/health`);
});

test('doctor does not accept an unrelated health response on a busy port', async () => {
  const result = await defaultPortCheck(4791, {
    canListen: async () => false,
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: false, service: 'other' }) }),
  });

  assert.equal(result, false);
});
