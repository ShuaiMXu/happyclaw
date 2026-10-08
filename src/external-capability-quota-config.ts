export interface ExternalCapabilityQuotaConfig {
  globalQueueLimit: number;
  capabilityQueueLimit: number;
  keyQueueLimit: number;
  keyRunsPerMinute: number;
  keyRunsPerDay: number;
  /** Raw validated input bytes accepted for one credential in a rolling day. */
  keyInputBytesPerDay: number;
  /** Raw input bytes allowed in a single model invocation. */
  maxInputBytesPerRun: number;
  /** Server-generated workbook rows permitted from one model response. */
  maxOutputRows: number;
  globalConcurrency: number;
  capabilityConcurrency: number;
  keyConcurrency: number;
  executionTimeoutMs: number;
  /** Hard SDK round-trip limit for one external model execution. */
  maxTurnsPerRun: number;
  /** Hard SDK-reported model spend limit for one external execution. */
  maxBudgetUsdPerRun: number;
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

function boundedNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
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
    keyInputBytesPerDay: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_KEY_INPUT_BYTES_PER_DAY',
      250 * 1024 * 1024,
      1024 * 1024,
      1024 * 1024 * 1024 * 1024,
    ),
    maxInputBytesPerRun: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_MAX_INPUT_BYTES_PER_RUN',
      10 * 1024 * 1024,
      1024 * 1024,
      50 * 1024 * 1024,
    ),
    maxOutputRows: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_MAX_OUTPUT_ROWS',
      10_000,
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
    maxTurnsPerRun: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_MAX_TURNS_PER_RUN',
      4,
      1,
      20,
    ),
    maxBudgetUsdPerRun: boundedNumber(
      env,
      'EXTERNAL_CAPABILITY_MAX_BUDGET_USD_PER_RUN',
      2,
      0.01,
      100,
    ),
  };
}
