import assert from 'node:assert/strict';
import test from 'node:test';

// Import after env manipulation; effectiveSystemPrompt reads process.env at call time.
import { effectiveSystemPrompt } from '../../agent/otter.js';

const HINT_SUFFIX =
  'When the user asks for a list, examples, "what are", or "which", the retrieved evidence may contain multiple distinct supported items. ' +
  'Do not stop after the first matching item. ' +
  'List all distinct items that are supported by the retrieved evidence. ' +
  'Do not invent items not supported by memory; if evidence is insufficient, say so.';

test('arm A (flag unset): effectiveSystemPrompt returns unmodified SYSTEM_PROMPT', () => {
  const saved = process.env.MR_CARDINALITY_HINT;
  try {
    delete process.env.MR_CARDINALITY_HINT;
    const result = effectiveSystemPrompt();
    // Must end with the known tail of SYSTEM_PROMPT (not the hint).
    assert.ok(result.endsWith('Answer concisely.'), `expected to end with 'Answer concisely.' but got: ...${result.slice(-60)}`);
    // Must not contain hint text.
    assert.ok(!result.includes('Do not stop after the first matching item'), 'arm A must not contain cardinality hint');
  } finally {
    if (saved === undefined) delete process.env.MR_CARDINALITY_HINT;
    else process.env.MR_CARDINALITY_HINT = saved;
  }
});

test('arm A (flag set to other value): effectiveSystemPrompt returns unmodified SYSTEM_PROMPT', () => {
  const saved = process.env.MR_CARDINALITY_HINT;
  try {
    process.env.MR_CARDINALITY_HINT = '0';
    const result = effectiveSystemPrompt();
    assert.ok(result.endsWith('Answer concisely.'));
    assert.ok(!result.includes('Do not stop after the first matching item'));
  } finally {
    if (saved === undefined) delete process.env.MR_CARDINALITY_HINT;
    else process.env.MR_CARDINALITY_HINT = saved;
  }
});

test('arm B (MR_CARDINALITY_HINT=1): result ends with hint and starts with original SYSTEM_PROMPT', () => {
  const saved = process.env.MR_CARDINALITY_HINT;
  try {
    process.env.MR_CARDINALITY_HINT = '1';
    const result = effectiveSystemPrompt();
    // Must end with hint.
    assert.ok(result.endsWith(HINT_SUFFIX), `expected to end with hint but got: ...${result.slice(-120)}`);
    // Original prompt (known prefix) must still be present.
    assert.ok(result.startsWith('Recalled memories are CANDIDATE EVIDENCE'), `expected original SYSTEM_PROMPT prefix`);
    // The two parts must be separated by a blank line.
    assert.ok(result.includes('\n\n'), 'expected blank-line separator between SYSTEM_PROMPT and hint');
    // Original tail must appear before hint.
    const answerIdx = result.indexOf('Answer concisely.');
    const hintIdx = result.indexOf('Do not stop after the first matching item');
    assert.ok(answerIdx < hintIdx, 'original SYSTEM_PROMPT tail must precede hint');
  } finally {
    if (saved === undefined) delete process.env.MR_CARDINALITY_HINT;
    else process.env.MR_CARDINALITY_HINT = saved;
  }
});
