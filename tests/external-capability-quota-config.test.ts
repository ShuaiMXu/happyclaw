import { describe, expect, test } from 'vitest';

import { getExternalCapabilityQuotaConfig } from '../src/external-capability-quota-config.js';

describe('external capability quota configuration', () => {
  test('uses conservative non-zero defaults', () => {
    expect(getExternalCapabilityQuotaConfig({})).toEqual({
      globalQueueLimit: 100,
      capabilityQueueLimit: 100,
      keyQueueLimit: 20,
      keyRunsPerMinute: 10,
      keyRunsPerDay: 1_000,
      keyInputBytesPerDay: 250 * 1024 * 1024,
      maxInputBytesPerRun: 10 * 1024 * 1024,
      maxOutputRows: 10_000,
      globalConcurrency: 2,
      capabilityConcurrency: 2,
      keyConcurrency: 1,
      executionTimeoutMs: 10 * 60_000,
      maxTurnsPerRun: 4,
      maxBudgetUsdPerRun: 2,
    });
  });

  test('accepts bounded overrides and ignores unsafe values', () => {
    expect(
      getExternalCapabilityQuotaConfig({
        EXTERNAL_CAPABILITY_GLOBAL_QUEUE_LIMIT: '25',
        EXTERNAL_CAPABILITY_CAPABILITY_QUEUE_LIMIT: '0',
        EXTERNAL_CAPABILITY_KEY_QUEUE_LIMIT: '5',
        EXTERNAL_CAPABILITY_KEY_RUNS_PER_MINUTE: '3',
        EXTERNAL_CAPABILITY_KEY_RUNS_PER_DAY: '200',
        EXTERNAL_CAPABILITY_KEY_INPUT_BYTES_PER_DAY: '20971520',
        EXTERNAL_CAPABILITY_MAX_INPUT_BYTES_PER_RUN: '5242880',
        EXTERNAL_CAPABILITY_MAX_OUTPUT_ROWS: '500',
        EXTERNAL_CAPABILITY_GLOBAL_CONCURRENCY: '4',
        EXTERNAL_CAPABILITY_CAPABILITY_CONCURRENCY: '3',
        EXTERNAL_CAPABILITY_KEY_CONCURRENCY: '2',
        EXTERNAL_CAPABILITY_EXECUTION_TIMEOUT_MS: '120000',
        EXTERNAL_CAPABILITY_MAX_TURNS_PER_RUN: '3',
        EXTERNAL_CAPABILITY_MAX_BUDGET_USD_PER_RUN: '0.75',
      }),
    ).toEqual({
      globalQueueLimit: 25,
      capabilityQueueLimit: 100,
      keyQueueLimit: 5,
      keyRunsPerMinute: 3,
      keyRunsPerDay: 200,
      keyInputBytesPerDay: 20 * 1024 * 1024,
      maxInputBytesPerRun: 5 * 1024 * 1024,
      maxOutputRows: 500,
      globalConcurrency: 4,
      capabilityConcurrency: 3,
      keyConcurrency: 2,
      executionTimeoutMs: 120_000,
      maxTurnsPerRun: 3,
      maxBudgetUsdPerRun: 0.75,
    });
  });

  test('rejects unsafe model execution limits', () => {
    const belowMinimum = getExternalCapabilityQuotaConfig({
      EXTERNAL_CAPABILITY_MAX_TURNS_PER_RUN: '0',
      EXTERNAL_CAPABILITY_MAX_BUDGET_USD_PER_RUN: '0',
    });
    expect(belowMinimum.maxTurnsPerRun).toBe(4);
    expect(belowMinimum.maxBudgetUsdPerRun).toBe(2);

    const nonFinite = getExternalCapabilityQuotaConfig({
      EXTERNAL_CAPABILITY_MAX_TURNS_PER_RUN: '1.5',
      EXTERNAL_CAPABILITY_MAX_BUDGET_USD_PER_RUN: 'Infinity',
    });
    expect(nonFinite.maxTurnsPerRun).toBe(4);
    expect(nonFinite.maxBudgetUsdPerRun).toBe(2);
  });
});
