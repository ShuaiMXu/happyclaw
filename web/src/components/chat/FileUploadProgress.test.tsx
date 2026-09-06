// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../stores/chat', () => {
  const state = {
    drafts: {},
    saveDraft: vi.fn(),
    clearDraft: vi.fn(),
  };
  return {
    useChatStore: (selector: (value: typeof state) => unknown) =>
      selector(state),
  };
});

vi.mock('../../hooks/useDisplayMode', () => ({
  useDisplayMode: () => ({ mode: 'default' }),
}));

vi.mock('../../hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

vi.mock('@/hooks/useKeyboardHeight', () => ({
  useKeyboardHeight: () => 0,
}));

vi.mock('../../lib/follow-up-preferences', () => ({
  FOLLOW_UP_MODE_KEY: 'test-follow-up-mode',
  FOLLOW_UP_MODE_CHANGED_EVENT: 'test-follow-up-mode-changed',
  getDefaultFollowUpMode: () => 'queue',
  alternateFollowUpMode: (mode: 'queue' | 'steer') =>
    mode === 'queue' ? 'steer' : 'queue',
}));

import { useFileStore, type UploadProgress } from '../../stores/files';
import { FileUploadZone } from './FileUploadZone';
import { MessageInput } from './MessageInput';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const cancelUpload = vi.fn();

const baseProgress: UploadProgress = {
  total: 1,
  completed: 0,
  currentFile: 'paper.pdf',
  totalBytes: 100,
  uploadedBytes: 0,
  attempt: 1,
  maxAttempts: 3,
  retrying: true,
  nextAttempt: 2,
  retryDelayMs: 2000,
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useFileStore.setState({
    uploading: true,
    uploadProgress: baseProgress,
    error: null,
    cancelUpload,
  });
  cancelUpload.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useFileStore.setState({
    uploading: false,
    uploadProgress: null,
    error: null,
    cancelUpload,
  });
});

function retryTexts(): string[] {
  return Array.from(
    container?.querySelectorAll('[data-upload-retry-status]') ?? [],
    (node) => node.textContent ?? '',
  );
}

describe('上传重试状态 UI', () => {
  test('文件面板与主消息输入框一致展示首个退避状态', async () => {
    await act(async () => {
      root?.render(
        <>
          <FileUploadZone groupJid="web:g1" />
          <MessageInput groupJid="web:g1" onSend={vi.fn()} />
        </>,
      );
    });

    expect(retryTexts()).toEqual(['（2 秒后重试 2/3）', '（2 秒后重试 2/3）']);
    const cancelButtons = container?.querySelectorAll('[data-upload-cancel]');
    expect(cancelButtons).toHaveLength(2);
    await act(async () => {
      cancelButtons?.forEach((button) =>
        button.dispatchEvent(new MouseEvent('click', { bubbles: true })),
      );
    });
    expect(cancelUpload).toHaveBeenCalledTimes(2);
  });

  test('两个入口同步展示第二个退避和实际重试轮次', async () => {
    await act(async () => {
      root?.render(
        <>
          <FileUploadZone groupJid="web:g1" />
          <MessageInput groupJid="web:g1" onSend={vi.fn()} />
        </>,
      );
    });

    await act(async () => {
      useFileStore.setState({
        uploadProgress: {
          ...baseProgress,
          attempt: 2,
          nextAttempt: 3,
          retryDelayMs: 5000,
        },
      });
    });
    expect(retryTexts()).toEqual(['（5 秒后重试 3/3）', '（5 秒后重试 3/3）']);

    await act(async () => {
      useFileStore.setState({
        uploadProgress: {
          ...baseProgress,
          attempt: 3,
          retrying: false,
          nextAttempt: undefined,
          retryDelayMs: undefined,
        },
      });
    });
    expect(retryTexts()).toEqual(['（正在重试 3/3）', '（正在重试 3/3）']);
  });
});
