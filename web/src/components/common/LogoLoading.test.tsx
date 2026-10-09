// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useAuthStore, type AppearanceConfig } from '../../stores/auth';
import { LogoLoading } from './LogoLoading';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const initialAuthState = useAuthStore.getState();
const appearance: AppearanceConfig = {
  appName: 'Softopia AI',
  aiName: 'HappyClaw',
  aiAvatarEmoji: 'fe083',
  aiAvatarColor: '#ff6600',
  aiAvatarUrl: null,
  aiAvatarMode: 'emoji',
  brandIconUrl: null,
  brandBannerUrl: null,
  faviconUrl: null,
  brandLoadingIconUrl: '/api/config/brand-assets/custom-loading.png',
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
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

describe('LogoLoading', () => {
  test('waits for the image before running the boot exit flourish', async () => {
    const onExitComplete = vi.fn();
    await act(async () => {
      root?.render(
        <LogoLoading full exiting onExitComplete={onExitComplete} />,
      );
    });

    const image = container?.querySelector('img');
    expect(image?.classList.contains('animate-pulse')).toBe(true);
    expect(image?.classList.contains('hc-boot-exit')).toBe(false);

    await act(async () => {
      image?.dispatchEvent(new Event('load'));
      await Promise.resolve();
    });

    expect(image?.classList.contains('hc-boot-exit')).toBe(true);
    expect(image?.classList.contains('animate-pulse')).toBe(false);

    await act(async () => {
      image?.dispatchEvent(new Event('animationend', { bubbles: true }));
    });

    expect(onExitComplete).toHaveBeenCalledTimes(1);
  });

  test('falls back to the built-in mark when the configured image fails', async () => {
    useAuthStore.setState({ appearance });
    await act(async () => {
      root?.render(<LogoLoading full />);
    });

    const image = container?.querySelector('img');
    expect(image?.getAttribute('src')).toBe(
      '/api/config/brand-assets/custom-loading.png',
    );

    await act(async () => {
      image?.dispatchEvent(new Event('error'));
    });

    expect(image?.getAttribute('src')).toBe('/icons/loading-mark.png');
  });

  test('completes once when the animation event is lost', async () => {
    vi.useFakeTimers();
    const onExitComplete = vi.fn();
    await act(async () => {
      root?.render(
        <LogoLoading full exiting onExitComplete={onExitComplete} />,
      );
    });

    const image = container?.querySelector('img');
    await act(async () => {
      image?.dispatchEvent(new Event('load'));
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
    });

    expect(onExitComplete).toHaveBeenCalledTimes(1);

    await act(async () => {
      image?.dispatchEvent(new Event('animationend', { bubbles: true }));
    });
    expect(onExitComplete).toHaveBeenCalledTimes(1);
  });

  test('keeps the branded pulse while ordinary loading continues', async () => {
    const onExitComplete = vi.fn();
    await act(async () => {
      root?.render(<LogoLoading full onExitComplete={onExitComplete} />);
    });

    const image = container?.querySelector('img');
    expect(image?.classList.contains('animate-pulse')).toBe(true);
    expect(image?.classList.contains('hc-boot-exit')).toBe(false);

    await act(async () => {
      image?.dispatchEvent(new Event('animationend', { bubbles: true }));
    });

    expect(onExitComplete).not.toHaveBeenCalled();
  });
});
