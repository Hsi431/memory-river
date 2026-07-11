# Memory River Benchmark

This private workspace package measures memory-system quality across two phases:

- **B1 (CI-safe, deterministic):** three mechanism-correctness dimensions —
  memory lifecycle, evidence rehydration, and WAL recovery. No external APIs, no
  dataset downloads, fully reproducible.
- **B2 (not CI):** retrieval quality on a synthetic bilingual fixture, comparing
  four retriever paths and (optionally) answer accuracy via an LLM judge. Needs a
  local Ollama embedder, and a DeepSeek API key for the judge.
- **B2b (not CI):** LoCoMo long-conversation answer accuracy through the shipped
  Gemini-to-DeepSeek concentration pipeline, real recall, and a DeepSeek judge.

## B1 Synthetic Data Assumptions

- The fake embedder is deterministic, 256-dimensional, hash-based, and
  L2-normalized. B1 queries repeat the target memory text, so semantic embedding
  quality is intentionally not part of these scores.
- Lifecycle fixtures include two independently protected memories (one protected
  by category, one by importance), two low-value stale memories, and matched
  normal/active-v2 rows with identical starting health and elapsed time.
- Lifecycle cleanup runs twice. The initial 400-hour interval is long enough to
  distinguish the configured `skillDecayFactor=0.25` without forcing the normal
  control below the deletion threshold.
- Supersession is checked through two real high-level saves of the same skill
  name. The second ID must be active and the public list must expose one version.
- Evidence fixtures use distinct operational facts. Each memory stores an
  absolute `path:line` pointer where the line number equals the transcript
  `entryId`; recall must return the exact inserted memory before it is scored.
- Content consistency is mechanical token overlap (at least 80 percent), with no
  LLM judge.
- Recovery covers an uncommitted insert, a committed insert, and a committed
  update whose first SSD replay fails. The degraded case must retain WAL state
  and converge after a second recovery. `no_loss_rate`, `no_phantom_rate`, and
  `ram_ssd_consistency_rate` run the real `MemoryStore.recoverFromWal` logic.
- Scope note: `checkpoint_monotonic` checks that the sequence fed during recovery
  is non-decreasing; the harness stubs `updateWalMetadata` with `Math.max`, so the
  production monotonic-checkpoint guard itself is covered by the core unit test
  (`packages/core/tests/wal-recovery.test.mjs`), not by this metric.

## B2 Retrieval Quality (dimension `retrieval`)

Measures retrieval quality on `datasets/fixtures/retrieval.json`, a pure-synthetic
bilingual (EN/ZH) fixture (no real persons or systems). Each query is tagged by
`kind` (lexical, paraphrase, cjk, cross-session) so the strengths of each path
are visible per category.

- **Real embedder, not the B1 hash embedder.** Memories and queries are embedded
  with the production Qwen3-Embedding model via a local Ollama server. If Ollama
  is unreachable or the model is not pulled, the dimension returns
  `details.skipped = "ollama-unavailable"` instead of failing. This is why B2 is
  not a CI test.
- **Four retriever paths**, each scored with Recall@1/3/5, MRR, and nDCG@5:
  - `vector` — pure vector search (`store.vectorSearch`)
  - `bm25` — pure lexical/FTS search (`store.ftsSearch`)
  - `rrf` — RRF fusion of vector + BM25 (`store.hybridVectorSearch`, the default)
  - `rerank` — RRF + CRAG reranker (`Retriever.hybridSearchWithoutBoost`). The
    "without boost" variant is used so scoring a query does not Hebbian-reinforce
    memory health and bias later queries. The CRAG path downloads a MiniLM model
    (`@xenova/transformers`) on first use into `.cache/reranker/` (gitignored). If
    that path throws, `rerank` is dropped and the other three paths still report.
