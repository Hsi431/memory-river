import * as fs from 'node:fs';
import * as path from 'node:path';

export const CLEANUP_RECOVERY_INTERVAL_MS = 25 * 60 * 60 * 1000;

export interface CleanupState {
  lastSuccessfulRunAt: number;
  lastDeleteCount: number;
  lastDecayCount: number;
}

export interface StartupRecoveryLimits {
  maxStartupDelete: number;
  maxStartupDecay: number;
}

export type StartupRecoveryDecision =
  | { shouldRun: true; reason: 'missing-state' | 'stale-state'; hoursSinceLastSuccess: number | null }
  | { shouldRun: false; reason: 'recent-success'; hoursSinceLastSuccess: number };

export type StartupRecoveryMode =
  | { dryRunOnly: true; maxDelete: number; maxDecay: number; reason: 'backlog-too-large' }
  | { dryRunOnly: false; maxDelete: number; maxDecay: number; reason: 'normal' | 'capped' };

export function readCleanupState(filePath: string): CleanupState | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<CleanupState>;
    if (typeof parsed.lastSuccessfulRunAt !== 'number') return null;
    return {
      lastSuccessfulRunAt: parsed.lastSuccessfulRunAt,
      lastDeleteCount: typeof parsed.lastDeleteCount === 'number' ? parsed.lastDeleteCount : 0,
      lastDecayCount: typeof parsed.lastDecayCount === 'number' ? parsed.lastDecayCount : 0,
    };
  } catch (err: any) {
    console.warn('[CleanupEngine] cleanup-state read failed:', err?.message ?? err);
    return null;
  }
}

export function writeCleanupState(state: CleanupState, filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

export function shouldRunStartupRecovery(
  state: CleanupState | null,
  nowMs: number = Date.now(),
): StartupRecoveryDecision {
  if (!state) {
    return { shouldRun: true, reason: 'missing-state', hoursSinceLastSuccess: null };
  }

  const elapsedMs = nowMs - state.lastSuccessfulRunAt;
  const hoursSinceLastSuccess = Math.max(0, elapsedMs / (60 * 60 * 1000));
  if (elapsedMs < CLEANUP_RECOVERY_INTERVAL_MS) {
    return { shouldRun: false, reason: 'recent-success', hoursSinceLastSuccess };
  }
  return { shouldRun: true, reason: 'stale-state', hoursSinceLastSuccess };
}

export function chooseStartupRecoveryMode(
  estimatedDelete: number,
  limits: StartupRecoveryLimits,
): StartupRecoveryMode {
  const maxDelete = Math.max(0, Math.floor(limits.maxStartupDelete));
  const maxDecay = Math.max(0, Math.floor(limits.maxStartupDecay));
  if (estimatedDelete > maxDelete * 2) {
    return { dryRunOnly: true, maxDelete, maxDecay, reason: 'backlog-too-large' };
  }
  return {
    dryRunOnly: false,
    maxDelete,
    maxDecay,
    reason: estimatedDelete > maxDelete ? 'capped' : 'normal',
  };
}
