# Changelog

## 2026-11-25 — Core 0.2.9, Service 0.2.1, MCP adapter 0.2.1

### Highlights

- **Core:** Improved recovery and consistency across RAM/SSD storage and concurrent slot updates; transcript and decay processing now scans the full stored data set.
- **Service:** Tightened loopback HTTP request handling and body limits, hardened service lock startup/shutdown, and aligned `mr init` / `mr doctor` configuration resolution.
- **MCP adapter:** Added read-only gates for write tools; recall, rehydrate, and loaded skills now mark returned memory as untrusted. Rehydrate validates session keys, and archive accepts only user/assistant messages.

### Compatibility and evaluation

- `memory_recall` now returns `{ notice, result }` instead of a bare array. HTTP `/recall` keeps its `results` array, while its `block` contains the same wrapped payload.
- The benchmark agent now enables `MR_OTTER_READONLY` by default. Set it to `0` to allow benchmark memory writes.
- `answer_accuracy` now excludes judge parse failures; the failures are reported separately. Scores using the previous denominator are not directly comparable.
