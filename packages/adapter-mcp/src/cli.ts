#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createRiverFromEnv } from './config.js';
import { createMemoryRiverMcpServer } from './server.js';

async function main(): Promise<void> {
  console.log = (...args: unknown[]) => console.error(...args);

  const { river, sessionKey, concentrationLlmConfigured } = createRiverFromEnv();
  const server = createMemoryRiverMcpServer({
    river,
    sessionKey,
    concentrationLlmConfigured,
  });
  let stopping = false;

  const stop = async (exitCode?: number) => {
    if (stopping) return;
    stopping = true;
    await server.close().catch(error => {
      console.error('[memory-river-mcp] MCP shutdown failed:', error);
    });
    await river.stop().catch(error => {
      console.error('[memory-river-mcp] river shutdown failed:', error);
    });
    if (exitCode !== undefined) process.exit(exitCode);
  };

  process.once('SIGINT', () => void stop(130));
  process.once('SIGTERM', () => void stop(143));

  await river.start();
  await server.connect(new StdioServerTransport());
}

main().catch(error => {
  console.error('[memory-river-mcp] fatal:', error);
  process.exitCode = 1;
});
