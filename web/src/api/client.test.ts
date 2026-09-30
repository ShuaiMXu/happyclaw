// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  apiFetch,
  postFormDataWithUploadProgress,
  postJsonWithUploadProgress,
} from './client';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('apiFetch authentication errors', () => {
  test('preserves a 401 response so the login page can show a helpful message', async () => {
    window.history.replaceState({}, '', '/login');
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid credentials' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as typeof fetch;

    await expect(apiFetch('/api/auth/login')).rejects.toEqual({
      status: 401,
      message: 'Invalid credentials',
      body: { error: 'Invalid credentials' },
    });
  });
});

class MockXmlHttpRequest {
  static latest: MockXmlHttpRequest | undefined;

  upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  withCredentials = false;
  timeout = 0;
  status = 0;
  statusText = '';
  responseText = '';
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onload: (() => void) | null = null;
  readonly open = vi.fn();
  readonly setRequestHeader = vi.fn();
  readonly send = vi.fn();
  readonly abort = vi.fn();

  constructor() {
    MockXmlHttpRequest.latest = this;
  }
}

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

describe('postJsonWithUploadProgress', () => {
  test('reports browser upload bytes and resolves the JSON response', async () => {
    vi.stubGlobal('XMLHttpRequest', MockXmlHttpRequest);

    const progress = vi.fn();
    const pending = postJsonWithUploadProgress<{ success: boolean }>(
      '/api/messages',
      { content: 'hello' },
      { onProgress: progress, timeoutMs: 30_000 },
    );
    const request = MockXmlHttpRequest.latest!;

    expect(request.open).toHaveBeenCalledWith('POST', '/api/messages', true);
    expect(request.withCredentials).toBe(true);
    expect(request.timeout).toBe(30_000);
    expect(request.setRequestHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/json',
    );
    expect(request.send).toHaveBeenCalledWith('{"content":"hello"}');

    request.upload.onprogress?.({
      loaded: 25,
      total: 100,
      lengthComputable: true,
    } as ProgressEvent);
    expect(progress).toHaveBeenCalledWith({ loaded: 25, total: 100 });

    request.status = 201;
    request.responseText = '{"success":true}';
    request.onload?.();
    await expect(pending).resolves.toEqual({ success: true });
  });

  test('preserves failed response details for attachment send retries', async () => {
    vi.stubGlobal('XMLHttpRequest', MockXmlHttpRequest);

    const pending = postJsonWithUploadProgress('/api/messages', {
      content: 'hello',
    });
    const request = MockXmlHttpRequest.latest!;
    request.status = 413;
    request.statusText = 'Payload Too Large';
    request.responseText = '{"error":"Attachment too large"}';
    request.onload?.();

    await expect(pending).rejects.toEqual({
      status: 413,
      message: 'Attachment too large',
      body: { error: 'Attachment too large' },
    });
  });

  test('uploads staged images as multipart without overriding its boundary', async () => {
    vi.stubGlobal('XMLHttpRequest', MockXmlHttpRequest);
    const formData = new FormData();
    formData.append('file', new File(['image'], 'photo.png', { type: 'image/png' }));
    const progress = vi.fn();

    const pending = postFormDataWithUploadProgress<{ attachment: string }>(
      '/api/groups/web%3Ag1/chat-attachments',
      formData,
      { onProgress: progress, timeoutMs: 30_000 },
    );
    const request = MockXmlHttpRequest.latest!;
    expect(request.open).toHaveBeenCalledWith(
      'POST',
      '/api/groups/web%3Ag1/chat-attachments',
      true,
    );
    expect(request.setRequestHeader).not.toHaveBeenCalled();
    expect(request.send).toHaveBeenCalledWith(formData);

    request.upload.onprogress?.({
      loaded: 40,
      total: 100,
      lengthComputable: true,
    } as ProgressEvent);
    expect(progress).toHaveBeenCalledWith({ loaded: 40, total: 100 });

    request.status = 201;
    request.responseText = '{"attachment":"staged"}';
    request.onload?.();
    await expect(pending).resolves.toEqual({ attachment: 'staged' });
  });

  test('rejects an already-aborted caller signal without waiting for XHR events', async () => {
    vi.stubGlobal('XMLHttpRequest', MockXmlHttpRequest);
    const controller = new AbortController();
    controller.abort();

    const pending = postFormDataWithUploadProgress(
      '/api/groups/web%3Ag1/chat-attachments',
      new FormData(),
      { signal: controller.signal },
    );

    await expect(pending).rejects.toEqual({
      status: 499,
      message: 'Request cancelled',
    });
    expect(MockXmlHttpRequest.latest!.send).not.toHaveBeenCalled();
  });
});
