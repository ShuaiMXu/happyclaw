export const DEFAULT_EXTERNAL_CAPABILITY_RUN_RETENTION_HOURS = 24;
export const MIN_EXTERNAL_CAPABILITY_RUN_RETENTION_HOURS = 1;
export const MAX_EXTERNAL_CAPABILITY_RUN_RETENTION_HOURS = 24;

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
