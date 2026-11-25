import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMemoryRiverMcpServer } from '../dist/index.js';

async function withClient(river, run) {
  const server = createMemoryRiverMcpServer({ river, sessionKey: 'test-session' });
  const client = new Client({ name: 'mcp-session-key-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await run(client);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

test('MCP rehydrate rejects traversal session keys but permits a valid requested session', async () => {
  const requests = [];
  const river = {
    async rehydrate(request) {
      requests.push(request);
      return 'transcript';
    },
  };

  await withClient(river, async client => {
    const rejected = await client.callTool({
      name: 'memory_rehydrate',
      arguments: { mode: 'keyword', keyword: 'needle', sessionKey: '../victim' },
    });
    assert.equal(rejected.isError, true);
    assert.match(rejected.structuredContent?.error ?? '', /invalid sessionKey/);

    const accepted = await client.callTool({
      name: 'memory_rehydrate',
      arguments: { mode: 'keyword', keyword: 'needle', sessionKey: 'victim-session' },
    });
    assert.equal(accepted.isError, undefined);
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].sessionKey, 'victim-session');
});
