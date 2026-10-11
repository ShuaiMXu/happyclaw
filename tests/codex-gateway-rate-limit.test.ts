import { afterEach, describe, expect, test, vi } from 'vitest';
import { CodexProviderRateLimiter } from '../src/codex-gateway/provider-rate-limit.js';

vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
const {
  clearCodexProviderRateLimits,
  exhaustedWindowResetAt,
  getCodexProviderRateLimits,
  parseCodexRateLimitHeaders,
  quarantineCodexProviderUntil,
  recordCodexRateLimitEvent,
  recordCodexRateLimitHeaders,
} = await import('../src/codex-gateway/rate-limit-snapshot.js');
const { providerPool } = await import('../src/provider-pool.js');

describe('bounded provider rate windows', () => {
  test('counts requests per provider and resets only after expiry', () => {
    const limiter = new CodexProviderRateLimiter(2, 2, 1000);
    expect(limiter.isLimited('provider', 100)).toBe(false);
    expect(limiter.isLimited('provider', 101)).toBe(false);
    expect(limiter.isLimited('provider', 102)).toBe(true);
    expect(limiter.isLimited('provider', 1100)).toBe(false);
    expect(limiter.size).toBe(1);
  });

  test('capacity is a hard bound; live windows are not evicted to reset budgets', () => {
    const limiter = new CodexProviderRateLimiter(2, 1, 1000);
    expect(limiter.isLimited('one', 0)).toBe(false);
    expect(limiter.isLimited('two', 1)).toBe(false);
    for (let i = 0; i < 2048; i++)
      expect(limiter.isLimited(`other-${i}`, 2)).toBe(true);
    expect(limiter.size).toBe(2);
    expect(limiter.isLimited('one', 3)).toBe(true);
    expect(limiter.isLimited('new', 1001)).toBe(false);
    expect(limiter.size).toBe(1);
  });

  test('reports when a limited key may retry', () => {
    const limiter = new CodexProviderRateLimiter(2, 1, 1000);
    expect(limiter.retryAfterMs('runner', 0)).toBe(0);
    expect(limiter.isLimited('runner', 100)).toBe(false);
    expect(limiter.isLimited('runner', 400)).toBe(true);
    expect(limiter.retryAfterMs('runner', 400)).toBe(700);
    // A full table points at the oldest live window.
    expect(limiter.isLimited('other', 500)).toBe(false);
    expect(limiter.isLimited('third', 600)).toBe(true);
    expect(limiter.retryAfterMs('third', 600)).toBe(500);
  });
});

describe('Codex rate-limit snapshot (official rate_limits.rs)', () => {
  afterEach(() => clearCodexProviderRateLimits());

  test('parses the default family, secondary windows, credits and other families', () => {
    const headers = new Headers({
      'x-codex-primary-used-percent': '12.5',
      'x-codex-primary-window-minutes': '60',
      'x-codex-primary-reset-at': '1704069000',
      'x-codex-secondary-used-percent': '80',
      'x-codex-secondary-window-minutes': '1440',
      'x-codex-secondary-reset-at': '1704074400',
      'x-codex-credits-has-credits': 'TRUE',
      'x-codex-credits-unlimited': '0',
      'x-codex-credits-balance': ' 9.99 ',
      'x-codex-secondary-primary-used-percent': '33',
      'x-codex-secondary-limit-name': 'Secondary family',
    });
    expect(parseCodexRateLimitHeaders(headers)).toEqual([
      {
        limitId: 'codex',
        limitName: null,
        primary: { usedPercent: 12.5, windowMinutes: 60, resetsAt: 1704069000 },
        secondary: {
          usedPercent: 80,
          windowMinutes: 1440,
          resetsAt: 1704074400,
        },
        credits: { hasCredits: true, unlimited: false, balance: '9.99' },
      },
      {
        limitId: 'codex_secondary',
        limitName: 'Secondary family',
        primary: { usedPercent: 33, windowMinutes: null, resetsAt: null },
        secondary: null,
        credits: { hasCredits: true, unlimited: false, balance: '9.99' },
      },
    ]);
  });

  test('windows without data, malformed numbers and empty families are left out', () => {
    expect(
      parseCodexRateLimitHeaders(
        new Headers({
          'x-codex-primary-used-percent': '0',
          'x-codex-primary-window-minutes': '0',
          'x-codex-secondary-used-percent': 'NaN',
          'x-codex-credits-has-credits': 'maybe',
          'x-codex-credits-unlimited': 'false',
        }),
      ),
    ).toEqual([]);
  });

  test('merges by family, clears a rejection on success and keeps data on bare responses', () => {
    recordCodexRateLimitHeaders(
      'p1',
      new Headers({
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-reset-at': '2000000000',
        'x-codex-active-limit': 'codex',
        'x-codex-rate-limit-reached-type': 'rate_limit_reached',
      }),
      { ok: false, now: 1 },
    );
    expect(getCodexProviderRateLimits('p1')).toMatchObject({
      observedAt: 1,
      activeLimit: 'codex',
      rateLimitReachedType: 'rate_limit_reached',
    });
    expect(exhaustedWindowResetAt('p1')).toBe(2000000000);
    recordCodexRateLimitHeaders('p1', new Headers(), { ok: true, now: 2 });
    expect(getCodexProviderRateLimits('p1')).toMatchObject({
      observedAt: 1,
      rateLimitReachedType: null,
      limits: [{ limitId: 'codex', primary: { usedPercent: 100 } }],
    });
    recordCodexRateLimitEvent(
      'p1',
      {
        type: 'codex.rate_limits',
        metered_limit_name: 'codex-other',
        rate_limits: { primary: { used_percent: 7, window_minutes: 300 } },
        credits: { has_credits: false, unlimited: false, balance: null },
      },
      3,
    );
    expect(
      getCodexProviderRateLimits('p1').limits.map(({ limitId }) => limitId),
    ).toEqual(['codex', 'codex_other']);
    expect(getCodexProviderRateLimits('unknown')).toEqual({
      kind: 'codex_rate_limits',
      observedAt: null,
      activeLimit: null,
      rateLimitReachedType: null,
      limits: [],
    });
  });

  test('quarantines a provider until a future reset only', () => {
    const now = Date.UTC(2026, 9, 11);
    providerPool.refreshFromConfig([{ id: 'p2', enabled: true, weight: 1 }], {
      strategy: 'failover',
      unhealthyThreshold: 3,
      recoveryIntervalMs: 300_000,
    });
    quarantineCodexProviderUntil('p2', now / 1000 - 1, now);
    expect(providerPool.getHealthStatuses()[0]).toMatchObject({
      healthy: true,
    });
    quarantineCodexProviderUntil('p2', Date.now() / 1000 + 600);
    expect(providerPool.getHealthStatuses()[0]).toMatchObject({
      healthy: false,
      quarantinedUntil: expect.any(Number),
    });
    providerPool.refreshFromConfig([], {
      strategy: 'failover',
      unhealthyThreshold: 3,
      recoveryIntervalMs: 300_000,
    });
  });
});
