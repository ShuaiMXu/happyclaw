// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { apiFetch } from './client';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe('apiFetch cancellation', () => {
  test('调用方 AbortSignal 会中断底层 fetch，并与请求超时区分', async () => {
    globalThis.fetch = vi.fn((_input, init) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    }) as typeof fetch;
    const controller = new AbortController();

    const pending = apiFetch('/api/upload-test', {
      method: 'POST',
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    const rejection = expect(pending).rejects.toEqual({
      status: 499,
      message: 'Request cancelled',
    });
    controller.abort();

    await rejection;
  });

  test('内部超时仍映射为 408', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn((_input, init) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    }) as typeof fetch;

    const pending = apiFetch('/api/upload-test', { timeoutMs: 10 });
    const rejection = expect(pending).rejects.toEqual({
      status: 408,
      message: 'Request timeout',
    });
    await vi.advanceTimersByTimeAsync(10);

    await rejection;
  });

  test('超时先发生时，随后调用方取消仍保持 408', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn((_input, init) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () =>
            queueMicrotask(() =>
              reject(new DOMException('Aborted', 'AbortError')),
            ),
          { once: true },
        );
      });
    }) as typeof fetch;
    const controller = new AbortController();

    const pending = apiFetch('/api/upload-test', {
      signal: controller.signal,
      timeoutMs: 10,
    });
    const rejection = expect(pending).rejects.toEqual({
      status: 408,
      message: 'Request timeout',
    });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();

    await rejection;
  });

  test('调用方使用自定义 abort reason 时仍归一化为 499', async () => {
    globalThis.fetch = vi.fn((_input, init) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new Error('custom abort reason')),
          { once: true },
        );
      });
    }) as typeof fetch;
    const controller = new AbortController();

    const pending = apiFetch('/api/upload-test', {
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    const rejection = expect(pending).rejects.toEqual({
      status: 499,
      message: 'Request cancelled',
    });
    controller.abort(new Error('caller-specific reason'));

    await rejection;
  });

  test('响应头到达后仍可取消停滞的响应体读取', async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn((_input, init) => {
      const signal = init?.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(streamController) {
              signal?.addEventListener(
                'abort',
                () =>
                  streamController.error(
                    new DOMException('Aborted', 'AbortError'),
                  ),
                { once: true },
              );
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }) as typeof fetch;

    const pending = apiFetch('/api/upload-test', {
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toEqual({
      status: 499,
      message: 'Request cancelled',
    });
  });
});
