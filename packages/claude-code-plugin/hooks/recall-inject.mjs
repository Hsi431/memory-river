#!/usr/bin/env node
import { runRecallInject } from '../lib/recall.mjs';

let input = '';

try {
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  const output = await runRecallInject(input);
  if (output) {
    process.stdout.write(output);
  }
} catch {
  // Claude Code hooks must fail open.
} finally {
  process.exitCode = 0;
}
