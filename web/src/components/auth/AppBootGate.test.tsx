// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useAuthStore } from '../../stores/auth';
import { AppBootGate } from './AppBootGate';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const initialAuthState = useAuthStore.getState();
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  useAuthStore.setState(initialAuthState, true);
});

describe('AppBootGate', () => {
  test('keeps one root overlay mounted until its exit finishes', async () => {
    const checkAuth = vi.fn().mockResolvedValue(undefined);
    useAuthStore.setState({ checking: true, checkAuth });

    await act(async () => {
      root?.render(
        <AppBootGate>
          <div data-route-content="true">登录页</div>
        </AppBootGate>,
      );
    });

    expect(checkAuth).toHaveBeenCalledTimes(1);
    expect(
      container?.querySelector('[data-route-content="true"]'),
    ).not.toBeNull();
    expect(
      container?.querySelector('[data-app-boot-overlay="true"]'),
    ).not.toBeNull();

    await act(async () => {
      useAuthStore.setState({ checking: false });
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    const image = container?.querySelector(
      '[data-app-boot-overlay="true"] img',
    );
    expect(image).not.toBeNull();
    expect(image?.classList.contains('animate-pulse')).toBe(true);

    if (image) {
      Object.defineProperty(image, 'decode', { value: undefined });
    }
    await act(async () => {
      image?.dispatchEvent(new Event('load'));
    });
    expect(image?.classList.contains('hc-boot-exit')).toBe(true);

    await act(async () => {
      image?.dispatchEvent(new Event('animationend', { bubbles: true }));
    });

    expect(
      container?.querySelector('[data-app-boot-overlay="true"]'),
    ).toBeNull();
    expect(
      container?.querySelector('[data-route-content="true"]'),
    ).not.toBeNull();
  });
});
