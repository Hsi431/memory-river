# `@memory-river/adapter-mcp`

MCP stdio server exposing Memory River to Claude Code, Codex, Cursor, Claude Desktop, and
other MCP hosts.

## Claude Code registration

Build the workspace, then add this exact entry to the MCP configuration:

```json
{
  "mcpServers": {
    "memory-river": {
      "command": "node",
      "args": [
        "/path/to/memory-river/packages/adapter-mcp/dist/cli.js"
      ],
      "env": {
        "MEMORY_RIVER_DATA_DIR": "/home/you/.memory-river",
        "MEMORY_RIVER_RAM_DIR": "/home/you/.memory-river/ram",
        "MEMORY_RIVER_SESSION_KEY": "claude-code",
        "OLLAMA_URL": "http://localhost:11434"
      }
    }
  }
}
```

`MEMORY_RIVER_DATA_DIR` also accepts `DATA_DIR`; `MEMORY_RIVER_RAM_DIR` also accepts `RAM_DIR`.
The embedding model defaults to `hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF` and can be changed with
`MEMORY_RIVER_EMBEDDING_MODEL`.

An OpenAI-compatible concentration LLM is optional. Configure it with
`MEMORY_RIVER_LLM_BASE_URL`, `MEMORY_RIVER_LLM_MODEL`, and
`MEMORY_RIVER_LLM_API_KEY`; the standard `OPENAI_BASE_URL`, `OPENAI_MODEL`, and
`OPENAI_API_KEY` aliases also work. Without these variables, the server starts without an LLM.
Recall, rehydrate, and store remain available; only LLM-dependent concentration is unavailable.
Embedding-dependent operations still require the configured Ollama embedding service.

## Surface and v1 boundary

The server exposes thirteen tools: `memory_recall`, `memory_rehydrate`, `memory_archive`,
`memory_store`, `memory_update`, `memory_set_status`, `gwm_on`, `gwm_off`, `gwm_status`,
`gwm_update`, `skill_save`, `skill_load`, and `memory_river_info`.
`memory_archive` lets a host explicitly save conversation messages into the transcript store
for later exact retrieval with `memory_rehydrate`. The server also exposes the
`memory_river_gap_aware` MCP prompt, which tells the host agent how to judge lossy recall and
rehydrate exact turns.

`memory_update` accepts a memory `id` plus one or more of `text`, `category`, `importance`, and
`metadata`. `memory_set_status` accepts `memoryId`, `toStatus` (`active`, `deprecated`,
`superseded`, or `trashed`), and optional `supersededBy` and `meta`. Setting `trashed` is the
soft-delete operation; the MCP adapter does not expose physical deletion.

Version 1 is tools plus prompt only. It does not auto-archive host conversations or inject
memory on every turn because MCP does not provide a standard host-fed conversation stream.
Memory accumulates through explicit `memory_store` and `memory_archive` calls.

GWM (`gwm_on`/`gwm_off`/`gwm_status`/`gwm_update`) only stores task working-memory state through
this adapter. Its automatic recall-biasing and drift detection run inside a host's context
assembly, which MCP does not drive — so `memory_recall` does not yet apply GWM query expansion.
Treat GWM as state-only until a host-neutral execution path exists.
