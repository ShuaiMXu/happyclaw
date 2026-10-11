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

const codexProvider: ProviderWithHealth = {
  id: 'chatgpt',
  name: 'ChatGPT 订阅',
  type: 'third_party',
  enabled: true,
  weight: 1,
  anthropicBaseUrl: '__codex_gateway__',
  anthropicModel: 'gpt-6-sol',
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
  hasCodexOAuthCredentials: true,
  codexOAuthCredentialsExpiresAt: Date.now() + 3_600_000,
  codexOAuthCredentialsEmail: 'owner@example.com',
  codexOAuthCredentialsPlanType: 'pro',
  codexOAuthNeedsReauth: true,
  codexOAuthLastRefreshError: {
    kind: 'reauth_required',
    message: 'refresh_token_reused',
    at: '2026-10-11T00:00:00.000Z',
  },
  codexDefaultEffort: 'high',
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

describe('ChatGPT subscription editor', () => {
  test('flags a refused refresh and keeps the effective default effort', async () => {
    await render(codexProvider);
    // The account's own plan-filtered catalog, not the global one.
    expect(mocks.get).toHaveBeenCalledWith(
      '/api/config/codex/model-catalog?providerId=chatgpt',
    );
    expect(document.body.textContent).toContain(
      'ChatGPT 授权已失效，请重新登录',
    );
    expect(document.body.textContent).toContain('refresh_token_reused');
    expect(
      (document.querySelector('#codex-effort-select') as HTMLSelectElement)
        .value,
    ).toBe('high');

    await click(button('保存'));
    expect(mocks.patch).toHaveBeenCalledWith(
      '/api/config/claude/providers/chatgpt',
      {
        name: 'ChatGPT 订阅',
        anthropicModel: 'gpt-6-sol',
        customEnv: { CODEX_REASONING_EFFORT: 'high' },
      },
    );
  });

  test('the offline catalog marks the same default effort as the server', async () => {
    await render({
      ...codexProvider,
      anthropicModel: 'gpt-6-astra',
      codexOAuthNeedsReauth: false,
      codexOAuthLastRefreshError: null,
      codexDefaultEffort: undefined,
    });
    const effort = document.querySelector(
      '#codex-effort-select',
    ) as HTMLSelectElement;
    // No stored or resolved effort: the catalog default (gpt-6.1-sol's) applies.
    expect(effort.value).toBe('low');
    expect(
      [...effort.options].find((option) => option.text.endsWith('（默认）'))
        ?.value,
    ).toBe('low');
    const models = [
      ...(document.querySelector('#codex-model-select') as HTMLSelectElement)
        .options,
    ].map((option) => option.value);
    expect(models.slice(0, 3)).toEqual([
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-6-sol',
    ]);
  });

  test('a spent code sends the user back to log in again', async () => {
    mocks.post
      .mockResolvedValueOnce({ authorizeUrl: 'https://x.test', state: 's' })
      .mockRejectedValueOnce({
        status: 400,
        message: '授权码已失效',
        body: { retryable: false },
      });
    vi.spyOn(window, 'open').mockReturnValue(null);
    await render(codexProvider);
    await click(button('重新登录 ChatGPT'));
    await type(
      'input[aria-label^="粘贴 localhost:1455"]',
      'http://localhost:1455/auth/callback?code=c&state=s',
    );
    await click(button('确认'));
    expect(setError).toHaveBeenCalledWith('授权码已失效');
    expect(button('重新登录 ChatGPT')).toBeTruthy();
  });
});
