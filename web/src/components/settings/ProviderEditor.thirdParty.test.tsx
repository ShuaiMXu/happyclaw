// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ProviderWithHealth } from './types';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    put: mocks.put,
  },
}));

const { ProviderEditor } = await import('./ProviderEditor');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const legacyProvider: ProviderWithHealth = {
  id: 'glm',
  name: 'GLM',
  type: 'third_party',
  enabled: true,
  weight: 1,
  anthropicBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
  anthropicModel: 'glm-5.3',
  anthropicAuthMode: null,
  hasAnthropicAuthToken: true,
  anthropicAuthTokenMasked: 'glm-***',
  hasAnthropicApiKey: false,
  anthropicApiKeyMasked: null,
  hasClaudeCodeOauthToken: false,
  claudeCodeOauthTokenMasked: null,
  hasClaudeOAuthCredentials: false,
  claudeOAuthCredentialsExpiresAt: null,
  claudeOAuthCredentialsAccessTokenMasked: null,
  hasCodexOAuthCredentials: false,
  codexOAuthCredentialsExpiresAt: null,
  codexOAuthCredentialsEmail: null,
  codexOAuthCredentialsPlanType: null,
  customEnv: {},
  updatedAt: '2026-10-01T00:00:00.000Z',
  health: null,
};

let root: Root;
let container: HTMLDivElement;
const onSave = vi.fn();
const setNotice = vi.fn();
const setError = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockRejectedValue(new Error('offline catalog'));
  mocks.post.mockResolvedValue({});
  mocks.patch.mockResolvedValue({});
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function render(provider: ProviderWithHealth | null) {
  await act(async () => {
    root.render(
      <ProviderEditor
        open
        provider={provider}
        onSave={onSave}
        onCancel={() => {}}
        setNotice={setNotice}
        setError={setError}
      />,
    );
  });
}

function setValue(element: Element | null, value: string) {
  if (!element) throw new Error('field not found');
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`button "${label}" not found`);
  return match;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

async function type(selector: string, value: string) {
  await act(async () => {
    setValue(document.querySelector(selector), value);
  });
}

describe('third-party provider editor', () => {
  test('a pasted alias fills the form and creates a Bearer provider', async () => {
    await render(null);
    await type(
      'textarea[aria-label="粘贴 alias 或环境变量"]',
      'alias dcc="CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432 ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic ANTHROPIC_AUTH_TOKEN=sk-fake ANTHROPIC_MODEL=deepseek-v4-pro[1m] ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash[1m] claude"',
    );
    await click(button('解析'));
    await click(button('填入表单'));
    await click(button('创建'));

    expect(mocks.post).toHaveBeenCalledWith('/api/config/claude/providers', {
      name: 'dcc',
      type: 'third_party',
      anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
      anthropicAuthToken: 'sk-fake',
      anthropicAuthMode: 'bearer',
      anthropicModel: 'deepseek-v4-pro[1m]',
      customEnv: {
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash[1m]',
      },
    });
    expect(onSave).toHaveBeenCalled();
  });

  test('a pasted [1m] model turns on 1M context instead of being lost', async () => {
    await render(null);
    await type('#provider-model', 'glm-5.3[1m]');
    expect(
      (document.querySelector('#provider-model') as HTMLInputElement).value,
    ).toBe('glm-5.3');
    expect(
      document
        .querySelector('#provider-one-million-context')
        ?.getAttribute('aria-checked'),
    ).toBe('true');
  });

  test('editing saves the new key in the same PATCH and keeps a legacy mode', async () => {
    await render(legacyProvider);
    await type('#provider-auth-token', 'glm-new-key');
    await click(button('保存'));

    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.patch).toHaveBeenCalledWith(
      '/api/config/claude/providers/glm',
      {
        name: 'GLM',
        customEnv: {},
        anthropicBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
        anthropicAuthToken: 'glm-new-key',
        anthropicModel: 'glm-5.3',
      },
    );
    expect(mocks.put).not.toHaveBeenCalled();
  });

  test('test connection probes the draft and shows the outcome', async () => {
    mocks.post.mockResolvedValue({
      ok: true,
      probes: [
        { model: 'kimi-for-coding', ok: true, status: 200, latencyMs: 321 },
      ],
    });
    await render(null);
    await click(button('Kimi'));
    await type('#provider-auth-token', 'sk-kimi-fake');
    await click(button('测试连接'));

    expect(mocks.post).toHaveBeenCalledWith(
      '/api/config/claude/providers/test',
      {
        anthropicBaseUrl: 'https://api.kimi.com/coding/',
        anthropicAuthToken: 'sk-kimi-fake',
        anthropicAuthMode: 'bearer',
        anthropicModel: 'kimi-for-coding[1m]',
        customEnv: {},
      },
      60_000,
    );
    expect(document.body.textContent).toContain('连接成功（321 ms）');
  });
});
