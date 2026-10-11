// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/api/client', () => ({ api: { get: mocks.get } }));

const { UsageBars, codexWindowLabel } = await import('./UsageBars');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(<UsageBars providerId="chatgpt" />);
  });
}

describe('ChatGPT subscription usage', () => {
  test('shows the 5h and weekly windows with their reset', async () => {
    const now = Math.floor(Date.now() / 1000);
    mocks.get.mockResolvedValue({
      kind: 'codex_rate_limits',
      observedAt: Date.now(),
      activeLimit: 'codex',
      rateLimitReachedType: null,
      limits: [
        {
          limitId: 'codex',
          limitName: null,
          primary: {
            usedPercent: 42,
            windowMinutes: 300,
            resetsAt: now + 3600,
          },
          secondary: {
            usedPercent: 7,
            windowMinutes: 10080,
            resetsAt: now + 86400 * 3,
          },
          credits: { hasCredits: true, unlimited: false, balance: '12.5' },
        },
      ],
    });
    await render();
    const text = container.textContent ?? '';
    expect(text).toContain('5h');
    expect(text).toContain('42%');
    expect(text).toContain('7d');
    expect(text).toContain('7%');
    expect(text).toContain('余额 12.5');
    expect(text).toMatch(/1h|59m/);
  });

  test('explains that windows appear after a request and flags a reached limit', async () => {
    mocks.get.mockResolvedValue({
      kind: 'codex_rate_limits',
      observedAt: null,
      activeLimit: null,
      rateLimitReachedType: null,
      limits: [],
    });
    await render();
    expect(container.textContent).toContain('发出一次请求后显示');

    mocks.get.mockResolvedValue({
      kind: 'codex_rate_limits',
      observedAt: Date.now(),
      activeLimit: 'codex',
      rateLimitReachedType: 'primary',
      limits: [
        {
          limitId: 'codex',
          limitName: null,
          primary: { usedPercent: 100, windowMinutes: 300, resetsAt: null },
          secondary: null,
          credits: null,
        },
      ],
    });
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(container.textContent).toContain('已触达 ChatGPT 订阅限额');
  });

  test('window labels', () => {
    expect(codexWindowLabel(300)).toBe('5h');
    expect(codexWindowLabel(10080)).toBe('7d');
    expect(codexWindowLabel(90)).toBe('90m');
    expect(codexWindowLabel(null)).toBe('额度');
  });
});
