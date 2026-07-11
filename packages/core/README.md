# @memory-river/core

**Three-tier memory for agents — a working recap that fades, durable facts that persist, and the full transcript it can always go back and re-read.**

[繁體中文](./README.zh-TW.md)

Most "agent memory" is a vector store with a save button: one flat pile of embeddings you write to and search. Memory River is a memory *system* modeled on how memory actually works — it keeps information at **three timescales**, retrieves it in **two passes**, lets memories **metabolize** over time, and can trace anything it distilled back to the exact turns it came from. You inject your own embedding and LLM providers; the engine is host-independent.

> `0.1.x` is an early API. Review upgrades before adopting a new minor release.

## The idea: three timescales of memory

When a conversation grows past a watermark, Memory River doesn't just truncate the old turns — it **distills** them into memory at three timescales:

- **Short term — the session capsule.** A compact recap of what just happened, injected at the top of the next prompt so the model keeps the thread after old turns are cut. It starts at low health and **metabolizes fast** — this is working memory for *this* session, not a fact store. The capsule is domain-adaptive: a coding session gets a structured task summary; a casual conversation gets a natural-language recap.
- **Medium term — distilled notes.** Alongside each capsule, a handful of granular, self-contained facts are extracted and written to the store as ordinary memories. They start at full health and **persist** — this is what `recall` surfaces days later.
- **Long term — the raw transcript.** Every turn is archived verbatim with a byte-offset index, and the session capsule records the exact turns it summarized — so nothing is ever truly lost to compression.

## Retrieval in two passes

1. **Coarse recall (automatic, cheap).** Before a model turn, `assembleContext` injects the top couple of relevant memories. Always on.
2. **Rehydrate (precise, on demand).** A lossy memory carries pointers back to its source turns; the agent calls `rehydrate` to pull the **exact original turns** — verbatim numbers, names, dates — by entry-id, time window, or keyword.

The common case stays cheap (you don't reload the whole conversation every turn), but precise detail is never more than one hop away. This is also what makes Memory River **auditable**: every distilled claim can be traced to the source turns that produced it.

## Memory that metabolizes

Memories aren't write-once rows. They **live**: health decays over time and refreshes on access; a newer fact **supersedes** a close older one; contradictions are **flagged and deprecated** instead of silently coexisting; a nightly pass **merges** redundant memories; dead memories are cleaned up through a trash-protected path. Core categories, high-importance facts, and skill capsules are protected from decay — so the store stays relevant instead of growing into noise.

## How it's built

| Subsystem | What it does | Module |
| --- | --- | --- |
| Dual-tier store + WAL | RAM-dir (e.g. tmpfs) for hot reads, data-dir for durability, write-ahead log with crash recovery | `store/store-v4` |
| Distillation pipeline | Old turns are summarized into a capsule + granular notes, written through an async inbox so writes never block the conversation | `distill/concentrator-adapter` + `pipeline/inbox-watcher` |
| Transcript + rehydrate | Verbatim turn archive with a byte-offset `.idx`; recover exact turns by entry-id, time, or keyword | `transcript/` |
| Hybrid retrieval | Vector + full-text BM25, RRF fusion, optional local rerank (CRAG-style accept/partial/reject, tuned recall-safe), EntitySynergyMerger (NER fragment rescue), Structured-Slot dedup, causal-chain context expansion | `retrieval/retriever-v4` |
| Knowledge graph | Triple (subject–relation–object) store with vector + FTS entity search, used to expand hook/query coverage | `store/graph-store` |
| Memory metabolism | Health decays over time, refreshes on access; dead memories cleaned up through a trash-protected path | `lifecycle/cleanup-engine` |
| Night consolidation | Periodic offline pass that merges and compresses related memories | `lifecycle/night-consolidation` |
| Associative hooks | Memories can carry trigger keywords that fire related recalls; a feedback loop reweights hooks by hit quality | `cognition/hooks-engine` |
| Causal + conflict | Newer facts supersede close older ones; contradictions are flagged and deprecated with a `supersededBy` chain | `cognition/causal-engine` + `conflict-detector` |
| Structured slots | Extracts structured params (slotKey/slotValue) at write time with a version chain; retrieval returns only the latest active per slot | `pipeline/inbox-watcher` + `retrieval/retriever-v4` |
| Global Working Memory (GWM) | Tracks the long-conversation task; embedding drift detection nudges the agent back on topic | `cognition/global-working-memory` |
| Skill capsules v2 | Explicitly saved procedures with progressive disclosure: a one-line index is injected, full steps load on demand | `engine` + `skills/` |
| Ralph Loop | Context circuit-breaker: on repeated failures it trims/truncates context and injects warnings to keep context from blowing up | `cognition/ralph-core` |
| Observability | Every subsystem writes best-effort stats rows (`subsystem_effectiveness`, `status_audit_log`, …) you can audit later | throughout |

Everything above is in the code today — this README intentionally describes nothing aspirational.

## Requirements

- Node.js 20
- An `EmbeddingProvider` (a ready-made `OllamaEmbedding` is included)
- An `LlmClient` (any function that turns a prompt into text — see Quick Start)
- Two writable directories (`dataDir` for durability, `ramDir` for the hot tier — tmpfs if you have it, any disk dir works)

Optional native deps degrade gracefully: `nodejieba` (CJK tokenization, falls back to character split) and `@xenova/transformers` (local reranker, falls back to pass-through).

## Installation

```bash
npm install @memory-river/core
```

In this monorepo:

```bash
npm ci
npm run build -w @memory-river/core
```

## Quick Start

The repository's [`example-cli`](../example-cli/src/cli.ts) (~110 lines) is a complete non-OpenClaw integration using Ollama for both embeddings and chat:

```bash
ollama pull hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF
ollama pull qwen3:8b
npm run build -ws

node packages/example-cli/dist/cli.js remember "The deployment window is Friday at 18:00."
node packages/example-cli/dist/cli.js recall "When is deployment?"
node packages/example-cli/dist/cli.js chat
```

The equivalent core setup:

```ts
import {
  createMemoryRiver,
  OllamaEmbedding,
  type LlmClient,
} from '@memory-river/core';

const ollamaUrl = 'http://localhost:11434';

const llm: LlmClient = {
  async generate(prompt, opts) {
    const response = await fetch(`${ollamaUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3:8b',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: opts?.maxTokens,
      }),
    });
    if (!response.ok) throw new Error(`LLM request failed: ${response.status}`);
    const body = await response.json() as any;
    return body.choices?.[0]?.message?.content ?? '';
  },
};

