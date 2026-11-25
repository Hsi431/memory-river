import * as fs from 'node:fs';

const PROBE_ENV = 'MEMORY_RIVER_COMPACTION_PROBE';
const processStartedAt = Date.now();
let nextEvalId = 0;

type AssembleProbeState = {
  evalId: number;
  inflightAtEntry: number;
  inflightMaxDuring: number;
};

const activeAssembles = new Map<string, Set<AssembleProbeState>>();

export function isCompactionProbeEnabled(): boolean {
  return !!process.env[PROBE_ENV];
}

export interface AssembleProbeHandle {
  readonly evalId: number;
  readonly inflightAtEntry: number;
  get inflightMaxDuring(): number;
  leave(): void;
}

export function beginAssembleProbe(canonicalKey: string): AssembleProbeHandle | null {
  if (!process.env[PROBE_ENV]) return null;

  const active = activeAssembles.get(canonicalKey) ?? new Set<AssembleProbeState>();
  const state: AssembleProbeState = {
    evalId: ++nextEvalId,
    inflightAtEntry: active.size,
    inflightMaxDuring: active.size + 1,
  };
  active.add(state);
  activeAssembles.set(canonicalKey, active);
  for (const other of active) other.inflightMaxDuring = Math.max(other.inflightMaxDuring, active.size);

  let left = false;
  return {
    evalId: state.evalId,
    inflightAtEntry: state.inflightAtEntry,
    get inflightMaxDuring() {
      return state.inflightMaxDuring;
    },
    leave() {
      if (left) return;
      left = true;
      active.delete(state);
      if (active.size === 0) activeAssembles.delete(canonicalKey);
    },
  };
}

export function writeCompactionProbe(record: Record<string, unknown>): void {
  const filePath = process.env[PROBE_ENV];
  if (!filePath) return;
  try {
    fs.appendFileSync(filePath, `${JSON.stringify({
      ts: Date.now(),
      pid: process.pid,
      processStartedAt,
      ...record,
    })}\n`, 'utf8');
  } catch {
    // Probe I/O must never affect compaction behavior.
  }
}
