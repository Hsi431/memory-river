import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createMemoryRiver,
  type LlmClient,
  type MemoryRiver,
  type MemoryRiverConfig,
} from '@memory-river/core';
import { MemoryStore } from '@memory-river/core/store/store-v4';

import { FakeEmbeddingProvider } from './fake-embedder.js';

const noopLlm: LlmClient = {
  async generate() {
    return '';
  },
};

const quietLogger = {
  info() {},
  warn() {},
  error() {},
};

export interface TempMemoryRiver {
  river: MemoryRiver;
  root: string;
  dataDir: string;
  ramDir: string;
  cleanup(): Promise<void>;
}

export async function createTempMemoryRiver(
  config: Omit<MemoryRiverConfig, 'dataDir' | 'ramDir'> = {},
): Promise<TempMemoryRiver> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-bench-store-'));
  const dataDir = path.join(root, 'data');
  const ramDir = path.join(root, 'ram');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(ramDir, { recursive: true });

  const river = createMemoryRiver(
    { ...config, dataDir, ramDir },
    { embedder: new FakeEmbeddingProvider(), llm: noopLlm, logger: quietLogger },
  );
  await river.start();

  return {
    river,
    root,
    dataDir,
    ramDir,
    async cleanup() {
      await river.stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface WalRow {
  id: string;
  text: string;
  textTokens: string;
  vector: number[];
  importance: number;
  category: string;
  parentId: null;
  metadata: string;
  createdAt: number;
  updatedAt: number;
  confidence: null;
  slotKey: null;
  slotValue: null;
  extractionDomain: null;
  supersedes: null;
  lastConcentratedAt: null;
  sessionId: null;
  status: string;
}

export function makeWalRow(id: string, text: string): WalRow {
  return {
    id,
    text,
    textTokens: text,
    vector: [0.1, 0.2, 0.3, 0.4],
    importance: 0.5,
    category: 'other',
    parentId: null,
    metadata: '{}',
    createdAt: 1,
    updatedAt: 1,
    confidence: null,
    slotKey: null,
    slotValue: null,
    extractionDomain: null,
    supersedes: null,
    lastConcentratedAt: null,
    sessionId: null,
    status: 'active',
  };
}

export function makeWal(entries: object[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-bench-wal-'));
  const walPath = path.join(root, 'wal.jsonl');
  fs.writeFileSync(
    walPath,
    entries.map(entry => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''),
  );
  return {
    walPath,
    read(): any[] {
      const content = fs.readFileSync(walPath, 'utf8').trim();
      return content ? content.split('\n').map(line => JSON.parse(line)) : [];
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function makeTable(
  initialRows: WalRow[],
  onUpdate?: (id: string) => Promise<void>,
) {
  const rows = initialRows.map(row => ({ ...row }));
  return {
    rows,
    async countRows(where?: string) {
      const id = where?.match(/id = '([^']+)'/)?.[1];
      return id ? rows.filter(row => row.id === id).length : rows.length;
    },
    async add(newRows: WalRow[]) {
      rows.push(...newRows.map(row => ({ ...row })));
    },
    async update(values: Partial<WalRow>, { where }: { where: string }) {
      const id = where.match(/id = '([^']+)'/)?.[1] ?? '';
      await onUpdate?.(id);
      const row = rows.find(candidate => candidate.id === id);
      if (row) Object.assign(row, values);
    },
    async delete(where: string) {
      const id = where.match(/id = '([^']+)'/)?.[1];
      const index = rows.findIndex(candidate => candidate.id === id);
      if (index >= 0) rows.splice(index, 1);
    },
    mergeInsert() {
      return {
        whenNotMatchedInsertAll() {
          return this;
        },
        async execute(newRows: WalRow[]) {
          for (const row of newRows) {
            if (!rows.some(candidate => candidate.id === row.id)) rows.push({ ...row });
          }
        },
      };
    },
  };
}

export function makeRecoveryStore(
  walPath: string,
  options: {
    checkpoint?: number;
    ssdFailOnceForId?: string;
    ramRows?: WalRow[];
    ssdRows?: WalRow[];
  } = {},
) {
  let checkpoint = options.checkpoint ?? 0;
  const checkpoints = [checkpoint];
  let ssdFailed = false;
  const ramTable = makeTable(options.ramRows ?? []);
  const ssdTable = makeTable(options.ssdRows ?? [], async id => {
    if (id === options.ssdFailOnceForId && !ssdFailed) {
      ssdFailed = true;
      throw new Error('injected SSD write failure');
    }
  });
  const store = {
    walPath,
    ssdAvailable: true,
    ramTable,
    ssdTable,
    validateId() {},
    async getLastCommittedTxnId() {
      return checkpoint;
    },
    async updateWalMetadata(txnId: number) {
      checkpoint = Math.max(checkpoint, txnId);
      checkpoints.push(checkpoint);
    },
    async rewriteWal(entries: object[]) {
      return (MemoryStore.prototype as any).rewriteWal.call(this, entries);
    },
    async clearWal() {
      return (MemoryStore.prototype as any).clearWal.call(this);
    },
  };

  return {
    store,
    checkpoints,
    getCheckpoint: () => checkpoint,
    getRamRows: () => ramTable.rows,
    getSsdRows: () => ssdTable.rows,
  };
}

export async function recoverFromWal(store: object): Promise<void> {
  await (MemoryStore.prototype as any).recoverFromWal.call(store);
}
