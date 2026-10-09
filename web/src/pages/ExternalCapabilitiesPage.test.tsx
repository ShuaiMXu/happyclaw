// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../api/client', () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    delete: mocks.delete,
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

const { ExternalCapabilitiesPage } = await import('./ExternalCapabilitiesPage');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  mocks.get.mockReset();
  mocks.get.mockImplementation(async (path: string) => {
    if (path === '/api/external-capabilities') {
      return {
        capabilities: [
          {
            slug: 'quote-document-process',
            name: '结构化数据规整',
            description: '规整业务数据。',
            lifecycleStatus: 'draft',
            availability: 'building',
            workspace: {
              name: '数据规整',
              folder: 'flow-munrwfg2-u6u8',
              executionMode: 'container',
              targetReady: true,
              storageReady: true,
              releaseEnabled: true,
              networkReady: true,
              imageReady: false,
            },
            inputs: {
              schemaVersion: 1,
              acceptedMimeTypes: ['image/png'],
              maxFileBytes: 20 * 1024 * 1024,
              maxFilesPerRun: 10,
              maxTotalBytes: 50 * 1024 * 1024,
            },
          },
        ],
      };
    }
    if (path === '/api/external-capabilities/quote-document-process/keys') {
      return { keys: [] };
    }
    throw new Error(`Unexpected GET ${path}`);
  });
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

describe('ExternalCapabilitiesPage runner image readiness', () => {
  test('shows the immutable-image failure and blocks activation', async () => {
    await act(async () => {
      root?.render(<ExternalCapabilitiesPage />);
    });

    expect(container?.textContent).toContain('运行镜像');
    expect(container?.textContent).toContain(
      '运行镜像未固定到 sha256 摘要，不能启用或受理请求',
    );
    const activateButton = [
      ...(container?.querySelectorAll('button') ?? []),
    ].find((button) => button.textContent?.includes('启用能力'));
    expect(activateButton).toBeDefined();
    expect(activateButton?.hasAttribute('disabled')).toBe(true);
  });
});
