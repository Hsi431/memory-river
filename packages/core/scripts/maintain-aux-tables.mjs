#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as lancedb from '@lancedb/lancedb';

const VERSION_RETENTION_MS = 60 * 60 * 1000;

export async function maintainAuxTables(storePath) {
  const resolvedPath = path.resolve(storePath);
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
    throw new Error(`Store directory not found: ${resolvedPath}`);
  }

  const db = await lancedb.connect(resolvedPath);
  const tableNames = await db.tableNames();
  const auxTableNames = tableNames.filter((name) => name !== 'memories');
  const cleanupOlderThan = new Date(Date.now() - VERSION_RETENTION_MS);

  for (const tableName of auxTableNames) {
    try {
      const table = await db.openTable(tableName);
      await table.optimize({ cleanupOlderThan });
      console.log(`[AuxTableMaintenance] optimized ${tableName}`);
    } catch (err) {
      console.warn(
        `[AuxTableMaintenance] skipped ${tableName}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  console.log(`[AuxTableMaintenance] complete: ${auxTableNames.length} auxiliary table(s)`);
  return auxTableNames;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const storePath = process.argv[2];
  if (!storePath) {
    console.error('Usage: node packages/core/scripts/maintain-aux-tables.mjs <store-directory>');
    process.exitCode = 1;
  } else {
    try {
      await maintainAuxTables(storePath);
    } catch (err) {
      console.error(
        '[AuxTableMaintenance] failed:',
        err instanceof Error ? err.message : String(err),
      );
      process.exitCode = 1;
    }
  }
}
