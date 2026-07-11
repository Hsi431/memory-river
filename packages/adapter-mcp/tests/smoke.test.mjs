import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMemoryRiver } from '@memory-river/core';

import {
  createMemoryRiverMcpServer,
  GAP_AWARE_PROMPT_NAME,
  TOOL_NAMES,
} from '../dist/index.js';

class MockEmbedder {
  getDimensions() {
    return 1024;
  }

  async embed() {
    const vector = new Array(1024).fill(0);
    vector[0] = 1;
    return vector;
  }

  async embedBatch(texts) {
    return Promise.all(texts.map(text => this.embed(text)));
  }

  async healthCheck() {
    return true;
  }
}

test('lists thirteen tools, reports adapter info, and stores then recalls through MCP', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'memory-river-mcp-'));
  const river = createMemoryRiver(
    { dataDir, ramDir: path.join(dataDir, 'ram') },
    { embedder: new MockEmbedder() },
  );
  const server = createMemoryRiverMcpServer({
    river,
    sessionKey: 'mcp-smoke-session',
  });
  const client = new Client({ name: 'adapter-mcp-smoke', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await river.start();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map(tool => tool.name).sort(),
      [...TOOL_NAMES].sort(),
    );

    const info = await client.callTool({
      name: 'memory_river_info',
      arguments: {},
    });
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    assert.equal(info.isError, undefined);
    assert.equal(info.structuredContent?.version, packageJson.version);
    assert.equal(Array.isArray(info.structuredContent?.capabilities?.tools), true);
    assert.equal(info.structuredContent.capabilities.tools.length, 13);
    assert.ok(info.structuredContent.capabilities.tools.includes('memory_river_info'));
    assert.equal(
      typeof info.structuredContent?.capabilities?.concentration_llm,
      'boolean',
    );

    const prompts = await client.listPrompts();
    assert.deepEqual(prompts.prompts.map(prompt => prompt.name), [GAP_AWARE_PROMPT_NAME]);

    const stored = await client.callTool({
      name: 'memory_store',
      arguments: { text: 'Adapter MCP smoke memory', category: 'fact', importance: 0.8 },
    });
    assert.equal(stored.isError, undefined);

    const recalled = await client.callTool({
      name: 'memory_recall',
      arguments: { query: 'Adapter MCP smoke memory', limit: 5 },
    });
    assert.equal(recalled.isError, undefined);
    assert.match(JSON.stringify(recalled), /Adapter MCP smoke memory/);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await river.stop().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('memory_update changes recalled memory content through MCP', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'memory-river-mcp-'));
  const river = createMemoryRiver(
    { dataDir, ramDir: path.join(dataDir, 'ram') },
    { embedder: new MockEmbedder() },
  );
  const server = createMemoryRiverMcpServer({
    river,
    sessionKey: 'mcp-update-session',
  });
  const client = new Client({ name: 'adapter-mcp-update', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await river.start();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    await client.callTool({
      name: 'memory_store',
      arguments: { text: 'Original update target phrase', category: 'fact', importance: 0.8 },
    });
    const initial = await client.callTool({
      name: 'memory_recall',
      arguments: { query: 'Original update target phrase', limit: 5 },
    });
    const memoryId = initial.structuredContent?.result?.[0]?.id;
    assert.equal(typeof memoryId, 'string');

    const updated = await client.callTool({
      name: 'memory_update',
      arguments: {
        id: memoryId,
        text: 'Updated cobalt memory content',
        category: 'decision',
        importance: 0.95,
        metadata: { editedThrough: 'mcp' },
      },
    });
    assert.equal(updated.isError, undefined);
    assert.deepEqual(updated.structuredContent, { updated: true });

    const recalled = await client.callTool({
      name: 'memory_recall',
      arguments: { query: 'Updated cobalt memory content', limit: 5 },
    });
    assert.match(JSON.stringify(recalled), /Updated cobalt memory content/);
    assert.doesNotMatch(JSON.stringify(recalled), /Original update target phrase/);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await river.stop().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("memory_set_status='trashed' removes the memory from recall through MCP", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'memory-river-mcp-'));
  const river = createMemoryRiver(
    { dataDir, ramDir: path.join(dataDir, 'ram') },
    { embedder: new MockEmbedder() },
  );
  const server = createMemoryRiverMcpServer({
    river,
    sessionKey: 'mcp-status-session',
  });
  const client = new Client({ name: 'adapter-mcp-status', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await river.start();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    await client.callTool({
      name: 'memory_store',
      arguments: { text: 'Trash visibility target zircon-441', category: 'fact', importance: 0.8 },
    });
    const initial = await client.callTool({
      name: 'memory_recall',
      arguments: { query: 'Trash visibility target zircon-441', limit: 5 },
    });
    const memoryId = initial.structuredContent?.result?.[0]?.id;
    assert.equal(typeof memoryId, 'string');

    const statusChanged = await client.callTool({
      name: 'memory_set_status',
      arguments: { memoryId, toStatus: 'trashed' },
    });
    assert.equal(statusChanged.isError, undefined);
    assert.equal(statusChanged.structuredContent?.ok, true);
    assert.equal(statusChanged.structuredContent?.toStatus, 'trashed');

    const recalled = await client.callTool({
      name: 'memory_recall',
      arguments: { query: 'Trash visibility target zircon-441', limit: 5 },
    });
    const recalledResults = recalled.structuredContent?.result ?? [];
    assert.ok(recalledResults.every(result => result.id !== memoryId));
    assert.doesNotMatch(JSON.stringify(recalledResults), /Trash visibility target zircon-441/);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await river.stop().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('archives then rehydrates exact conversation content through MCP', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'memory-river-mcp-'));
  const river = createMemoryRiver(
    { dataDir, ramDir: path.join(dataDir, 'ram') },
    { embedder: new MockEmbedder() },
  );
  const server = createMemoryRiverMcpServer({
    river,
    sessionKey: 'mcp-archive-session',
  });
  const client = new Client({ name: 'adapter-mcp-archive', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const archived = await client.callTool({
      name: 'memory_archive',
      arguments: {
        messages: [
          {
            role: 'user',
            content: 'Which launch phrase should we preserve?',
            timestamp: '2026-06-15T10:00:00.000Z',
          },
          {
            role: 'assistant',
            content: 'Preserve the phrase cobalt-orchid-742 for provenance.',
            timestamp: '2026-06-15T10:00:01.000Z',
          },
          {
            role: 'user',
            content: 'Archive that exact exchange.',
            timestamp: '2026-06-15T10:00:02.000Z',
          },
        ],
      },
    });
    assert.equal(archived.isError, undefined);
    assert.deepEqual(archived.structuredContent, { archived: 3 });

    const rehydrated = await client.callTool({
      name: 'memory_rehydrate',
      arguments: {
        mode: 'keyword',
        keyword: 'cobalt-orchid-742',
        sessionKey: 'mcp-archive-session',
        limit: 10,
      },
    });
    assert.equal(rehydrated.isError, undefined);
    assert.match(JSON.stringify(rehydrated), /Which launch phrase should we preserve\?/);
    assert.match(JSON.stringify(rehydrated), /cobalt-orchid-742/);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});
