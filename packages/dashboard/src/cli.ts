#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

import { runEffectiveness, type EffectivenessOptions } from './effectiveness.js';
import { runExport } from './export.js';
import { runNight } from './night.js';
import { startDashboardServer } from './serve.js';
import { runTables } from './tables.js';

function usage(): void {
  console.error(`Usage:
  mr-dash tables --db <path>
  mr-dash effectiveness --db <path> [--since Nh|Nd|Nm|all] [--subsystem a,b] [--raw N] [--meta [k1,k2]]
  mr-dash night --db <path> [--since Nh|Nd|Nm|all]
  mr-dash export --db <path> --out <output-file>
  mr-dash serve --db <path> [--port N]`);
}

function takeValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  argv.splice(index, 2);
  return value;
}

function extractDb(argv: string[]): string {
  const index = argv.indexOf('--db');
  if (index === -1) throw new Error('--db is required');
  const dbPath = takeValue(argv, index, '--db');
  if (argv.includes('--db')) throw new Error('--db may only be specified once');
  return dbPath;
}

function parseEffectiveness(argv: string[]): EffectivenessOptions {
  const args: EffectivenessOptions = {
    since: '24h',
    subsystem: null,
    raw: 0,
    meta: false,
    metaKeys: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--since') {
      args.since = takeValue(argv, i, '--since');
      i--;
    } else if (arg === '--subsystem') {
      const value = takeValue(argv, i, '--subsystem');
      args.subsystem = value.split(',').map(item => item.trim()).filter(Boolean);
      if (args.subsystem.length === 0) throw new Error('--subsystem requires at least one subsystem');
      i--;
    } else if (arg === '--raw') {
      const value = Number(takeValue(argv, i, '--raw'));
      if (!Number.isInteger(value) || value < 0) throw new Error('--raw requires a non-negative integer');
      args.raw = value;
      i--;
    } else if (arg === '--meta') {
      args.meta = true;
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args.metaKeys = next.split(',').map(item => item.trim()).filter(Boolean);
        if (args.metaKeys.length === 0) throw new Error('--meta key list cannot be empty');
        argv.splice(i, 2);
      } else {
        argv.splice(i, 1);
      }
      i--;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.meta && args.raw <= 0) throw new Error('--meta must be used with --raw N');
  return args;
}

function parseNight(argv: string[]): { since: string } {
  let since = '7d';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--since') {
      since = takeValue(argv, i, '--since');
      i--;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { since };
}

function parseServe(argv: string[]): { port: number } {
  let port = 7777;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') {
      port = Number(takeValue(argv, i, '--port'));
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error('--port requires an integer from 1 to 65535');
      }
      i--;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { port };
}

function parseExport(argv: string[]): { outputPath: string } {
  const index = argv.indexOf('--out');
  if (index === -1) throw new Error('--out is required');
  const outputPath = takeValue(argv, index, '--out');
  if (argv.includes('--out')) throw new Error('--out may only be specified once');
  if (argv.length > 0) throw new Error(`unknown argument: ${argv[0]}`);
  return { outputPath };
}

export async function runCli(input: string[]): Promise<number> {
  try {
    const [command, ...argv] = input;
    if (!command || command === '--help' || command === '-h') {
      usage();
      return command ? 0 : 1;
    }

    const dbPath = extractDb(argv);
    if (command === 'tables') {
      if (argv.length > 0) throw new Error(`unknown argument: ${argv[0]}`);
      await runTables(dbPath);
      return 0;
    }
    if (command === 'effectiveness') {
      await runEffectiveness(dbPath, parseEffectiveness(argv));
      return 0;
    }
    if (command === 'night') {
      await runNight(dbPath, parseNight(argv));
      return 0;
    }
    if (command === 'export') {
      const { outputPath } = parseExport(argv);
      await runExport(dbPath, outputPath);
      return 0;
    }
    if (command === 'serve') {
      const { port } = parseServe(argv);
      const started = await startDashboardServer(dbPath, port);
      console.log(started.url);
      return 0;
    }
    throw new Error(`unknown command: ${command}`);
  } catch (error) {
    console.error(`mr-dash: ${error instanceof Error ? error.message : String(error)}`);
    usage();
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runCli(process.argv.slice(2));
}
