# memory-river Claude Code plugin

Claude Code plugin that connects local `mr-serve` to Claude Code hooks.

- `UserPromptSubmit` calls `/recall` and injects long-term memory as additional context.
- `SessionEnd` parses the Claude Code transcript JSONL and posts user/assistant text to `/archive-transcript`.

The hooks are fail-open: daemon errors, timeouts, bad input, and cache failures exit `0` without writing hook-breaking output.

## Install shape

```text
packages/claude-code-plugin/
  .claude-plugin/plugin.json
  hooks/hooks.json
  hooks/recall-inject.mjs
  hooks/archive-session.mjs
```

Set `MEMORY_RIVER_URL` to override the default `http://127.0.0.1:4791`.

## Install (local marketplace)

The repo root ships `.claude-plugin/marketplace.json`, so the checkout itself is a marketplace:

```sh
claude plugin marketplace add /path/to/memory-river
claude plugin install memory-river@memory-river
```

The hooks are inert (fail-open, silent) unless an `mr-serve` daemon is listening — start one with
`npx mr-serve` or the systemd unit example in `packages/service/README.md`.

## Test

```sh
npm test --workspace=packages/claude-code-plugin
```
