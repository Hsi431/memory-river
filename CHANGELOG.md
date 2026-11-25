# Changelog

## 2026-11-25 — Core 0.2.10, Service 0.2.2, MCP adapter 0.2.2

### Fixes

- **Core:** LanceDB `query().toArray()` without `.limit()` returns only 10 rows. Every read that needs all rows now pages to the end: the SSD resync after an outage (0.2.9 restored at most 10 rows), hook-bearing memory evaluation, slot version lookups and graph lookups by memory (previously capped at 100). SSD resync gives up after 3 rounds of concurrent writes and stays pending for the next trigger.
- **Core:** Engine no longer crashes at startup when `cleanupEngine` is omitted from the config; night consolidation cannot run twice at once; a stalled daily run no longer stops later runs from being scheduled.
- **Service:** HTTP session keys are validated like the MCP adapter's; `/archive-transcript` rejects messages whose role is not `user` or `assistant`; `mr init` no longer sends the previous API key to a new embedding endpoint and keeps a custom Ollama URL when switching models.
- **Dashboard:** Export and the memories, graph and slots views now include every row instead of the first 10.
- CI rejects unbounded LanceDB `query().toArray()` calls (`scripts/check-lancedb-query-limits.sh`).

## 2026-11-25 — Core 0.2.9, Service 0.2.1, MCP adapter 0.2.1

### Highlights

- **Core:** Improved recovery and consistency across RAM/SSD storage and concurrent slot updates; transcript and decay processing now scans the full stored data set.
- **Service:** Tightened loopback HTTP request handling and body limits, hardened service lock startup/shutdown, and aligned `mr init` / `mr doctor` configuration resolution.
- **MCP adapter:** Added read-only gates for write tools; recall, rehydrate, and loaded skills now mark returned memory as untrusted. Rehydrate validates session keys, and archive accepts only user/assistant messages.

### Compatibility and evaluation

- `memory_recall` now returns `{ notice, result }` instead of a bare array. HTTP `/recall` keeps its `results` array, while its `block` contains the same wrapped payload.
- The benchmark agent now enables `MR_OTTER_READONLY` by default. Set it to `0` to allow benchmark memory writes.
- `answer_accuracy` now excludes judge parse failures; the failures are reported separately. Scores using the previous denominator are not directly comparable.
