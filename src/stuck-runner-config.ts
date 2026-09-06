export const DEFAULT_STUCK_RUNNER_FORCE_RESTART_MINUTES = 10;
export const MIN_STUCK_RUNNER_FORCE_RESTART_MINUTES = 4;
export const MAX_STUCK_RUNNER_FORCE_RESTART_MINUTES = 120;

/**
 * Parse the emergency stuck-runner ceiling from the environment.
 *
 * The value is intentionally an integer and bounded. Values at or below the
 * ordinary three-minute idle detector would turn the emergency ceiling into
 * the primary policy, while an unbounded value could disable recovery for an
 * operationally meaningful amount of time. Invalid values preserve the
 * historical ten-minute default.
 */
export function parseStuckRunnerForceRestartMs(
  raw: string | undefined,
): number {
  const normalized = raw?.trim() ?? '';
  if (!/^\d+$/.test(normalized)) {
    return DEFAULT_STUCK_RUNNER_FORCE_RESTART_MINUTES * 60_000;
  }
  const minutes = Number(normalized);
  if (
    !Number.isSafeInteger(minutes) ||
    minutes < MIN_STUCK_RUNNER_FORCE_RESTART_MINUTES ||
    minutes > MAX_STUCK_RUNNER_FORCE_RESTART_MINUTES
  ) {
    return DEFAULT_STUCK_RUNNER_FORCE_RESTART_MINUTES * 60_000;
  }
  return minutes * 60_000;
}