const embedder = new OllamaEmbedding({
  provider: 'ollama',
  apiKey: '',
  model: 'hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF',
  dimensions: 1024,
  ollamaUrl,
});

const river = createMemoryRiver(
  {
    dataDir: '/var/lib/my-agent/memory-river',
    ramDir: '/var/lib/my-agent/memory-river/ram',
    autoRecall: true,
  },
  { embedder, llm },
);

await river.start();
try {
  await river.remember('The deployment window is Friday at 18:00.', {
    category: 'fact',
    importance: 0.8,
  });
  const results = await river.recall('When is deployment?', 5);
  console.log(results);
} finally {
  await river.stop();
}
```

`start()` initializes the engine, starts the inbox watcher, and schedules maintenance. `stop()` stops watchers and timers and shuts down the memory store.

## API

`createMemoryRiver(config, deps)` returns:

| API | Purpose |
| --- | --- |
| `start()` / `stop()` | Engine lifecycle. |
| `remember(text, opts?)` | Store a memory with optional category, importance, metadata. |
| `recall(query, limit?)` | Ranked `MemorySearchResult` records from hybrid retrieval. |
| `assembleContext(messages, session?)` | Inject relevant memories (and the skill index) into a message list before a model turn. |
| `skills.save / load / search / list` | Skill capsules v2 — see below. |
| `rehydrate(request)` | Read archived transcript entries by IDs, time range, or keyword. |
| `archiveTranscript(session, messages)` | Append host messages to the transcript archive. |
| `compactSessionFile(session, opts?)` | Compact a host session file when `SessionFileAccess` resolves one. |
| `gwm.on/off/status/update` | Global Working Memory state (goal tracking + drift detection). |
| `maintenance.runCleanup()` / `runNightConsolidation()` | Trigger maintenance manually. |

`MemoryRiverConfig` requires `dataDir` and `ramDir`; everything else (`embedding`, `retrieval`, `cleanup`, `health`, `hooks`, `causalEngine`, `concentration`, `autoRecall`, `driftThreshold`, …) is optional and merged with defaults.

## Skill Capsules v2

Skills are procedures your agent explicitly saves — the system never auto-generates them:

```ts
await river.skills.save({
  name: 'git-release',
  summary: 'Tag and push a release the standard way',
  triggers: ['release', 'tag a version'],
  steps: ['Run the test suite', 'git tag -s vX.Y.Z', 'git push --tags', 'Draft release notes'],
});
```

- **Progressive disclosure**: `assembleContext` injects only a one-line index (`【git-release】triggers… → skill_load("git-release")`); full steps cost zero tokens until the agent calls `skills.load`.
- **Honest usage stats**: only `load` increments `usageCount` — being injected doesn't count as being used.
- **Lifecycle**: skills decay 4× slower than ordinary memories and heal on every load; unused ones eventually fade out instead of polluting the index forever.
- **Deterministic quality gate**: malformed definitions are rejected with every violation listed at once — no LLM judging, no silent fixes.

## Dependency Ports

The host owns external services. Required: `embedder`, `llm`. Optional: `logger`, `notifier`, `sessionFiles`.

```ts
interface EmbeddingProvider {
  embed(text: string, mode?: 'store' | 'query'): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  getDimensions(): number;
  healthCheck?(): Promise<boolean>;
}

interface LlmClient {
  generate(prompt: string, opts?: { purpose?: string; maxTokens?: number }): Promise<string>;
}
```

Provider selection, retries, fallback, and rate limiting belong in your `LlmClient` — core deliberately does not ship a multi-provider fallback chain.

`Logger` defaults to console. `Notifier` defaults to no-op. Without `SessionFileAccess`, transcript archiving and rehydration still work; only `compactSessionFile()` becomes a no-op.

## Porting to Another Agent Host

1. Pick writable `dataDir` + `ramDir`.
2. Implement `EmbeddingProvider` (or use `OllamaEmbedding`).
3. Implement `LlmClient` (~20 lines for any OpenAI-compatible endpoint).
4. `createMemoryRiver(...)`, `start()` on host startup, `stop()` on shutdown.
5. Expose `remember` / `recall` (and optionally `skills.save` / `skills.load`) as host tools.

That's a working integration — `example-cli` is exactly this and fits in ~110 lines. Steps 6–9 are optional layers: pass conversations through `assembleContext`, archive transcripts for `rehydrate`, wire `SessionFileAccess` for session-file compaction, connect `Logger`/`Notifier`.

## Persistence Notes

LanceDB-backed dual-tier storage plus a WAL. Inserts are WAL-protected before the call returns; replay is idempotent and a failed replay preserves the log for the next attempt. The package does not claim exactly-once recovery or zero data loss — treat the data directory as application state and back it up accordingly.

## License

Apache-2.0 © 2026 Hsi431. Use, modify, embed, and ship freely under the permissive
Apache 2.0 terms. See the repository-root [LICENSE](../../LICENSE).
