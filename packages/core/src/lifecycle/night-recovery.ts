import { randomUUID } from 'node:crypto';

export const NIGHT_RECOVERY_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export type NightRecoverySource = 'scheduled_timer' | 'health_check_recovery' | 'startup_recovery';
export type NightRecoverySkipReason = 'recent_run' | 'already_running';
export type NightRecoveryRunReason = 'stale_run' | 'no_success_record';

export type NightRecoveryDecision = {
  shouldRun: boolean;
  reason: NightRecoverySkipReason | NightRecoveryRunReason;
  lastSuccessfulRunTs: number | null;
};

export type NightRecoveryStatInput = {
  runId: string;
  phase: string;
  ts?: number;
  outcome?: string | null;
  metadata?: string | Record<string, unknown> | null;
};

export type NightRecoveryHealthCheckOptions = {
  source: NightRecoverySource;
  isRunning: () => boolean;
  setRunning?: (running: boolean) => void;
  getLastSuccessfulRunTs: () => Promise<number | null>;
  recordStat: (stat: NightRecoveryStatInput) => void;
  runNightConsolidation: (source: NightRecoverySource) => Promise<void>;
  now?: () => number;
  thresholdMs?: number;
  runIdFactory?: () => string;
};

export function buildNightRecoveryMetadata(args: {
  source: NightRecoverySource;
  reason?: NightRecoverySkipReason;
  lastSuccessfulRunTs?: number | null;
  [key: string]: unknown;
}): string {
  const metadata: Record<string, unknown> = { source: args.source };
  for (const [key, value] of Object.entries(args)) {
    if (key === 'source') continue;
    if (value !== undefined && value !== null) metadata[key] = value;
  }
  return JSON.stringify(metadata);
}

export async function shouldRunNow(args: {
  isRunning: boolean;
  lastSuccessfulRunTs: number | null;
  nowMs?: number;
  thresholdMs?: number;
}): Promise<NightRecoveryDecision> {
  if (args.isRunning) {
    return {
      shouldRun: false,
      reason: 'already_running',
      lastSuccessfulRunTs: args.lastSuccessfulRunTs,
    };
  }

  const lastSuccessfulRunTs = args.lastSuccessfulRunTs;
  if (!lastSuccessfulRunTs) {
    return {
      shouldRun: true,
      reason: 'no_success_record',
      lastSuccessfulRunTs: null,
    };
  }

  const nowMs = args.nowMs ?? Date.now();
  const thresholdMs = args.thresholdMs ?? NIGHT_RECOVERY_THRESHOLD_MS;
  if (nowMs - lastSuccessfulRunTs < thresholdMs) {
    return {
      shouldRun: false,
      reason: 'recent_run',
      lastSuccessfulRunTs,
    };
  }

  return {
    shouldRun: true,
    reason: 'stale_run',
    lastSuccessfulRunTs,
  };
}

export async function healthCheck(options: NightRecoveryHealthCheckOptions): Promise<NightRecoveryDecision> {
  const now = options.now ?? Date.now;
  const runIdFactory = options.runIdFactory ?? randomUUID;

  if (options.isRunning()) {
    const decision = await shouldRunNow({
      isRunning: true,
      lastSuccessfulRunTs: null,
      nowMs: now(),
      thresholdMs: options.thresholdMs,
    });
    options.recordStat({
      runId: runIdFactory(),
      phase: 'recovery_skipped',
      ts: now(),
      outcome: 'skipped',
      metadata: buildNightRecoveryMetadata({
        source: options.source,
        reason: 'already_running',
      }),
    });
    return decision;
  }

  options.setRunning?.(true);
  try {
    const lastSuccessfulRunTs = await options.getLastSuccessfulRunTs();
    const decision = await shouldRunNow({
      isRunning: false,
      lastSuccessfulRunTs,
      nowMs: now(),
      thresholdMs: options.thresholdMs,
    });

    if (!decision.shouldRun) {
      options.recordStat({
        runId: runIdFactory(),
        phase: 'recovery_skipped',
        ts: now(),
        outcome: 'skipped',
        metadata: buildNightRecoveryMetadata({
          source: options.source,
          reason: 'recent_run',
          lastSuccessfulRunTs,
        }),
      });
      return decision;
    }

    if (options.source !== 'scheduled_timer') {
      options.recordStat({
        runId: runIdFactory(),
        phase: 'recovery_triggered',
        ts: now(),
        outcome: 'triggered',
        metadata: buildNightRecoveryMetadata({
          source: options.source,
          lastSuccessfulRunTs,
        }),
      });
    }

    await options.runNightConsolidation(options.source);
    return decision;
  } finally {
    options.setRunning?.(false);
  }
}
