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
      globalConcurrency: 2,
      capabilityConcurrency: 2,
      keyConcurrency: 1,
      executionTimeoutMs: 10 * 60_000,
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
        EXTERNAL_CAPABILITY_GLOBAL_CONCURRENCY: '4',
        EXTERNAL_CAPABILITY_CAPABILITY_CONCURRENCY: '3',
        EXTERNAL_CAPABILITY_KEY_CONCURRENCY: '2',
        EXTERNAL_CAPABILITY_EXECUTION_TIMEOUT_MS: '120000',
      }),
    ).toEqual({
      globalQueueLimit: 25,
      capabilityQueueLimit: 100,
      keyQueueLimit: 5,
      keyRunsPerMinute: 3,
      keyRunsPerDay: 200,
      globalConcurrency: 4,
      capabilityConcurrency: 3,
      keyConcurrency: 2,
      executionTimeoutMs: 120_000,
    });
  });
});
