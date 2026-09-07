import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const showToastMock = vi.hoisted(() => vi.fn());

vi.mock('../web/src/utils/toast', () => ({
  showToast: showToastMock,
}));

vi.mock('../web/src/api/client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  apiFetch: vi.fn(),
  computeUploadTimeoutMs: (bytes: number) =>
    Math.min(600_000, Math.max(120_000, Math.ceil(bytes / (20 * 1024)) * 1000)),
}));

import { api, apiFetch } from '../web/src/api/client';
import { useFileStore } from '../web/src/stores/files';

const mockedApiFetch = vi.mocked(apiFetch);
const mockedGet = vi.mocked(api.get);

/**
 * apiFetch 抛出的是纯对象形态的 ApiError，不是 Error 实例。这一点是本文件多个
 * 断言的前提：用 `err instanceof Error` 取信息会退化成默认文案。
 */
function apiError(status: number, message = 'boom') {
  return { status, message };
}

function makeFile(name = 'paper.pdf', size = 124_758) {
  const file = new File(['x'], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

/**
 * 重试退避是真实的 2s / 5s。用假定时器推进，否则单个用例要真等 7 秒，
 * 且超时后挂起的重试会污染后续用例的 mock 计数。
 */
async function runUpload(jid: string, files: File[]) {
  const pending = useFileStore.getState().uploadFiles(jid, files);
  await vi.advanceTimersByTimeAsync(60_000);
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers();
  mockedApiFetch.mockReset();
  mockedGet.mockReset();
  showToastMock.mockReset();
  // loadFiles 在上传成功后刷新列表；给它一个合法响应，避免干扰 error 断言。
  mockedGet.mockResolvedValue({ files: [], currentPath: '' });
  useFileStore.setState({
    files: {},
    currentPath: {},
    loading: false,
    uploading: false,
    uploadProgress: null,
    error: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('文件上传重试', () => {
  test('408 后重试并最终成功——慢链路上反代读体超时是常见瞬时故障', async () => {
    mockedApiFetch
      .mockRejectedValueOnce(apiError(408, 'Request timeout'))
      .mockResolvedValueOnce({ success: true, files: ['paper.pdf'] });

    const ok = await runUpload('web:g1', [makeFile()]);

    expect(ok).toBe(true);
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    expect(useFileStore.getState().error).toBeNull();
  });

  test('网络错误（status 0）同样重试', async () => {
    mockedApiFetch
      .mockRejectedValueOnce(apiError(0, 'Network error'))
      .mockResolvedValueOnce({ success: true, files: ['paper.pdf'] });

    const ok = await runUpload('web:g1', [makeFile()]);

    expect(ok).toBe(true);
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
  });

  test.each([502, 503, 504])('%i 视为上游瞬时不可用，重试', async (status) => {
    mockedApiFetch
      .mockRejectedValueOnce(apiError(status))
      .mockResolvedValueOnce({ success: true, files: ['paper.pdf'] });

    const ok = await runUpload('web:g1', [makeFile()]);

    expect(ok).toBe(true);
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
  });

  test('连续失败最多尝试 3 次后放弃', async () => {
    mockedApiFetch.mockRejectedValue(apiError(408, 'Request timeout'));

    const ok = await runUpload('web:g1', [makeFile()]);

    expect(ok).toBe(false);
    expect(mockedApiFetch).toHaveBeenCalledTimes(3);
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(showToastMock).toHaveBeenCalledWith(
      '上传失败',
      '上传超时，请检查网络后重试',
    );
  });

  test('首次失败后立即进入第 2 次退避状态，sleep 前即可见', async () => {
    mockedApiFetch
      .mockRejectedValueOnce(apiError(408))
      .mockResolvedValueOnce({ success: true, files: ['paper.pdf'] });

    const pending = useFileStore.getState().uploadFiles('web:g1', [makeFile()]);
    await Promise.resolve();
    await Promise.resolve();

    expect(useFileStore.getState().uploadProgress).toMatchObject({
      attempt: 1,
      maxAttempts: 3,
      retrying: true,
      nextAttempt: 2,
      retryDelayMs: 2000,
    });

    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toBe(true);
  });

  test('第二次失败后准确显示即将进行第 3 次重试', async () => {
    mockedApiFetch
      .mockRejectedValueOnce(apiError(408))
      .mockRejectedValueOnce(apiError(503))
      .mockResolvedValueOnce({ success: true, files: ['paper.pdf'] });

    const pending = useFileStore.getState().uploadFiles('web:g1', [makeFile()]);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2000);

    expect(useFileStore.getState().uploadProgress).toMatchObject({
      attempt: 2,
      maxAttempts: 3,
      retrying: true,
      nextAttempt: 3,
      retryDelayMs: 5000,
    });

    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toBe(true);
  });

  test.each([
    [400, '参数错误'],
    [403, '配额或路径被拒'],
    [413, '超过大小上限'],
    [500, '服务端逻辑错误'],
  ])('%i（%s）不重试，立即失败', async (status) => {
    mockedApiFetch.mockRejectedValue(apiError(status));

    const ok = await runUpload('web:g1', [makeFile()]);

    expect(ok).toBe(false);
    // 重试这类错误没有意义，只会让用户多等两轮退避才看到真实原因
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
  });

  test('失败时暴露真实原因而非笼统文案', async () => {
    mockedApiFetch.mockRejectedValue(
      apiError(413, 'File paper.pdf exceeds maximum size of 100MB'),
    );

    await runUpload('web:g1', [makeFile()]);

    const { error } = useFileStore.getState();
    expect(error).toContain('exceeds maximum size of 100MB');
    expect(error).toContain('413');
    expect(error).not.toBe('Failed to upload files');
    expect(showToastMock).toHaveBeenCalledWith('上传失败', error);
  });

  test('新上传会同步清除旧错误，且同一失败只通知一次', async () => {
    useFileStore.setState({ error: '上一次失败' });
    mockedApiFetch.mockRejectedValue(apiError(413, '文件太大'));

    const pending = useFileStore.getState().uploadFiles('web:g1', [makeFile()]);
    expect(useFileStore.getState().error).toBeNull();

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pending).resolves.toBe(false);
    expect(useFileStore.getState().error).toBe('文件太大 (HTTP 413)');
    expect(showToastMock).toHaveBeenCalledTimes(1);
  });

  test('Error 实例的信息也能正确提取', async () => {
    mockedApiFetch.mockRejectedValue(new Error('boom from fetch'));

    await runUpload('web:g1', [makeFile()]);

    expect(useFileStore.getState().error).toBe('boom from fetch');
  });

  test('逐文件独立重试：已成功的文件不会被重传', async () => {
    mockedApiFetch
      .mockResolvedValueOnce({ success: true, files: ['a.pdf'] })
      .mockRejectedValueOnce(apiError(408))
      .mockResolvedValueOnce({ success: true, files: ['b.pdf'] });

    const ok = await runUpload('web:g1', [
      makeFile('a.pdf'),
      makeFile('b.pdf'),
    ]);

    expect(ok).toBe(true);
    // a 一次成功；b 失败一次后重试成功 → 共 3 次，a 没有被重传
    expect(mockedApiFetch).toHaveBeenCalledTimes(3);
  });

  test('每次重试重建 FormData——body 已被上一次 fetch 消费，不能复用', async () => {
    mockedApiFetch
      .mockRejectedValueOnce(apiError(408))
      .mockResolvedValueOnce({ success: true, files: ['paper.pdf'] });

    await runUpload('web:g1', [makeFile()]);

    const bodies = mockedApiFetch.mock.calls.map(
      ([, init]) => (init as RequestInit | undefined)?.body,
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBeInstanceOf(FormData);
    expect(bodies[1]).toBeInstanceOf(FormData);
    expect(bodies[0]).not.toBe(bodies[1]);
  });

  test('整批结束后清理上传状态', async () => {
    mockedApiFetch.mockRejectedValue(apiError(408));

    await runUpload('web:g1', [makeFile()]);

    expect(useFileStore.getState().uploading).toBe(false);
    expect(useFileStore.getState().uploadProgress).toBeNull();
  });

  test('可取消正在进行的请求，且取消不重试、不报错、不弹失败提示', async () => {
    mockedApiFetch.mockImplementation((_path, options) => {
      const signal = options?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(apiError(499, 'Request cancelled')),
          { once: true },
        );
      });
    });

    const pending = useFileStore.getState().uploadFiles('web:g1', [makeFile()]);
    await Promise.resolve();
    const signal = mockedApiFetch.mock.calls[0]?.[1]?.signal;

    useFileStore.getState().cancelUpload();

    await expect(pending).resolves.toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    expect(useFileStore.getState().error).toBeNull();
    expect(useFileStore.getState().uploading).toBe(false);
    // The server may have committed before the aborted response reached the
    // browser, including for the first file where uploadedBytes is still zero.
    expect(mockedGet).toHaveBeenCalledWith('/api/groups/web%3Ag1/files?');
    expect(showToastMock).not.toHaveBeenCalled();
  });

  test('可取消退避等待，不会继续下一轮请求', async () => {
    mockedApiFetch.mockRejectedValueOnce(apiError(408, 'Request timeout'));

    const pending = useFileStore.getState().uploadFiles('web:g1', [makeFile()]);
    await Promise.resolve();
    await Promise.resolve();
    expect(useFileStore.getState().uploadProgress?.retrying).toBe(true);

    useFileStore.getState().cancelUpload();

    await expect(pending).resolves.toBe(false);
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    expect(useFileStore.getState().error).toBeNull();
    expect(showToastMock).not.toHaveBeenCalled();
  });

  test('空文件列表直接返回 false，不发请求', async () => {
    const ok = await useFileStore.getState().uploadFiles('web:g1', []);

    expect(ok).toBe(false);
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });
});
