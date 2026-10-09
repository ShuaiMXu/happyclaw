import { describe, expect, test } from 'vitest';

import { getExternalCapabilityQuotaConfig } from '../src/external-capability-quota-config.js';

describe('external capability quota configuration', () => {
  test('uses conservative non-zero defaults', () => {
    expect(getExternalCapabilityQuotaConfig({})).toEqual({
      globalIntakeLimit: 16,
      capabilityIntakeLimit: 16,
      keyIntakeLimit: 2,
      globalIntakeBytes: 256 * 1024 * 1024,
      capabilityIntakeBytes: 128 * 1024 * 1024,
      keyIntakeBytes: 64 * 1024 * 1024,
      keyIntakeAttemptsPerMinute: 60,
      keyIngressBytesPerDay: 500 * 1024 * 1024,
      localIntakeConcurrency: 4,
      intakeTimeoutMs: 60_000,
      intakeReservationTtlMs: 120_000,
      keyStatusRequestsPerMinute: 120,
      keyCancelRequestsPerMinute: 60,
      keyDownloadRequestsPerMinute: 20,
      localDownloadConcurrency: 4,
      maxOutputBytes: 50 * 1024 * 1024,
      globalQueueLimit: 100,
      capabilityQueueLimit: 100,
      keyQueueLimit: 20,
      keyRunsPerMinute: 10,
      keyRunsPerDay: 1_000,
      keyInputBytesPerDay: 250 * 1024 * 1024,
      maxInputBytesPerRun: 10 * 1024 * 1024,
      maxOutputRows: 10_000,
      maxOutputCells: 50_000,
      globalConcurrency: 2,
      capabilityConcurrency: 2,
      keyConcurrency: 1,
      executionTimeoutMs: 10 * 60_000,
      maxTurnsPerRun: 4,
      maxBudgetUsdPerRun: 2,
      globalProviderCostUsdPerDay: 500,
      capabilityProviderCostUsdPerDay: 250,
      keyProviderCostUsdPerDay: 50,
    });
  });

  test('accepts bounded overrides and ignores unsafe values', () => {
    expect(
      getExternalCapabilityQuotaConfig({
        EXTERNAL_CAPABILITY_GLOBAL_INTAKE_LIMIT: '12',
        EXTERNAL_CAPABILITY_CAPABILITY_INTAKE_LIMIT: '8',
        EXTERNAL_CAPABILITY_KEY_INTAKE_LIMIT: '3',
        EXTERNAL_CAPABILITY_GLOBAL_INTAKE_BYTES: '268435456',
        EXTERNAL_CAPABILITY_CAPABILITY_INTAKE_BYTES: '134217728',
        EXTERNAL_CAPABILITY_KEY_INTAKE_BYTES: '33554432',
        EXTERNAL_CAPABILITY_KEY_INTAKE_ATTEMPTS_PER_MINUTE: '7',
        EXTERNAL_CAPABILITY_KEY_INGRESS_BYTES_PER_DAY: '104857600',
        EXTERNAL_CAPABILITY_LOCAL_INTAKE_CONCURRENCY: '6',
        EXTERNAL_CAPABILITY_INTAKE_TIMEOUT_MS: '45000',
        EXTERNAL_CAPABILITY_INTAKE_RESERVATION_TTL_MS: '60000',
        EXTERNAL_CAPABILITY_KEY_STATUS_REQUESTS_PER_MINUTE: '80',
        EXTERNAL_CAPABILITY_KEY_CANCEL_REQUESTS_PER_MINUTE: '40',
        EXTERNAL_CAPABILITY_KEY_DOWNLOAD_REQUESTS_PER_MINUTE: '10',
        EXTERNAL_CAPABILITY_LOCAL_DOWNLOAD_CONCURRENCY: '3',
        EXTERNAL_CAPABILITY_MAX_OUTPUT_BYTES: '10485760',
        EXTERNAL_CAPABILITY_GLOBAL_QUEUE_LIMIT: '25',
        EXTERNAL_CAPABILITY_CAPABILITY_QUEUE_LIMIT: '0',
        EXTERNAL_CAPABILITY_KEY_QUEUE_LIMIT: '5',
        EXTERNAL_CAPABILITY_KEY_RUNS_PER_MINUTE: '3',
        EXTERNAL_CAPABILITY_KEY_RUNS_PER_DAY: '200',
        EXTERNAL_CAPABILITY_KEY_INPUT_BYTES_PER_DAY: '20971520',
        EXTERNAL_CAPABILITY_MAX_INPUT_BYTES_PER_RUN: '5242880',
        EXTERNAL_CAPABILITY_MAX_OUTPUT_ROWS: '500',
        EXTERNAL_CAPABILITY_MAX_OUTPUT_CELLS: '10000',
        EXTERNAL_CAPABILITY_GLOBAL_CONCURRENCY: '4',
        EXTERNAL_CAPABILITY_CAPABILITY_CONCURRENCY: '3',
        EXTERNAL_CAPABILITY_KEY_CONCURRENCY: '2',
        EXTERNAL_CAPABILITY_EXECUTION_TIMEOUT_MS: '120000',
        EXTERNAL_CAPABILITY_MAX_TURNS_PER_RUN: '3',
        EXTERNAL_CAPABILITY_MAX_BUDGET_USD_PER_RUN: '0.75',
        EXTERNAL_CAPABILITY_GLOBAL_PROVIDER_COST_USD_PER_DAY: '120',
        EXTERNAL_CAPABILITY_CAPABILITY_PROVIDER_COST_USD_PER_DAY: '60',
        EXTERNAL_CAPABILITY_KEY_PROVIDER_COST_USD_PER_DAY: '12',
      }),
    ).toEqual({
      globalIntakeLimit: 12,
      capabilityIntakeLimit: 8,
      keyIntakeLimit: 3,
      globalIntakeBytes: 256 * 1024 * 1024,
      capabilityIntakeBytes: 128 * 1024 * 1024,
      keyIntakeBytes: 32 * 1024 * 1024,
      keyIntakeAttemptsPerMinute: 7,
      keyIngressBytesPerDay: 100 * 1024 * 1024,
      localIntakeConcurrency: 6,
      intakeTimeoutMs: 45_000,
      intakeReservationTtlMs: 75_000,
      keyStatusRequestsPerMinute: 80,
      keyCancelRequestsPerMinute: 40,
      keyDownloadRequestsPerMinute: 10,
      localDownloadConcurrency: 3,
      maxOutputBytes: 10 * 1024 * 1024,
      globalQueueLimit: 25,
      capabilityQueueLimit: 100,
      keyQueueLimit: 5,
      keyRunsPerMinute: 3,
      keyRunsPerDay: 200,
      keyInputBytesPerDay: 20 * 1024 * 1024,
      maxInputBytesPerRun: 5 * 1024 * 1024,
      maxOutputRows: 500,
      maxOutputCells: 10_000,
      globalConcurrency: 4,
      capabilityConcurrency: 3,
      keyConcurrency: 2,
      executionTimeoutMs: 120_000,
      maxTurnsPerRun: 3,
      maxBudgetUsdPerRun: 0.75,
      globalProviderCostUsdPerDay: 120,
      capabilityProviderCostUsdPerDay: 60,
      keyProviderCostUsdPerDay: 12,
    });
  });

  test('caps materialized workbook cells at the heap-safe ceiling', () => {
    expect(
      getExternalCapabilityQuotaConfig({
        EXTERNAL_CAPABILITY_MAX_OUTPUT_CELLS: '50000',
      }).maxOutputCells,
    ).toBe(50_000);
    expect(
      getExternalCapabilityQuotaConfig({
        EXTERNAL_CAPABILITY_MAX_OUTPUT_CELLS: '50001',
      }).maxOutputCells,
    ).toBe(50_000);
    expect(
      getExternalCapabilityQuotaConfig({
        EXTERNAL_CAPABILITY_MAX_OUTPUT_CELLS: '1000000',
      }).maxOutputCells,
    ).toBe(50_000);
  });

  test('clamps per-run Provider spend to every rolling daily budget', () => {
    const config = getExternalCapabilityQuotaConfig({
      EXTERNAL_CAPABILITY_MAX_BUDGET_USD_PER_RUN: '100',
      EXTERNAL_CAPABILITY_GLOBAL_PROVIDER_COST_USD_PER_DAY: '80',
      EXTERNAL_CAPABILITY_CAPABILITY_PROVIDER_COST_USD_PER_DAY: '40',
      EXTERNAL_CAPABILITY_KEY_PROVIDER_COST_USD_PER_DAY: '12',
    });
    expect(config.maxBudgetUsdPerRun).toBe(12);
    expect(config.globalProviderCostUsdPerDay).toBe(80);
    expect(config.capabilityProviderCostUsdPerDay).toBe(40);
    expect(config.keyProviderCostUsdPerDay).toBe(12);
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
