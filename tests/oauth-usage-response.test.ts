import { describe, expect, test } from 'vitest';

import {
  hasOAuthUsageSignals,
  parseOAuthExtraUsage,
  parseOAuthModelWindows,
  parseOAuthUsageBucket,
  parseOAuthUsageResponse,
} from '../src/runtime-config.js';

describe('Claude OAuth usage response parsing', () => {
  test('parses the current raw endpoint shape without inventing fixed model fields', () => {
    const parsed = parseOAuthUsageResponse({
      five_hour: {
        utilization: 12.75,
        resets_at: '2026-09-02T10:00:00.000Z',
      },
      seven_day: {
        utilization: 53.125,
        resets_at: '2026-09-08T10:00:00.000Z',
      },
      seven_day_oauth_apps: {
        utilization: null,
        resets_at: null,
      },
      extra_usage: {
        is_enabled: true,
        monthly_limit: 250,
        used_credits: 18.45,
        utilization: 7.38,
        currency: 'USD',
      },
      limits: [
        {
          kind: 'weekly_scoped',
          group: 'model',
          percent: 61.25,
          resets_at: '2026-09-08T11:00:00.000Z',
          scope: { model: { display_name: 'Fable' } },
        },
        {
          kind: 'weekly_scoped',
          group: 'surface',
          percent: 90,
          resets_at: '2026-09-08T11:00:00.000Z',
          scope: { surface: { display_name: 'Claude Code' } },
        },
      ],
    });

    expect(parsed).toEqual({
      five_hour: {
        utilization: 12.75,
        resets_at: '2026-09-02T10:00:00.000Z',
      },
      seven_day: {
        utilization: 53.125,
        resets_at: '2026-09-08T10:00:00.000Z',
      },
      seven_day_oauth_apps: { utilization: null, resets_at: null },
      seven_day_opus: null,
      seven_day_sonnet: null,
      model_scoped: [
        {
          display_name: 'Fable',
          utilization: 61.25,
          resets_at: '2026-09-08T11:00:00.000Z',
        },
      ],
      extra_usage: {
        is_enabled: true,
        monthly_limit: 250,
        used_credits: 18.45,
        utilization: 7.38,
        currency: 'USD',
      },
    });
    expect(parsed).not.toHaveProperty('seven_day_sonnet_max');
    expect(parsed.extra_usage).not.toHaveProperty('resets_at');
  });

  test('accepts the SDK control response model_scoped shape with nullable values', () => {
    expect(
      parseOAuthModelWindows({
        model_scoped: [
          {
            display_name: 'Future model',
            utilization: null,
            resets_at: null,
          },
        ],
      }),
    ).toEqual([
      {
        display_name: 'Future model',
        utilization: null,
        resets_at: null,
      },
    ]);
  });

  test('keeps OAuth percentages precise and does not clamp or round them', () => {
    expect(
      parseOAuthUsageBucket({
        utilization: 100.125,
        resets_at: '2026-09-02T10:00:00.000Z',
      }),
    ).toEqual({
      utilization: 100.125,
      resets_at: '2026-09-02T10:00:00.000Z',
    });
  });

  test('requires the real extra_usage discriminator but not a reset timestamp', () => {
    expect(
      parseOAuthExtraUsage({
        is_enabled: false,
        monthly_limit: null,
        used_credits: null,
        utilization: null,
      }),
    ).toEqual({
      is_enabled: false,
      monthly_limit: null,
      used_credits: null,
      utilization: null,
      currency: null,
    });
    expect(parseOAuthExtraUsage({ utilization: 20 })).toBeNull();
  });

  test('bounds dynamic windows and keeps the first case-insensitive label', () => {
    const limits = Array.from({ length: 40 }, (_, index) => ({
      kind: 'weekly_scoped',
      percent: index,
      resets_at: null,
      scope: {
        model: { display_name: index === 1 ? 'MODEL-0' : `model-${index}` },
      },
    }));
    const parsed = parseOAuthModelWindows({ limits });

    expect(parsed).toHaveLength(31);
    expect(parsed[0]).toMatchObject({
      display_name: 'model-0',
      utilization: 0,
    });
    expect(
      parsed.find((bucket) => bucket.display_name === 'MODEL-0'),
    ).toBeUndefined();
    expect(parsed.at(-1)?.display_name).toBe('model-31');
  });

  test('distinguishes explicit snapshots from fieldless 200 responses', () => {
    expect(hasOAuthUsageSignals({})).toBe(false);
    expect(hasOAuthUsageSignals([])).toBe(false);
    expect(hasOAuthUsageSignals({ error: 'temporarily unavailable' })).toBe(
      false,
    );
    expect(hasOAuthUsageSignals({ five_hour: 'malformed' })).toBe(false);
    expect(hasOAuthUsageSignals({ five_hour: null })).toBe(true);
    expect(hasOAuthUsageSignals({ model_scoped: [] })).toBe(true);
    expect(hasOAuthUsageSignals({ limits: [] })).toBe(true);
  });
});
