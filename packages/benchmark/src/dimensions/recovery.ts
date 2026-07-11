import { safeRate } from '../harness/metrics.js';
import {
  makeRecoveryStore,
  makeWal,
  makeWalRow,
  recoverFromWal,
} from '../harness/temp-store.js';
import type { BenchmarkResult } from '../report.js';

const ID_UNCOMMITTED = '50000000-0000-4000-8000-000000000001';
const ID_COMMITTED = '50000000-0000-4000-8000-000000000002';
const ID_DEGRADED = '50000000-0000-4000-8000-000000000003';

function monotonic(values: number[]): boolean {
  return values.every((value, index) => index === 0 || value >= values[index - 1]);
}

function approximatelyEqual(left: number | undefined, right: number | undefined): boolean {
  return left !== undefined && right !== undefined && Math.abs(left - right) < 1e-6;
}

export async function runRecoveryBenchmark(): Promise<BenchmarkResult> {
  let committedExpected = 0;
  let committedRecovered = 0;
  let phantomExpected = 0;
  let phantomAbsent = 0;
  let consistentExpected = 0;
  let consistentRecovered = 0;
  const checkpointSequences: number[][] = [];

  const uncommittedRow = makeWalRow(ID_UNCOMMITTED, 'appended but uncommitted');
  const uncommittedWal = makeWal([
    { action: 'insert', id: ID_UNCOMMITTED, row: uncommittedRow, txnId: 1, timestamp: 1 },
  ]);
  try {
    const recovery = makeRecoveryStore(uncommittedWal.walPath);
    await recoverFromWal(recovery.store);
    phantomExpected++;
    if (
      recovery.getRamRows().filter(row => row.id === ID_UNCOMMITTED).length === 1
      && recovery.getSsdRows().filter(row => row.id === ID_UNCOMMITTED).length === 1
    ) phantomAbsent++;
    checkpointSequences.push(recovery.checkpoints);
  } finally {
    uncommittedWal.cleanup();
  }

  const committedRow = makeWalRow(ID_COMMITTED, 'committed insert');
  const committedWal = makeWal([
    { action: 'insert', id: ID_COMMITTED, row: committedRow, txnId: 2, timestamp: 1 },
    { action: 'commit', id: ID_COMMITTED, txnId: 2, timestamp: 2 },
  ]);
  try {
    const recovery = makeRecoveryStore(committedWal.walPath);
    await recoverFromWal(recovery.store);
    committedExpected++;
    consistentExpected++;
    const inRam = recovery.getRamRows().some(row => row.id === ID_COMMITTED);
    const inSsd = recovery.getSsdRows().some(row => row.id === ID_COMMITTED);
    if (inRam && inSsd) {
      committedRecovered++;
      consistentRecovered++;
    }
    checkpointSequences.push(recovery.checkpoints);
  } finally {
    committedWal.cleanup();
  }

  const staleRow = makeWalRow(ID_DEGRADED, 'stale before SSD failure');
  const degradedWal = makeWal([
    { action: 'update', id: ID_DEGRADED, values: { importance: 0.9 }, txnId: 3, timestamp: 1 },
    { action: 'commit', id: ID_DEGRADED, txnId: 3, timestamp: 2 },
  ]);
  try {
    const recovery = makeRecoveryStore(degradedWal.walPath, {
      checkpoint: 3,
      ssdFailOnceForId: ID_DEGRADED,
      ramRows: [{ ...staleRow, importance: 0.9 }],
      ssdRows: [staleRow],
    });
    await recoverFromWal(recovery.store);
    const walRetainedAfterFailure = degradedWal.read().length > 0;
    await recoverFromWal(recovery.store);
    committedExpected++;
    consistentExpected++;
    const ramRow = recovery.getRamRows().find(row => row.id === ID_DEGRADED);
    const ssdRow = recovery.getSsdRows().find(row => row.id === ID_DEGRADED);
    if (
      approximatelyEqual(ramRow?.importance, 0.9)
      && approximatelyEqual(ssdRow?.importance, 0.9)
    ) committedRecovered++;
    if (
      walRetainedAfterFailure
      && approximatelyEqual(ramRow?.importance, ssdRow?.importance)
    ) consistentRecovered++;
    checkpointSequences.push(recovery.checkpoints);
  } finally {
    degradedWal.cleanup();
  }

  return {
    dimension: 'recovery',
    metrics: {
      no_loss_rate: safeRate(committedRecovered, committedExpected),
      no_phantom_rate: safeRate(phantomAbsent, phantomExpected),
      checkpoint_monotonic: Number(checkpointSequences.every(monotonic)),
      ram_ssd_consistency_rate: safeRate(consistentRecovered, consistentExpected),
    },
    details: {
      scenarios: ['appended_uncommitted', 'committed_insert', 'ssd_single_write_failure'],
      committed_expected: committedExpected,
      phantom_expected: phantomExpected,
      checkpoint_sequences: checkpointSequences,
    },
  };
}
