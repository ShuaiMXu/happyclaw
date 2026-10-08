export interface ExternalCapabilityQuotaConfig {
  globalQueueLimit: number;
  capabilityQueueLimit: number;
  keyQueueLimit: number;
  keyRunsPerMinute: number;
  keyRunsPerDay: number;
  globalConcurrency: number;
  capabilityConcurrency: number;
  keyConcurrency: number;
  executionTimeoutMs: number;
}

function boundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

export function getExternalCapabilityQuotaConfig(
  env: NodeJS.ProcessEnv = process.env,
): ExternalCapabilityQuotaConfig {
  return {
    globalQueueLimit: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_GLOBAL_QUEUE_LIMIT',
      100,
      1,
      10_000,
    ),
    capabilityQueueLimit: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_CAPABILITY_QUEUE_LIMIT',
      100,
      1,
      10_000,
    ),
    keyQueueLimit: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_KEY_QUEUE_LIMIT',
      20,
      1,
      1_000,
    ),
    keyRunsPerMinute: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_KEY_RUNS_PER_MINUTE',
      10,
      1,
      1_000,
    ),
    keyRunsPerDay: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_KEY_RUNS_PER_DAY',
      1_000,
      1,
      100_000,
    ),
    globalConcurrency: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_GLOBAL_CONCURRENCY',
      2,
      1,
      100,
    ),
    capabilityConcurrency: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_CAPABILITY_CONCURRENCY',
      2,
      1,
      100,
    ),
    keyConcurrency: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_KEY_CONCURRENCY',
      1,
      1,
      20,
    ),
    executionTimeoutMs: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_EXECUTION_TIMEOUT_MS',
      10 * 60_000,
      30_000,
      30 * 60_000,
    ),
  };
}
