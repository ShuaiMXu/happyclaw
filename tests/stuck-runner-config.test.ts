import { describe, expect, test } from 'vitest';

import {
  DEFAULT_STUCK_RUNNER_FORCE_RESTART_MINUTES,
  MAX_STUCK_RUNNER_FORCE_RESTART_MINUTES,
  MIN_STUCK_RUNNER_FORCE_RESTART_MINUTES,
  parseStuckRunnerForceRestartMs,
} from '../src/stuck-runner-config.js';

describe('parseStuckRunnerForceRestartMs', () => {
  test.each([undefined, '', ' ', 'nope', '10.5', '-1', '0', '3', '121'])(
    'falls back for invalid or unsafe value %j',
    (value) => {
      expect(parseStuckRunnerForceRestartMs(value)).toBe(
        DEFAULT_STUCK_RUNNER_FORCE_RESTART_MINUTES * 60_000,
      );
    },
  );

  test.each([
    [String(MIN_STUCK_RUNNER_FORCE_RESTART_MINUTES), 4 * 60_000],
    ['25', 25 * 60_000],
    [String(MAX_STUCK_RUNNER_FORCE_RESTART_MINUTES), 120 * 60_000],
    [' 25 ', 25 * 60_000],
  ])('accepts bounded integer minutes %j', (value, expected) => {
    expect(parseStuckRunnerForceRestartMs(value)).toBe(expected);
  });

  test('rejects values above JavaScript safe integer range', () => {
    expect(parseStuckRunnerForceRestartMs('9007199254740992')).toBe(
      DEFAULT_STUCK_RUNNER_FORCE_RESTART_MINUTES * 60_000,
    );
  });
});
