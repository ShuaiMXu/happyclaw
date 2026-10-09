export interface ExternalCapabilityQuotaConfig {
  /** Authenticated POST requests allowed to remain in intake concurrently. */
  globalIntakeLimit: number;
  capabilityIntakeLimit: number;
  keyIntakeLimit: number;
  /** Raw HTTP body bytes reserved by active authenticated intake requests. */
  globalIntakeBytes: number;
  capabilityIntakeBytes: number;
  keyIntakeBytes: number;
  /** All authenticated submission attempts, including invalid/rejected ones. */
  keyIntakeAttemptsPerMinute: number;
  /** Raw ingress bytes consumed by one credential in a rolling day. */
  keyIngressBytesPerDay: number;
  /** Process-local non-queueing protection for parsers, decoders and Vault I/O. */
  localIntakeConcurrency: number;
  intakeTimeoutMs: number;
  intakeReservationTtlMs: number;
  /** Read/control lanes stay independent from hostile submit traffic. */
  keyStatusRequestsPerMinute: number;
  keyCancelRequestsPerMinute: number;
  keyDownloadRequestsPerMinute: number;
  localDownloadConcurrency: number;
  maxOutputBytes: number;
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
  /** Maximum materialized worksheet cells, including headers, before ExcelJS allocation. */
  maxOutputCells: number;
  globalConcurrency: number;
  capabilityConcurrency: number;
  keyConcurrency: number;
  executionTimeoutMs: number;
  /** Hard SDK round-trip limit for one external model execution. */
  maxTurnsPerRun: number;
  /** Hard SDK-reported model spend limit for one external execution. */
  maxBudgetUsdPerRun: number;
  /** Rolling 24-hour Provider-cost exposure, including outstanding holds. */
  globalProviderCostUsdPerDay: number;
  capabilityProviderCostUsdPerDay: number;
  keyProviderCostUsdPerDay: number;
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
  const intakeTimeoutMs = boundedInteger(
    env,
    'EXTERNAL_CAPABILITY_INTAKE_TIMEOUT_MS',
    60_000,
    5_000,
    5 * 60_000,
  );
  const configuredReservationTtlMs = boundedInteger(
    env,
    'EXTERNAL_CAPABILITY_INTAKE_RESERVATION_TTL_MS',
    120_000,
    30_000,
    10 * 60_000,
  );
  const configuredMaxBudgetUsdPerRun = boundedNumber(
    env,
    'EXTERNAL_CAPABILITY_MAX_BUDGET_USD_PER_RUN',
    2,
    0.01,
    100,
  );
  const globalProviderCostUsdPerDay = boundedNumber(
    env,
    'EXTERNAL_CAPABILITY_GLOBAL_PROVIDER_COST_USD_PER_DAY',
    500,
    0.01,
    1_000_000,
  );
  const capabilityProviderCostUsdPerDay = boundedNumber(
    env,
    'EXTERNAL_CAPABILITY_CAPABILITY_PROVIDER_COST_USD_PER_DAY',
    250,
    0.01,
    1_000_000,
  );
  const keyProviderCostUsdPerDay = boundedNumber(
    env,
    'EXTERNAL_CAPABILITY_KEY_PROVIDER_COST_USD_PER_DAY',
    50,
    0.01,
    1_000_000,
  );
  return {
    globalIntakeLimit: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_GLOBAL_INTAKE_LIMIT',
      16,
      1,
      1_000,
    ),
    capabilityIntakeLimit: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_CAPABILITY_INTAKE_LIMIT',
      16,
      1,
      1_000,
    ),
    keyIntakeLimit: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_KEY_INTAKE_LIMIT',
      2,
      1,
      100,
    ),
    globalIntakeBytes: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_GLOBAL_INTAKE_BYTES',
      256 * 1024 * 1024,
      1024 * 1024,
      1024 * 1024 * 1024 * 1024,
    ),
    capabilityIntakeBytes: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_CAPABILITY_INTAKE_BYTES',
      128 * 1024 * 1024,
      1024 * 1024,
      1024 * 1024 * 1024 * 1024,
    ),
    keyIntakeBytes: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_KEY_INTAKE_BYTES',
      64 * 1024 * 1024,
      1024 * 1024,
      1024 * 1024 * 1024 * 1024,
    ),
    keyIntakeAttemptsPerMinute: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_KEY_INTAKE_ATTEMPTS_PER_MINUTE',
      60,
      1,
      10_000,
    ),
    keyIngressBytesPerDay: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_KEY_INGRESS_BYTES_PER_DAY',
      500 * 1024 * 1024,
      1024 * 1024,
      1024 * 1024 * 1024 * 1024,
    ),
    localIntakeConcurrency: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_LOCAL_INTAKE_CONCURRENCY',
      4,
      1,
      100,
    ),
    intakeTimeoutMs,
    intakeReservationTtlMs: Math.max(
      configuredReservationTtlMs,
      intakeTimeoutMs + 30_000,
    ),
    keyStatusRequestsPerMinute: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_KEY_STATUS_REQUESTS_PER_MINUTE',
      120,
      1,
      100_000,
    ),
    keyCancelRequestsPerMinute: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_KEY_CANCEL_REQUESTS_PER_MINUTE',
      60,
      1,
      10_000,
    ),
    keyDownloadRequestsPerMinute: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_KEY_DOWNLOAD_REQUESTS_PER_MINUTE',
      20,
      1,
      10_000,
    ),
    localDownloadConcurrency: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_LOCAL_DOWNLOAD_CONCURRENCY',
      4,
      1,
      100,
    ),
    maxOutputBytes: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_MAX_OUTPUT_BYTES',
      50 * 1024 * 1024,
      1024 * 1024,
      500 * 1024 * 1024,
    ),
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
    maxOutputCells: boundedInteger(
      env,
      'EXTERNAL_CAPABILITY_MAX_OUTPUT_CELLS',
      50_000,
      1,
      50_000,
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
    maxBudgetUsdPerRun: Math.min(
      configuredMaxBudgetUsdPerRun,
      globalProviderCostUsdPerDay,
      capabilityProviderCostUsdPerDay,
      keyProviderCostUsdPerDay,
    ),
    globalProviderCostUsdPerDay,
    capabilityProviderCostUsdPerDay,
    keyProviderCostUsdPerDay,
  };
}