- **No manual FTS reindex.** The store's init-time FTS index already covers rows
  inserted afterwards. Rebuilding the index (or `optimize()`) through a second
  table handle rewrites the table version underneath the store's live handle and
  corrupts reads, so the dimension deliberately avoids it.
- **Optional answer-level judge.** When `DEEPSEEK_API_KEY` is set, each retrieved
  context is fed to DeepSeek V4 to generate an answer, then a second call grades
  it against the fixture's `expectedAnswer`; `answer_accuracy` is reported per
  path. The judge is reasoning-model aware (reads `message.content`, ignores
  `reasoning_content`), throttled (`DEEPSEEK_CONCURRENCY`, default 3), and retried
  on 429/5xx. A full 4-path sweep of the bundled fixture is ~160 calls and a few
  hundredths of a US dollar. Set `MR_BENCH_NO_JUDGE=1` to skip it.
- **Determinism caveat.** Vector/BM25/RRF results are deterministic for a fixed
  model. Only the LLM judge is non-deterministic, so `answer_accuracy` is the one
  metric that can vary run to run.
- **Cosmetic stderr.** The bare standalone store does not provision every
  subsystem table the full engine has, so the rerank path emits a few caught
  `conflict_stats` / recall-metadata write warnings (some after temp-dir cleanup).
  They are fire-and-forget and do not affect any reported score.

Environment variables: `OLLAMA_URL` (default `http://localhost:11434`),
`MR_BENCH_EMBED_MODEL`, `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`
(default `deepseek-v4-flash`), `DEEPSEEK_CONCURRENCY`, `MR_BENCH_NO_JUDGE`.

## B2b LoCoMo (dimension `locomo`)

LoCoMo exercises the full extraction pipeline rather than storing raw turns.
Each source session is written as host-style JSONL and passed through the public
`compactSessionFile` API with a distinct session key. The harness deliberately
leaves `deps.llm` undefined so the concentrator retains its production
Gemini-to-DeepSeek fallback. It polls public recall after each compaction until
the non-`_SYSTEM_INIT_` memory count stabilizes.

The dataset is gitignored. Fetch it idempotently with:

```sh
node packages/benchmark/scripts/fetch-external.mjs
```

The default run processes one conversation. `--max-questions` provides a
smaller validation sample; omit it to grade every QA item in the selected
conversation. Category 5 is adversarial/unanswerable and is correct only when
the generated answer abstains. Reports include overall answer accuracy,
per-category accuracy, and a best-effort approximate evidence-hit rate.

Requirements:

- Local Ollama with `hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF`.
- Gemini and DeepSeek credentials via `GEMINI_API_KEY` /
  `DEEPSEEK_API_KEY`, or OpenClaw provider `apiKey` entries for `google` and
  `deepseek`.
- Expect roughly $0.30-$0.50 for the default one-conversation run. A full
  10-conversation sweep is intentionally opt-in and may take 1-2 hours.

## Usage

```sh
npm run build -w @memory-river/benchmark

# B1 (deterministic, no external services)
node packages/benchmark/dist/cli.js lifecycle
node packages/benchmark/dist/cli.js evidence --out report.json

# B2 retrieval (needs Ollama; judge needs DEEPSEEK_API_KEY)
MR_BENCH_NO_JUDGE=1 node packages/benchmark/dist/cli.js retrieval     # retrieval-level only
DEEPSEEK_API_KEY=sk-... node packages/benchmark/dist/cli.js retrieval --out report.json

# B2b LoCoMo (defaults to --limit 1)
node packages/benchmark/dist/cli.js locomo --max-questions 5 --out locomo.json
node packages/benchmark/dist/cli.js locomo --limit 1

# Combined sweep (includes external-service dimensions)
node packages/benchmark/dist/cli.js all
```

> `all` includes `retrieval` and `locomo`. LoCoMo still defaults to one
> conversation. The unit tests cover only deterministic logic and inline
> fixtures; they never call Ollama, Gemini, or DeepSeek.
