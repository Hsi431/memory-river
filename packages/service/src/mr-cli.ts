#!/usr/bin/env node

import { DOCTOR_TEXT, runDoctor } from './doctor.js';
import { INIT_TEXT, runInit } from './onboarding.js';

const CLI_TEXT = { usage: 'Usage: mr init [--yes] | mr doctor' } as const;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'init') {
    if (args.some(arg => arg !== '--yes')) throw new Error(INIT_TEXT.usage);
    await runInit({ yes: args.includes('--yes') });
    return;
  }
  if (command === 'doctor') {
    if (args.length > 0) throw new Error(DOCTOR_TEXT.usage);
    process.exitCode = await runDoctor();
    return;
  }
  throw new Error(CLI_TEXT.usage);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
