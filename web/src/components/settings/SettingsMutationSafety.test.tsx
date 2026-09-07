// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createAppearanceMutationQueue } from './AppearanceSection';
import { BalancingSettings } from './BalancingSettings';
import { createBalancingMutationQueue } from './ClaudeProviderSection';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

async function expectSerialized(
  createQueue: () => <T>(request: () => Promise<T>) => Promise<T>,
) {
  const calls: string[] = [];
  let releaseFirst!: (value: string) => void;
  const firstResponse = new Promise<string>((resolve) => {
    releaseFirst = resolve;
  });
  const enqueue = createQueue();

  const first = enqueue(async () => {
    calls.push('first-start');
    const value = await firstResponse;
    calls.push('first-finish');
    return value;
  });
  const second = enqueue(async () => {
    calls.push('second-start');
    return 'newer';
  });

  await Promise.resolve();
  expect(calls).toEqual(['first-start']);

  releaseFirst('older');
  await expect(first).resolves.toBe('older');
  await expect(second).resolves.toBe('newer');
  expect(calls).toEqual(['first-start', 'first-finish', 'second-start']);
}

describe('settings mutation sequencing', () => {
  test('serializes appearance snapshots submitted concurrently', async () => {
    await expectSerialized(createAppearanceMutationQueue);
  });

  test('serializes balancing PUTs submitted concurrently', async () => {
    await expectSerialized(createBalancingMutationQueue);
  });
});

describe('BalancingSettings accessibility and persistence timing', () => {
  test('labels controls and commits numeric drafts only on blur', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root?.render(
        <BalancingSettings
          balancing={{
            strategy: 'round-robin',
            unhealthyThreshold: 3,
            recoveryIntervalMs: 300_000,
          }}
          onChange={onChange}
          disabled={false}
          saving={false}
        />,
      );
    });

    const disclosure = container?.querySelector('button');
    expect(disclosure?.getAttribute('aria-expanded')).toBe('false');
    expect(disclosure?.getAttribute('aria-controls')).toBe(
      'balancing-settings-panel',
    );

    await act(async () => {
      disclosure?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(disclosure?.getAttribute('aria-expanded')).toBe('true');

    const threshold = container?.querySelector<HTMLInputElement>(
      '#balancing-unhealthy-threshold',
    );
    const recovery = container?.querySelector<HTMLInputElement>(
      '#balancing-recovery-interval',
    );
    expect(
      container?.querySelector<HTMLLabelElement>(
        'label[for="balancing-strategy"]',
      ),
    ).not.toBeNull();
    expect(
      container?.querySelector<HTMLLabelElement>(
        'label[for="balancing-unhealthy-threshold"]',
      ),
    ).not.toBeNull();
    expect(
      container?.querySelector<HTMLLabelElement>(
        'label[for="balancing-recovery-interval"]',
      ),
    ).not.toBeNull();

    await act(async () => {
      if (!threshold) return;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(threshold, '10');
      threshold.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalled();

    await act(async () => {
      threshold?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ unhealthyThreshold: 10 });

    onChange.mockClear();
    await act(async () => {
      if (!recovery) return;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(recovery, '5');
      recovery.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      recovery?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ recoveryIntervalMs: 30_000 });
  });
});
