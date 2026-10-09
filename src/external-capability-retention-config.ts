export const DEFAULT_EXTERNAL_CAPABILITY_RUN_RETENTION_HOURS = 24;
export const MIN_EXTERNAL_CAPABILITY_RUN_RETENTION_HOURS = 1;
export const MAX_EXTERNAL_CAPABILITY_RUN_RETENTION_HOURS = 24;
export const EXTERNAL_CAPABILITY_RETENTION_SWEEP_INTERVAL_MS = 30_000;
export const EXTERNAL_CAPABILITY_RETENTION_SCHEDULER_SAFETY_MS = 60_000;
export const EXTERNAL_CAPABILITY_RETENTION_ERROR_RETRY_MS = 5_000;
export const EXTERNAL_CAPABILITY_STORAGE_RELEASE_GC_GRACE_MS = 24 * 60 * 60_000;

/**
 * Keep private external-call data for no longer than one day. Operators may
 * shorten the window, but invalid values cannot disable cleanup or extend the
 * privacy ceiling.
 */
export function parseExternalCapabilityRunRetentionMs(
  raw: string | undefined,
): number {
  const normalized = raw?.trim() ?? '';
  if (!/^\d+$/.test(normalized)) {
    return DEFAULT_EXTERNAL_CAPABILITY_RUN_RETENTION_HOURS * 60 * 60_000;
  }
  const hours = Number(normalized);
  if (
    !Number.isSafeInteger(hours) ||
    hours < MIN_EXTERNAL_CAPABILITY_RUN_RETENTION_HOURS ||
    hours > MAX_EXTERNAL_CAPABILITY_RUN_RETENTION_HOURS
  ) {
    return DEFAULT_EXTERNAL_CAPABILITY_RUN_RETENTION_HOURS * 60 * 60_000;
  }
  return hours * 60 * 60_000;
}

/**
 * Run cleanup before the configured ceiling by more than one normal sweep
 * interval so a run completed immediately after a pass is still eligible in
 * time. Item-level failures use the shorter retry interval above.
 */
export function getExternalCapabilityRetentionCleanupAgeMs(
  raw: string | undefined,
): number {
  return Math.max(
    0,
    parseExternalCapabilityRunRetentionMs(raw) -
      EXTERNAL_CAPABILITY_RETENTION_SCHEDULER_SAFETY_MS,
  );
}
