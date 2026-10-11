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

const officialProvider: ProviderWithHealth = {
  id: 'claude',
  name: 'Claude 官方',
  type: 'official',
  enabled: true,
  weight: 1,
  anthropicBaseUrl: '',
  anthropicModel: '',
  anthropicAuthMode: null,
  hasAnthropicAuthToken: false,
  anthropicAuthTokenMasked: null,
  hasAnthropicApiKey: false,
  anthropicApiKeyMasked: null,
  hasClaudeCodeOauthToken: false,
  claudeCodeOauthTokenMasked: null,
  hasClaudeOAuthCredentials: true,
  claudeOAuthCredentialsExpiresAt: Date.now() - 1000,
  claudeOAuthCredentialsAccessTokenMasked: 'sk-a***',
  claudeAuthKind: 'oauth',
  claudeOAuthAccountEmail: 'owner@example.com',
  claudeOAuthSubscriptionType: 'max',
  claudeOAuthNeedsReLogin: true,
  claudeOAuthLastRefreshError: {
    kind: 'invalid_grant',
    message: 'Refresh token was revoked',
    at: 1,
  },
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

describe('official provider editor', () => {
  test('shows the account and a needed re-login', async () => {
    await render(officialProvider);
    const text = document.body.textContent ?? '';
    expect(text).toContain('授权已失效，需要重新登录 Claude');
    expect(text).toContain('Refresh token was revoked');
    expect(text).toContain('owner@example.com（max）');
  });

  test('a pasted credential is sent raw for the server to parse', async () => {
    await render(officialProvider);
    await click(button('Setup Token'));
    await type(
      '#provider-setup-token',
      '  {"claudeAiOauth":{"accessToken":"a"}}  ',
    );
    await click(button('保存'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/config/claude/providers/claude/secrets',
      { claudeCredentialInput: '{"claudeAiOauth":{"accessToken":"a"}}' },
    );
  });

  test('the setup-token login asks the server for that profile', async () => {
    mocks.post.mockResolvedValue({
      authorizeUrl: 'https://x.test',
      state: 's',
    });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await render(officialProvider);
    await click(button('改为获取 1 年期 Setup Token'));
    expect(mocks.post).toHaveBeenCalledWith('/api/config/claude/oauth/start', {
      targetProviderId: 'claude',
      profile: 'setup_token',
    });
    expect(open).toHaveBeenCalledWith(
      'https://x.test',
      '_blank',
      'noopener,noreferrer',
    );
  });
});
