# Otter

Otter is the benchmark's reusable memory-aware agent. It accepts any started
`MemoryRiver` instance, injects the river's own `assembleContext()` auto-recall
output, and lets a DeepSeek function-calling model decide when to use:

- `memory_recall`: full memory retrieval, exposed to the model as bullet text.
- `memory_rehydrate`: exact transcript turns by entry ids, keyword, or time range.

The loop allows four tool rounds and eight calls by default, then makes one
tool-free call to force a final answer if a cap is reached. Entry-id lookup is
provided by the caller so it can target only transcript files whose `.idx`
sidecars contain the requested ids.

Call `runOtter()` with the DeepSeek key/model, the river, the question, session
keys, whole-conversation archive key, and an `.idx`-targeted `rehydrateById`
function.
