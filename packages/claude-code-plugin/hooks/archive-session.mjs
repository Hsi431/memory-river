#!/usr/bin/env node
import { runArchiveSession } from '../lib/archive.mjs';

let input = '';

try {
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  await runArchiveSession(input);
} catch {
  // Claude Code hooks must fail open.
} finally {
  process.exitCode = 0;
}
