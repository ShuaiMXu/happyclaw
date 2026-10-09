import { describe, expect, test } from 'vitest';

import {
  DEFAULT_EXTERNAL_CAPABILITY_RUN_RETENTION_HOURS,
  EXTERNAL_CAPABILITY_RETENTION_ERROR_RETRY_MS,
  EXTERNAL_CAPABILITY_RETENTION_SCHEDULER_SAFETY_MS,
  EXTERNAL_CAPABILITY_RETENTION_SWEEP_INTERVAL_MS,
  getExternalCapabilityRetentionCleanupAgeMs,
  MAX_EXTERNAL_CAPABILITY_RUN_RETENTION_HOURS,
  MIN_EXTERNAL_CAPABILITY_RUN_RETENTION_HOURS,
  parseExternalCapabilityRunRetentionMs,
} from '../src/external-capability-retention-config.js';

const HOUR_MS = 60 * 60_000;

describe('parseExternalCapabilityRunRetentionMs', () => {
  test.each([
    undefined,
    '',
    ' ',
    'nope',
    '1.5',
    '-1',
    '0',
    '25',
    '9007199254740992',
  ])('falls back for invalid or unsafe value %j', (value) => {
    expect(parseExternalCapabilityRunRetentionMs(value)).toBe(
      DEFAULT_EXTERNAL_CAPABILITY_RUN_RETENTION_HOURS * HOUR_MS,
    );
  });

  test.each([
    [String(MIN_EXTERNAL_CAPABILITY_RUN_RETENTION_HOURS), 1 * HOUR_MS],
    ['12', 12 * HOUR_MS],
    [String(MAX_EXTERNAL_CAPABILITY_RUN_RETENTION_HOURS), 24 * HOUR_MS],
    [' 6 ', 6 * HOUR_MS],
  ])('accepts bounded integer hours %j', (value, expected) => {
    expect(parseExternalCapabilityRunRetentionMs(value)).toBe(expected);
  });

  test('schedules cleanup early enough to preserve the configured ceiling', () => {
    const configuredMs = parseExternalCapabilityRunRetentionMs('24');
    const cleanupAgeMs = getExternalCapabilityRetentionCleanupAgeMs('24');

    expect(cleanupAgeMs).toBe(
      configuredMs - EXTERNAL_CAPABILITY_RETENTION_SCHEDULER_SAFETY_MS,
    );
    expect(
      cleanupAgeMs + EXTERNAL_CAPABILITY_RETENTION_SWEEP_INTERVAL_MS,
    ).toBeLessThan(configuredMs);
    expect(EXTERNAL_CAPABILITY_RETENTION_ERROR_RETRY_MS).toBeLessThan(
      EXTERNAL_CAPABILITY_RETENTION_SWEEP_INTERVAL_MS,
    );
  });
});
