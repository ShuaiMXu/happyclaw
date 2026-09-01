// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../web/src/api/client', () => ({
  api: { get: apiMock.get },
}));

import {
  UsageBars,
  clampUsagePercentage,
  extraUsagePercentage,
  formatExtraUsageDetail,
  formatResetTime,
  isCurrentProviderQuotaObservation,
  sdkUtilizationPercentage,
} from '../web/src/components/settings/UsageBars';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  apiMock.get.mockReset();
  vi.useRealTimers();
});

describe('Claude provider usage bars', () => {
  test('normalizes each source in its documented unit', () => {
    expect(clampUsagePercentage(100.25)).toBe(100);
    expect(
      sdkUtilizationPercentage({
        source: 'sdk_rate_limit_event',
        observedAt: 1,
        status: 'allowed_warning',
        utilization: 0.53,
      }),
    ).toBe(53);
    expect(
      extraUsagePercentage({
        is_enabled: true,
        monthly_limit: 100,
        used_credits: 25,
        utilization: null,
        currency: 'USD',
      }),
    ).toBe(25);
  });

  test('formats extra usage amounts from minor currency units and recognizes unlimited plans', () => {
    const usd = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    expect(
      formatExtraUsageDetail({
        is_enabled: true,
        monthly_limit: 10_000,
        used_credits: 2_500,
        utilization: 25,
        currency: 'USD',
      }),
    ).toBe(`${usd.format(25)} / ${usd.format(100)}`);
    expect(
      formatExtraUsageDetail({
        is_enabled: true,
        monthly_limit: null,
        used_credits: 2_500,
        utilization: null,
        currency: 'USD',
      }),
    ).toBe(`已用 ${usd.format(25)} · 无月度上限`);
    const jpy = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'JPY',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    expect(
      formatExtraUsageDetail({
        is_enabled: true,
        monthly_limit: 10_000,
        used_credits: 2_500,
        utilization: 25,
        currency: 'JPY',
      }),
    ).toBe(`${jpy.format(2_500)} / ${jpy.format(10_000)}`);
    expect(
      formatExtraUsageDetail({
        is_enabled: true,
        monthly_limit: 10_000,
        used_credits: 2_500,
        utilization: 25,
        currency: null,
      }),
    ).toBe(`${usd.format(25)} / ${usd.format(100)}`);
    expect(
      extraUsagePercentage({
        is_enabled: false,
        monthly_limit: 100,
        used_credits: 90,
        utilization: 90,
        currency: 'USD',
      }),
    ).toBeNull();
  });

  test('downgrades expired or old SDK observations from Live to Last', () => {
    const now = Date.parse('2026-09-02T08:00:00.000Z');
    expect(
      isCurrentProviderQuotaObservation(
        {
          source: 'sdk_rate_limit_event',
          observedAt: now - 60_000,
          status: 'rejected',
          resetsAt: now / 1000 + 60,
        },
        now,
      ),
    ).toBe(true);
    expect(
      isCurrentProviderQuotaObservation(
        {
          source: 'sdk_rate_limit_event',
          observedAt: now - 60_000,
          status: 'rejected',
          resetsAt: now / 1000 - 1,
        },
        now,
      ),
    ).toBe(false);
    expect(
      isCurrentProviderQuotaObservation(
        {
          source: 'sdk_rate_limit_event',
          observedAt: now - 6 * 60_000,
          status: 'allowed',
        },
        now,
      ),
    ).toBe(false);
  });

  test('formats nullable and invalid reset timestamps safely', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T08:00:00.000Z'));
    expect(formatResetTime(null)).toBeNull();
    expect(formatResetTime('invalid')).toBeNull();
    expect(formatResetTime('2026-09-02T10:30:00.000Z')).toBe('2h 30m');
  });

  test('renders dynamic model windows, Extra fallback, and live status in a wrapping grid', async () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    apiMock.get.mockResolvedValue({
      fetchedAt: Date.now(),
      data: {
        five_hour: {
          utilization: 12.5,
          resets_at: '2099-09-02T10:00:00.000Z',
        },
        seven_day: null,
        seven_day_oauth_apps: null,
        seven_day_opus: null,
        seven_day_sonnet: null,
        model_scoped: [
          {
            display_name: 'Fable future window with a long server label',
            utilization: 61.25,
            resets_at: null,
          },
        ],
        extra_usage: {
          is_enabled: true,
          monthly_limit: 10_000,
          used_credits: 2_500,
          utilization: null,
          currency: 'USD',
        },
      },
      observation: {
        source: 'sdk_rate_limit_event',
        observedAt: Date.now(),
        status: 'allowed_warning',
        rateLimitType: 'seven_day',
        utilization: 0.53,
        resetsAt: 4_102_444_800,
      },
    });

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<UsageBars providerId="provider-a" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMock.get).toHaveBeenCalledWith(
      '/api/config/claude/providers/provider-a/usage',
    );
    expect(container.textContent).toContain('Live');
    expect(container.textContent).toContain('接近限额');
    expect(container.textContent).toContain('53%');
    expect(container.textContent).toContain('Fable future window');
    expect(container.textContent).toContain('Extra');
    expect(container.textContent).toContain('25%');
    expect(container.textContent).toContain('100');
    expect(container.querySelector('.grid.min-w-0.grid-cols-1')).not.toBeNull();
    expect(
      container.querySelector('[title^="Fable future window"]'),
    ).not.toBeNull();
  });

  test('marks a stale fallback instead of presenting it as freshly fetched', async () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    apiMock.get.mockResolvedValue({
      fetchedAt: Date.parse('2026-09-02T08:00:00.000Z'),
      error: 'Usage API returned 503',
      data: {
        five_hour: { utilization: 40, resets_at: null },
        seven_day: null,
        seven_day_oauth_apps: null,
        seven_day_opus: null,
        seven_day_sonnet: null,
        model_scoped: [],
        extra_usage: null,
      },
      observation: null,
    });

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <UsageBars providerId="provider-stale" providerVersion="v1" />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('暂时无法刷新，显示上次数据');
    expect(container.textContent).toContain('40%');
    expect(
      container.querySelector('[title="Usage API returned 503"]'),
    ).not.toBeNull();
  });
});
