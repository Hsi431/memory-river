import { readFile } from 'node:fs/promises';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MemoryRiver } from '@memory-river/core';
import type { ZodType } from 'zod/v4';

import { GAP_AWARE_PROMPT, GAP_AWARE_PROMPT_NAME } from './prompt.js';
import { createToolExecutor, TOOL_NAMES, TOOL_SCHEMAS } from './tools.js';

const { version: ADAPTER_VERSION } = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

export interface MemoryRiverMcpServerOptions {
  river: MemoryRiver;
  sessionKey: string;
  concentrationLlmConfigured?: boolean;
}

function resultPayload(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { result: value };
}

function toolResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: resultPayload(value),
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text' as const, text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

export function createMemoryRiverMcpServer(
  options: MemoryRiverMcpServerOptions,
): McpServer {
  const server = new McpServer({
    name: '@memory-river/adapter-mcp',
    version: ADAPTER_VERSION,
  });
  const execute = createToolExecutor(options.river, options.sessionKey);

  const register = (
    name: string,
    description: string,
    inputSchema: ZodType,
    handler: (args: any) => Promise<unknown> | unknown,
  ) => {
    server.registerTool(
      name,
      { description, inputSchema },
      async args => {
        try {
          return toolResult(await handler(args));
        } catch (error) {
          return toolError(error);
        }
      },
    );
  };

  register(
    'memory_recall',
    'Search long-term memory for relevant facts, summaries, and source provenance.',
    TOOL_SCHEMAS.memory_recall,
    execute.memory_recall,
  );
  register(
    'memory_rehydrate',
    'Read exact original conversation turns. Prefer entry_ids with relevant sourceEntryIds and their sessionKey; use time_range for a trustworthy timestamp; use one distinctive keyword when recall failed.',
    TOOL_SCHEMAS.memory_rehydrate,
    execute.memory_rehydrate,
  );
  register(
    'memory_archive',
    'Archive host conversation messages into the exact transcript store for later rehydration.',
    TOOL_SCHEMAS.memory_archive,
    execute.memory_archive,
  );
  register(
    'memory_store',
    'Save a durable long-term memory.',
    TOOL_SCHEMAS.memory_store,
    execute.memory_store,
  );
  register(
    'memory_update',
    'Update the text, category, importance, or metadata of an existing memory by id.',
    TOOL_SCHEMAS.memory_update,
    execute.memory_update,
  );
  register(
    'memory_set_status',
    'Change a memory status to deprecated, superseded, trashed, or active to restore it.',
    TOOL_SCHEMAS.memory_set_status,
    execute.memory_set_status,
  );
  register(
    'gwm_on',
    'Start Global Working Memory for a task so its keywords bias recall.',
    TOOL_SCHEMAS.gwm_on,
    execute.gwm_on,
  );
  register(
    'gwm_off',
    'Stop Global Working Memory tracking.',
    TOOL_SCHEMAS.gwm_off,
    execute.gwm_off,
  );
  register(
    'gwm_status',
    'Show the current Global Working Memory task and drift state.',
    TOOL_SCHEMAS.gwm_status,
    execute.gwm_status,
  );
  register(
    'gwm_update',
    'Update the Global Working Memory task name, description, or keywords.',
    TOOL_SCHEMAS.gwm_update,
    execute.gwm_update,
  );
  register(
    'skill_save',
    'Save a reusable skill procedure.',
    TOOL_SCHEMAS.skill_save,
    execute.skill_save,
  );
  register(
    'skill_load',
    "Load a saved skill's full execution steps by name.",
    TOOL_SCHEMAS.skill_load,
    execute.skill_load,
  );
  register(
    'memory_river_info',
    'Report the adapter version and available capabilities.',
    TOOL_SCHEMAS.memory_river_info,
    () => ({
      version: ADAPTER_VERSION,
      capabilities: {
        tools: [...TOOL_NAMES],
        concentration_llm: options.concentrationLlmConfigured ?? false,
      },
    }),
  );

  server.registerPrompt(
    GAP_AWARE_PROMPT_NAME,
    {
      title: 'Memory River gap-aware disposition',
      description: 'Guidance for judging lossy recall and escalating to exact rehydration.',
    },
    () => ({
      description: 'Use this as system-level guidance while operating Memory River tools.',
      messages: [{
        role: 'user',
        content: { type: 'text', text: GAP_AWARE_PROMPT },
      }],
    }),
  );

  return server;
}
