<div align="center">

<img src=".github/assets/hero.png" alt="Memory River — local-first memory engine for long-running agents" width="100%">

<br>
<br>

**_Long-term memory for AI agents — a working recap that fades, facts that persist, and the full transcript it can always go back and re-read._**

<br>

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-22C55E?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-22%20%7C%2024-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![LanceDB](https://img.shields.io/badge/LanceDB-storage-FF6B35?style=flat-square)](https://lancedb.com/)
[![Ollama](https://img.shields.io/badge/Embeddings-local%20via%20Ollama-000000?style=flat-square&logo=ollama)](https://ollama.com/)

<br>

[繁體中文](./README.zh-TW.md) · [core package docs](packages/core/README.md)

<br>

*Most "agent memory" is a vector store with a save button — one flat pile of embeddings you write to and search.*<br>
*Memory River treats memory as a **system**: it keeps information at **three timescales**, retrieves it in **two passes**,*<br>
*lets memories **metabolize** over time — and anything it distills can be **traced back to the exact turns it came from**.*

</div>

---

## ✨ Why Memory River

Most AI memory systems are designed like a **database** — write rows, query rows. Memory River is designed like **memory itself**:

| Ordinary "vector memory" | Memory River |
|:---|:---|
| One flat pile of embeddings, write-once | **Three timescales**: a recap that fades, notes that persist, transcript that's permanent |
| Compaction = truncate the old turns | Compaction = **distill** into a capsule + granular notes; raw turns archived verbatim, nothing dropped |
| Lossy is lossy — detail is gone | Lossy memories carry **pointers back to the source**; the agent can `rehydrate` exact numbers / names / dates |
| Memories never change | Health decays linearly; selected retrieval paths and skill loads boost it; contradictions are checked in four categories |
| Grows dirtier forever | **Nightly consolidation** merges related memories and may independently deprecate stale or redundant ones; deleted rows pass through trash |
| Embeddings need a cloud API | **Fully local** Ollama embeddings — zero cloud dependency, self-hostable |
| Black box: why did it return *this*? | **Auditable**: every distilled claim traces back to the turns that produced it |

> This README describes only what's in the code today — nothing aspirational.

---

## 🧠 The idea: three timescales of memory

When a conversation grows past a watermark, Memory River doesn't truncate the old turns — it **distills** them into three layers:

```mermaid
flowchart LR
    C["💬 Conversation"] -->|"watermark crossed"| D["💧 Distill"]
    C -->|"every turn, verbatim"| T["📜 Transcript — long term<br/>append-only + byte-offset index<br/>the permanent record"]
    D --> CAP["🩹 Capsule — short term<br/>recap injected into the next prompt<br/>starts low-health, fades fast"]
    D --> N["📝 Notes — medium term<br/>granular, self-contained facts<br/>persist; decay slowly"]
    CAP -.->|"sourceEntryIds"| T
    N -.->|"sourceEntryIds"| T
    N ==>|"recall (automatic, cheap)"| A["🤖 Agent"]
    T ==>|"rehydrate (precise, on demand)"| A
```

- **Short term — the session capsule.** A compact recap of what just happened, injected at the top of the next prompt. It starts at low health and **metabolizes fast** — this is working memory for *this* session, not a fact store. The capsule is domain-adaptive: a coding session gets a structured task summary; a casual chat gets a natural-language recap.
- **Medium term — distilled notes.** Alongside each capsule, a handful of granular, self-contained facts are extracted and written to the store. They start at full health and **persist** — this is what `recall` surfaces days later.
- **Long term — the raw transcript.** Every turn is archived verbatim with a byte-offset index, and the capsule records exactly which turns it summarized — **so compression never truly loses anything.**

---

## 🔍 Two-pass retrieval + gap-aware rehydrate

Vector retrieval **always loses precision**. Memory River's answer isn't to cram every detail into the vector — it's to let the agent **know its recall isn't precise enough and go back to the source on its own**:

1. **Coarse recall (automatic, cheap).** Before each turn, `assembleContext` injects the few most relevant memories. Always on.
2. **Rehydrate (precise, on demand).** A lossy memory carries pointers back to its source turns — the agent pulls the exact original turns by **entry-id / time window / keyword**.

The leverage is the agent's **judgment**: treat recall as *candidate evidence*, not the answer; decide whether it's precise enough; if not, go straight to the source via the most reliable `entry_ids`, falling back to keyword search on concrete entities only when recall comes up empty; **retrieving something ≠ success** (verify the source actually contains the answer); only say "I don't know" after escalating across strategies. This disposition is agent-agnostic and can be dropped into any host agent — see [`docs/AGENT_MEMORY_SYSTEM_PROMPT.md`](docs/AGENT_MEMORY_SYSTEM_PROMPT.md).

> The common case stays cheap (you don't reload the whole conversation every turn), precise detail is never more than one hop away, and the whole chain is **auditable**.

---

## 🧬 Memory that metabolizes

Memories aren't write-once rows — they **live**. Health decays linearly by `0.15 × elapsed hours × max(0.2, 1 − 0.01 × accessCount)` points per sweep. From 100 health with no accesses, that is about 28 days to zero; the access factor can slow it, and active non-skill v2 capsules decay at one quarter speed. Core categories (`identity`, `preference`, `constraint`, `business`, `decision`, `core_rule`), memories with importance ≥ 0.75 (except dynamic capsules), and skill capsules are excluded from decay. Retrieval only boosts health in Retriever paths that enqueue a boost (accepted/partial candidates and entity-synergy merges); loading an eligible non-core skill also boosts it. `engine.recall()` searches and reranks without boosting health:

```mermaid
flowchart LR
    W["✍️ Written<br/>full health"] --> L["🫀 Alive"]
    L -->|"selected retrieval / skill load → boost;<br/>access count slows decay"| L
    L -->|"long disuse → decays"| Z["💤 Health = 0"]
    L -->|"contradicted / superseded"| DEP["🪦 Deprecated<br/>supersededBy chain"]
    Z --> TR["🗑️ Trash<br/>retention window"]
    TR --> P["Purged"]
    NC["🌙 Night consolidation"] -->|"merge duplicates,<br/>re-score, prune junk"| L
```

A newer fact can supersede a close older one; conflict detection only checks `preference`, `constraint`, `identity`, and `decision`, and accepts a structured JSON `{"conflict": boolean}` verdict. Night consolidation marks the source `deprecated` when a merge is applied, after subject/cardinality compatibility checks; its separate `deprecated` decision can also mark stale or redundant memories without a merge. Memories reaching zero and expired `trashed` rows are copied through JSON trash and retained for 7 days before purge. An SSD write failure is retried by syncing RAM after SSD recovery; startup RAM-to-SSD sync adds or updates rows and does not erase SSD-only rows. WAL recovery is at-least-once, not exactly-once; back up `dataDir` and do not treat this as protection against loss of the data directory and WAL.

---

## 🗺️ Architecture

One engine, many doors. The core is framework-neutral; every host talks to it through an adapter:

```mermaid
flowchart TD
    subgraph Hosts
      OC["OpenClaw agent"]
      CC["Claude Code"]
      MC["Any MCP client"]
      APP["Your app"]
    end
    OC --> AOC["adapter-openclaw<br/>native plugin: hooks + tools"]
    CC --> CCP["claude-code-plugin<br/>push layer: recall-inject + archive hooks"]
    MC --> MCP["adapter-mcp<br/>MCP stdio server"]
    CCP -->|"loopback HTTP"| SRV["mr-serve<br/>127.0.0.1 daemon<br/>+ mr init / mr doctor CLI"]
    AOC --> CORE["core engine<br/>createMemoryRiver()"]
    MCP --> CORE
    SRV --> CORE
    APP -->|"TypeScript API"| CORE
    CORE --> ST[("LanceDB · RAM tier + durable tier<br/>WAL · transcripts · knowledge graph")]
    DASH["mr-dash<br/>read-only web UI"] --> ST
```

| Package | What it is |
|:---|:---|
| [`@memory-river/core`](packages/core/README.md) | The framework-neutral engine and `createMemoryRiver` API: stores, distillation pipeline, retrieval, transcript archive, lifecycle jobs, graph/causal logic, skills, GWM |
| `@memory-river/service` | `mr-serve`, a loopback-only HTTP daemon (`/recall`, `/store`, `/rehydrate`, `/archive-transcript`, `/health`) plus the `mr init` / `mr doctor` onboarding CLI |
| `@memory-river/claude-code-plugin` | The **push layer** for Claude Code: a hook injects relevant memories into every prompt, another archives the session transcript on exit — fail-open, zero config in the editor |
| `@memory-river/adapter-openclaw` | Native OpenClaw plugin (hooks, tools, compaction integration, session archiving) |
| `@memory-river/adapter-mcp` | MCP stdio server exposing memory, transcript, skill, and working-memory tools to any MCP host |
| `@memory-river/dashboard` | `mr-dash`, a read-only LanceDB inspector: CLI reports plus a local web UI (memories / graph / slots / effectiveness) |
| `@memory-river/example-cli` | A ~110-line Ollama-backed integration proving the core works standalone |
| `@memory-river/benchmark` | `mr-bench`: lifecycle, retrieval, CRAG, recovery, LoCoMo, and Chinese-chat evaluation harnesses — the numbers below come from here |

---

## 🚀 Quick Start

**Prerequisites:** Node 22+, and [Ollama](https://ollama.com/) running locally for embeddings (fully local — no cloud account needed):

```bash
ollama pull hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF
```

### Path A — plug it into Claude Code (shortest way to feel it)

```bash
# 0) install the service — provides the `mr` and `mr-serve` commands
npm install -g @memory-river/service

# 1) configure — a 3-question wizard (or --yes for all defaults), then verify the environment
mr init
mr doctor

# 2) start the daemon and keep it running
mr-serve

# 3) wire it into Claude Code
claude plugin marketplace add Hsi431/memory-river
claude plugin install memory-river@memory-river
```

From then on every prompt you type gets relevant long-term memories injected as context, and each session's transcript is archived when it ends. The hooks are **fail-open**: if the daemon is down they silently do nothing — Claude Code never breaks.

`mr init` asks exactly three things: the embedding provider (semi-permanent — switching later means re-indexing), the distillation LLM (or `skip` for [no-key degraded mode](#%EF%B8%8F-durability--operational-honesty)), and the data directory. Config lands in `~/.memory-river/config.json` (mode `0600`). `mr doctor` then checks seven things — config, embedding reachability + dimensions, LLM key, `/dev/shm` space, service port, data dir writability, WAL state — each with a one-line fix hint.

### Path B — standalone, no host at all

The demo CLI lives in the repo (it is not published to npm):

```bash
git clone https://github.com/Hsi431/memory-river && cd memory-river
npm ci && npm run build
ollama pull qwen3:8b   # a small local chat model for the demo

npx mr-demo remember "The deployment window is Friday at 18:00."
npx mr-demo recall "When is deployment?"
npx mr-demo chat
```

Embedded usage, the full API, dependency ports, and porting guidance are in the **[core package docs](packages/core/README.md)**.

### 🔭 See your memories: Web Dashboard

Memory shouldn't be a black box. `mr-dash serve` starts a **read-only** local web UI (bound to `127.0.0.1`, no external calls, never modifies data) so you can inspect a memory-river instance in your browser:

```bash
# keep this terminal open, then open the printed URL in a browser
node packages/dashboard/dist/cli.js serve --db /path/to/lancedb --port 7777
# → http://127.0.0.1:7777
```

Tabs cover **Tables** (row counts), **Effectiveness** (per-subsystem stats), **Night** (consolidation runs), plus **Memories / Graph / Slots** for browsing the actual contents (capsule health, knowledge-graph triples, structured slots). A 中文 / EN toggle and a light / dark theme are built in.

### Development

```bash
npm ci
npm run build
npm test -ws
bash scripts/ci-local.sh   # what CI runs: clean-checkout simulation → build → typecheck → all tests
```

---

## 📊 Results — LoCoMo, the full set

LoCoMo is the standard long-conversation memory benchmark. We report it the way we'd want to read it: the **full 1,986-question set** (not a sampled subset), a **single run**, scored **end-to-end through a real answering agent** — not a retrieval-only number, and not a benchmark-tuned answerer. The headline covers categories 1–4 (1,539 questions); category 5 (447 questions) is reported separately below.

| Category | Our judge (no partial credit) |
|:---|---:|
| 1 · multi-hop / enumeration | 44.7% |
| 2 · temporal reasoning | 67.0% |
| 3 · open-domain | 53.1% |
| 4 · single-hop | 76.7% |
| **Overall (cat 1–4)** | **67.3%** |

*Category 5 is adversarial — the "gold" answer is a lure and the correct behaviour is to refuse or correct, so like mem0's protocol we exclude it from the headline and treat it as a separate robustness axis (22.0% under the strict judge on this run; the abstention-accuracy framing reported previously has not been re-measured under the current judge).*

**What changed since the previous published numbers.** The table above is not comparable to the 60.6% we published before, and the difference is not all progress. Two things moved at once:

1. **The judge changed.** The previous numbers were scored by `gemini-2.5-flash`. Google retired the model and both of our keys now return `API_KEY_INVALID`, so the judge is now xAI `grok-4-1-fast-non-reasoning`. A judge swap moves absolute scores on its own.
2. **Retrieval was fixed** (hybrid fusion was never actually sorted by its fused score, and the embedding query prefix was not the model's official instruction template).

To separate the two, we re-ran the **full 1,986-question set twice** — once on the fixed code, once on the code immediately before the fix — with the *same* new judge and the *same* ingested memory snapshot. Only the engine differed:

| | before the fix | after the fix | delta |
|:---|---:|---:|---:|
| Overall (cat 1–4) | 64.5% | **67.3%** | **+2.9pp** |
| All 1,986 questions | 54.9% | 57.2% | +2.2pp |

Paired McNemar on cat 1–4: 95 questions regressed, 139 improved, χ² = 7.90 (p < 0.01).

So of the gap between the old 60.6% and today's 67.3%, roughly **+2.9pp is the engine getting better and the rest is the judge change**. We report it this way because a benchmark number is only worth as much as the protocol printed next to it.

### Benchmark protocol

LoCoMo scores are highly sensitive to the evaluation protocol. Public numbers often mix several moving parts: the memory system, the answering model, the answering prompt, the judge rubric, the context budget, and whether the system is allowed to run a multi-step retrieval loop.

**Memory River reports the conservative score first.** Our main score uses:

- the full LoCoMo set, not a sampled subset
- one fixed general-purpose answering prompt
- one flash-class answer model
- no category-specific routing
- no LoCoMo-tuned answering prompt
- no oracle evidence
- no hidden benchmark-specific retry loop
- end-to-end answers through a live agent loop
- memory writes disabled during evaluation (`MR_OTTER_READONLY` defaults to read-only; set it to `0` to enable writes), so a run can be resumed without the agent mutating the memory base mid-benchmark; both arms of the comparison above ran under the same setting

This is intentionally stricter than the common leaderboard-style setup. It measures Memory River as a general memory engine embedded in a real agent, not as a benchmark-specialized answering pipeline.

We have also reported a mem0-style LLM-as-judge score on the exact same generated answers. This does not change the agent, the retrieved context, or the model output — only the judge rubric changes, and the rubric alone can move the score dramatically: on the earlier run, the same cat1 answers scored **34.8%** under the strict no-partial-credit judge and **84.8%** under the mem0-style rubric. This is why LoCoMo numbers should not be compared without the full evaluation protocol.

Under the mem0-style rubric (the prompt is copied verbatim from `mem0ai/memory-benchmarks`), Memory River reached **79.9%** on cat1–4 on the earlier Gemini-judged run. That historical scoring counted all 17 judge parse failures as wrong (17 of 1,539); current reporting separates parse failures. **That rubric pass has not been re-run since the judge and the retrieval fix changed, so we are not restating it as a current number.** We treat it as a public-compatible comparison figure, not the primary engineering score — the primary number remains the stricter end-to-end score.

The point isn't a leaderboard trick — it's to make the tradeoff visible:

- **strict score** — what the agent actually answered correctly
- **mem0-style score** — how the same answers look under a common public rubric
- **architecture** — a framework-neutral, self-hostable memory engine, not a hosted retrieval service or a benchmark-tuned agent stack

Which is why this table can't be read on the score alone — you also have to read what the system was allowed to do.

---

## 🛡️ Durability & operational honesty

What's actually guaranteed, and what isn't — read this before trusting it with data you can't lose:

- **WAL, at-least-once.** `update` / `delete` / `batch_update` are logged to a write-ahead log before committing. After a crash, recovery **rolls the log forward idempotently**: everything that was acknowledged survives, and an operation that was still in flight — **including a delete that was never acknowledged** — may also be applied. The semantics are at-least-once by design; exactly-once is not claimed.
- **Crash-consistent writes.** A store write lands atomically or not at all — killing the process mid-write (tested with `SIGKILL`) leaves no partial rows.
- **Two tiers, one source of truth.** The durable tier (`dataDir`) is the source of truth; the RAM tier is a fast working copy. `storageMode: auto | ram | ssd` — `auto` checks free space on `/dev/shm` at startup and, if it can't hold the dataset, falls back to a single durable table on SSD (the reason is logged; override with `storageMode: ram`). **Back up `dataDir`**; nothing else needs backing up.
- **Transcript retention is bounded.** Transcript files rotate at 5 MB and the **10 most recent generations** per session are kept; older ones are deleted. Rehydrate reads across generations transparently, but the verbatim history is finite — "long term" means long, not infinite.
- **Single machine, single daemon.** One live process per data directory, enforced by a file-level takeover lock (a lock left by a dead process is taken over safely; two live processes are not supported). No replication, no distributed mode.
- **No LLM key? Degraded, not broken.** Without any LLM key, distillation is skipped (explicitly logged) — transcript archiving and recall keep working. You lose automatic capsule/note extraction, nothing else.

---

## 🔒 Security

- **Loopback only.** `mr-serve` binds `127.0.0.1` exclusively and has no authentication — it is for trusted local clients. Don't reverse-proxy it onto a network.
- **Local by default.** Embeddings run on your machine via Ollama; memory content leaves the machine only if you *choose* a cloud LLM for distillation (that text goes to that provider — pick `skip` at `mr init` if that's unacceptable).
- **Validated inputs.** Session keys are validated before any file path is derived from them; the onboarding config is written with mode `0600`.
- **Validated LLM output.** Night-consolidation decisions produced by the LLM are runtime-checked field by field (action, target ids, confidence bounds); anything malformed is skipped and logged, never applied.
- **Read-only inspection.** The dashboard never mutates data and binds to loopback.

---

## 🏗️ How it's built

| Subsystem | What it does | Module |
|:---|:---|:---|
| Dual-tier store + WAL | RAM dir (tmpfs-friendly) for hot reads, data dir for durability, write-ahead log with crash recovery | `store/store-v4` |
| Distillation pipeline | Old turns are summarized into a capsule + granular notes, written through an async inbox — **writes never block the conversation** | `distill/concentrator-adapter` + `pipeline/inbox-watcher` |
| Transcript + rehydrate | Verbatim turn archive with a byte-offset `.idx`; recover exact turns by entry-id / time / keyword | `transcript/` |
| Hybrid retrieval | Vector + full-text BM25, RRF fusion, optional local rerank (CRAG-style accept/partial/reject, tuned recall-safe), EntitySynergyMerger (NER fragment rescue), structured-slot dedup, causal-chain expansion | `retrieval/retriever-v4` |
| Knowledge graph | Triple (subject–relation–object) store with vector + FTS entity search, used to expand hook/query coverage | `store/graph-store` |
| Memory metabolism | Linear health decay; Retriever paths and skill loads boost health; zero-health and expired trashed rows use 7-day JSON trash retention | `lifecycle/cleanup-engine` + `store/store-v4` |
| Night consolidation | Periodic offline pass that merges and compresses related memories | `lifecycle/night-consolidation` |
| Associative hooks | Memories carry trigger keywords that fire related recalls; a feedback loop reweights hooks by hit quality | `cognition/hooks-engine` |
| Causal + conflict | Conflict detection checks `preference` / `constraint` / `identity` / `decision` using structured JSON verdicts; merge deprecations require subject/cardinality compatibility | `cognition/causal-engine` + `conflict-detector` |
| Structured slots | Extracts structured params (slotKey/slotValue) at write time with a version chain; retrieval returns only the latest active per slot | `pipeline/inbox-watcher` + `retrieval/retriever-v4` |
| Global Working Memory (GWM) | Tracks the long-conversation task; embedding drift detection nudges the agent back on topic | `cognition/global-working-memory` |
| Skill capsules v2 | Explicitly saved procedures with progressive disclosure: a one-line index is injected, full steps load on demand | `engine` + `skills/` |
| Ralph Loop | Context circuit-breaker: on repeated failures it trims/truncates context and injects warnings to keep context from blowing up | `cognition/ralph-core` |
| Observability | Every subsystem writes best-effort stats rows you can audit later | throughout |

---

## 🔬 The subsystems, up close

### 🏗️ Dual-tier store + WAL — _writes don't drop, reads don't stall_
The hot tier lives in a writable RAM dir (point it at tmpfs / `/dev/shm` on Linux for millisecond reads), the durable tier on a data dir. `update` / `delete` / `batch_update` write a **write-ahead log** before committing; replay is idempotent, and a failed replay keeps the log for the next attempt. LanceDB writes use jittered exponential backoff; repeated SSD failures degrade gracefully to RAM-only and retry later. It does **not** claim exactly-once or zero data loss — treat the data dir as application state and back it up. `store/store-v4`

### 💧 Concentrator — _compaction isn't dropping, it's distilling_
When a conversation passes a **dynamic watermark** (adaptive by conversation mode — coding, general, casual each have a different threshold; tool noise is excluded from the estimate), old turns are distilled into a **two-track** product: one short-term **capsule** (the recap injected at the top of the next prompt) plus a few **granular notes** (durable facts written to the store). Note extraction follows principled rules — keep only durable, queryable, future-useful facts; drop pleasantries, meta, one-offs — and empty capsules (self-referential LLM filler) are detected and downgraded. Provider selection / retries / fallback live in the **`LlmClient` you inject** — core deliberately ships no multi-provider chain. `distill/concentrator-adapter`

### 📜 Transcript + Rehydrate — _the bedrock insurance under compaction_
Every turn is archived to an append-only JSONL with a byte-offset `.idx` sidecar (O(1) seek once you have an entryId) and automatic rotation. Capsules and notes record which turns they summarized (`sourceEntryIds`), so a lossy memory can be **restored**: `memory_rehydrate` supports entry-id (most precise), time window, and keyword (ranked-OR) modes. This is the floor under "lossy memory + gap-aware recall" (see [Two-pass retrieval](#-two-pass-retrieval--gap-aware-rehydrate)). `transcript/`

### 🔍 Retriever — _layered filtering, only what's worth reading_
Recall isn't a plain vector search: **Hybrid** (vector + full-text BM25 + RRF fusion) → **Hooks** (associative + knowledge-graph semantic expansion) → **EntitySynergyMerger** (when several memories each hold part of a fact, NER + IDF-weighted Jaccard stitches the fragments back together — pure local, zero LLM tokens) → **CRAG quality gate** (accept/partial/reject, tuned to the recall-safe side: only blocks the clearly-irrelevant, never culls near-matches) → **structured-slot dedup** (latest active per slot) → **causal-chain expansion**. `retrieval/retriever-v4`

### 📊 GraphStore — _knowledge as triples_
Relationships in memories are extracted into `subject–relation–object` triples and stored separately (e.g. `Alice –is CEO of– ArtiMart`); triple text is auto-vectorized for ANN semantic search and the subject field gets FTS entity search. At retrieval time it feeds the Hooks engine's semantic query expansion, pulling related entities in together. `store/graph-store`

### 🧬 Causal Engine — _memory is a causal chain, not loose fragments_
On write, it classifies a new memory's relation to existing ones: `UPDATE` (close enough + lexical overlap → old memory deprecated, new one inherits `parentId`), `CAUSAL` (medium distance → causal link, both coexist), or `INDEPENDENT` (unrelated). It only makes the pure-function decision; the actual update/deprecate is handed to the inbox / StatusManager. Thresholds are computed from embedding dimensionality and auto-relaxed within the same category. `cognition/causal-engine`

### ⚡ Conflict Detector — _forgetting on purpose, like a brain_
Modeled on retrieval-induced forgetting: it only fires for `preference` / `constraint` / `identity` / `decision`, scans similar same-category memories after a write, and accepts a structured JSON object with boolean `conflict` from the LLM → the conflicting memory is deprecated with a `supersededBy` chain. Invalid output or a failed judgment defaults to coexistence. `cognition/conflict-detector`

### 🎯 Structured Slot — _exact params you don't have to remember_
On write it auto-extracts structured params (e.g. "change the SSH port to 2222" → `slotKey=technical:ssh_port, slotValue=2222`), gated on confidence (low confidence degrades to free text). Each slotKey keeps a version chain — old value deprecated, new value active — and retrieval returns only the latest active per slot, so stale and fresh values never appear side by side. `pipeline/inbox-watcher` + `retrieval/retriever-v4`

### 🎣 Hooks Engine — _an associative net, reminded by context_
Not keyword matching — LLM-generated **concept triggers** (good hook: "report writing spec"; bad hook: "report"). Three weight tiers, with a **quality feedback loop**: a hook fires → the CRAG outcome is reported back → its weight is adjusted, and hooks that stay ineffective are pruned. Associations that help get strengthened; ones that mislead get weakened — fire together, wire together. `cognition/hooks-engine`

### 🌀 Global Working Memory (GWM) — _short-term goal that doesn't drift_
Tracks the long conversation's main goal and detects topic drift each turn via embedding cosine, injecting a nudge to pull the agent back when it wanders; injection control prevents per-turn repetition and the state persists across restarts. Tools: `gwm_on/off/status/update`. `cognition/global-working-memory`

### 🫀 Health System — _memory has a lifecycle_
Health decays linearly by `0.15 × elapsed hours × max(0.2, 1 − 0.01 × accessCount)` points per sweep (100 health reaches zero in about 28 days with no accesses); active non-skill v2 capsules decay at one quarter speed. Core categories (`identity` / `preference` / `constraint` / `business` / `decision` / `core_rule`), importance ≥ 0.75 except dynamic capsules, and skill capsules are excluded from decay. Retriever paths that enqueue boosts and eligible non-core skill loads raise health; `engine.recall()` searches and reranks without boosting. At zero, rows pass through JSON trash for 7 days before purge; expired `trashed` rows follow the same route. `lifecycle/cleanup-engine` + `store/store-v4`

### 🌙 Night Consolidation — _the AI's sleep_
A periodic offline pass scans memories and an LLM decides `keep` / `merge` / `delete` / `update` / `deprecated` per item; merge deprecates the source only after subject/cardinality compatibility checks. The separate `deprecated` action means stale or redundant and is not limited to merge. Decisions are runtime-validated before application. `lifecycle/night-consolidation`

### 🧹 Cleanup Engine — _time-driven garbage collection_
**Time-driven first** (a daily schedule plus a startup recovery run if too long has passed since the last sweep), with session-end as a secondary trigger — so it still works for long conversations that never fire a session-end. Handles the decay sweep, soft-delete, and trash-expiry purge. `lifecycle/cleanup-engine`

### 💊 Skill Capsule v2 — _explicitly saved, reusable procedures_
Skills are procedures the agent **explicitly saves** (the system never auto-generates them): progressive disclosure — only a one-line index is injected (zero token cost) and the agent calls `skill_load` to pull the full steps. Honest usage stats (only `load` increments `usageCount` — being injected doesn't count), a deterministic quality gate (malformed defs rejected with every violation listed at once, no LLM judging), and decay 4× slower than ordinary memories. `engine` + `skills/`

### 🛡️ Ralph Loop — _context circuit-breaker_
On repeated failures: first trim the trailing error messages and retry → then inject a structured warning and shrink context → if it still fails, physically truncate context and return a safe response; success auto-resets. Keeps context from blowing up inside an error loop. `cognition/ralph-core`

---

## 🎯 Positioning

- **Chinese-first.** Distillation, retrieval (jieba-tokenized FTS), and rehydrate are all tuned for Chinese — most memory layers are English-first with weak Chinese quality, and this is the niche we deliberately hold. English is the floor (it doesn't regress), not the target.
- **Self-hostable / private.** Embeddings are fully local (Ollama), storage is local (LanceDB) — you never hand your memories to a third-party cloud.
- **Framework-neutral.** The core engine isn't bound to any host; `createMemoryRiver` takes your own embedding and LLM providers. Ships with an OpenClaw adapter, an MCP server, a Claude Code plugin, and a ~110-line example-cli proving standalone integration.
- **Honest.** No exactly-once / zero-data-loss claims; capabilities are whatever the code actually does.

---

## 🧭 Status & Roadmap

**Status:** actively dogfooded — Memory River is the live memory layer behind the author's own agents, both as an OpenClaw plugin and as the Claude Code push layer, running daily on real conversations. CI (Node 22/24) gates every change: clean-checkout build, typecheck across all workspaces, full test suite. APIs may still move before a 1.0.

**Roadmap:**

- a true low-memory single-table mode (today's SSD fallback preserves behaviour but not the dual-tier speed)
- per-category answer-model routing for hosts that want to trade cost for accuracy
- more host adapters and richer push-layer integrations
- continued hardening driven by external code review

---

## 📄 License

**Apache-2.0** © 2026 Hsi431.

Use it, modify it, embed it in your agent, self-host it, ship it commercially — the permissive Apache 2.0 terms apply. See [LICENSE](LICENSE).

<div align="center">
<br>

🌊 *Remembered, not stored — alive.*

</div>
