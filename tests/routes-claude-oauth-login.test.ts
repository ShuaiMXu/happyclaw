import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-claude-oauth-login-'),
);

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: tmpDir,
  STORE_DIR: path.join(tmpDir, 'db'),
  GROUPS_DIR: path.join(tmpDir, 'groups'),
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const currentUser = { id: 'oauth-admin', username: 'oauth-admin' };

vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/middleware/auth.ts')>();
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: currentUser.id,
        username: currentUser.username,
        display_name: currentUser.username,
        role: 'admin',
        status: 'active',
        permissions: [],
        must_change_password: false,
      });
      return next();
    },
  };
});

const web = await import('../src/web.js');
const db = await import('../src/db.js');
const runtimeConfig = await import('../src/runtime-config.js');
const refresh = await import('../src/claude-oauth-refresh.js');

const closeAllActiveForCredentialRefresh = vi.fn(() => 0);
const drainProviderRunnersForCredentialRefresh = vi.fn(() => 0);
const app = web.createAppForTest({
  queue: {
    stopGroup: vi.fn(async () => {}),
    listDescendantJids: () => [],
    pauseGroupsForMutation: () => ({ id: 0 }),
    resumeGroupsAfterMutation: vi.fn(),
    closeAllActiveForCredentialRefresh,
    drainProviderRunnersForCredentialRefresh,
  },
  getRegisteredGroups: () => ({}),
  sessions: {},
} as any);

const originalFetch = globalThis.fetch;
const HOUR = 60 * 60_000;
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function post(url: string, body: unknown) {
  return app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function put(url: string, body: unknown) {
  return app.request(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function startFlow(body: Record<string, unknown> = {}) {
  const response = await post('/api/config/claude/oauth/start', body);
  expect(response.status).toBe(200);
  return (await response.json()) as { authorizeUrl: string; state: string };
}

function fullLoginFetch(
  token: Record<string, unknown> = {},
  profile: Record<string, unknown> | null = {
    account: { uuid: 'acct-login', email: 'login@example.com' },
    organization: {
      uuid: 'org-login',
      name: 'Login Org',
      organization_type: 'claude_max',
    },
  },
) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url) === TOKEN_URL) {
      return json({
        access_token: 'login-access',
        refresh_token: 'login-refresh',
        expires_in: 28_800,
        scope:
          'user:inference user:profile user:sessions:claude_code user:mcp_servers',
        account: { uuid: 'acct-login', email_address: 'login@example.com' },
        organization: { uuid: 'org-login' },
        ...token,
      });
    }
    if (String(url) === PROFILE_URL) {
      return profile ? json(profile) : new Response('', { status: 500 });
    }
    throw new Error(`unexpected request ${String(url)}`);
  }) as typeof fetch;
  return requests;
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });
  db.initDatabase();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  currentUser.id = 'oauth-admin';
  currentUser.username = 'oauth-admin';
  closeAllActiveForCredentialRefresh.mockClear();
  drainProviderRunnersForCredentialRefresh.mockClear();
  refresh.resetClaudeOAuthRefreshStateForTest();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('POST /claude/oauth/start', () => {
  test('returns the CLI authorize URL with code=true', async () => {
    const { authorizeUrl, state } = await startFlow();
    const url = new URL(authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://claude.com/cai/oauth/authorize',
    );
    expect([...url.searchParams.keys()]).toEqual([
      'code',
      'client_id',
      'response_type',
      'redirect_uri',
      'scope',
      'code_challenge',
      'code_challenge_method',
      'state',
    ]);
    expect(url.searchParams.get('code')).toBe('true');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://platform.claude.com/oauth/code/callback',
    );
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      'org:create_api_key',
      'user:profile',
      'user:inference',
      'user:sessions:claude_code',
      'user:mcp_servers',
      'user:file_upload',
      'user:plugins',
    ]);
    expect(url.searchParams.get('state')).toBe(state);
  });

  test('validates the target provider and profile', async () => {
    expect(
      (
        await post('/api/config/claude/oauth/start', {
          targetProviderId: 'missing-provider',
        })
      ).status,
    ).toBe(404);
    const thirdParty = runtimeConfig.createProvider({
      name: 'Third party target',
      type: 'third_party',
      anthropicBaseUrl: 'https://relay.example.com',
      anthropicAuthToken: 'relay-token',
    });
    expect(
      (
        await post('/api/config/claude/oauth/start', {
          targetProviderId: thirdParty.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (await post('/api/config/claude/oauth/start', { profile: 'other' }))
        .status,
    ).toBe(400);
  });
});

describe('POST /claude/oauth/callback', () => {
  test('creates a provider with account metadata from a full login', async () => {
    const { state } = await startFlow();
    const requests = fullLoginFetch();

    const response = await post('/api/config/claude/oauth/callback', {
      state,
      code: `the-code#${state}`,
    });
    expect(response.status).toBe(200);
    const body = await response.json();

    const exchange = requests.find((request) => request.url === TOKEN_URL)!;
    const exchangeBody = JSON.parse(String(exchange.init?.body));
    expect(Object.keys(exchangeBody)).toEqual([
      'grant_type',
      'code',
      'redirect_uri',
      'client_id',
      'code_verifier',
      'state',
    ]);
    expect(exchangeBody).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'https://platform.claude.com/oauth/code/callback',
      state,
    });
    expect(new Headers(exchange.init?.headers).get('User-Agent')).toBe(
      'axios/1.15.2',
    );
    const profileRequest = requests.find(
      (request) => request.url === PROFILE_URL,
    )!;
    expect(new Headers(profileRequest.init?.headers).get('Authorization')).toBe(
      'Bearer login-access',
    );

    expect(body).toMatchObject({
      name: '官方 Claude (login@example.com)',
      type: 'official',
      claudeAuthKind: 'oauth',
      claudeOAuthAccountEmail: 'login@example.com',
      claudeOAuthOrganizationName: 'Login Org',
      claudeOAuthOrganizationUuid: 'org-login',
      claudeOAuthSubscriptionType: 'max',
      claudeOAuthScopes: [
        'user:inference',
        'user:profile',
        'user:sessions:claude_code',
        'user:mcp_servers',
      ],
      claudeOAuthNeedsReLogin: false,
      claudeOAuthLastRefreshError: null,
    });
    const provider = runtimeConfig.getProviderById(body.id)!;
    expect(provider.claudeOAuthCredentials).toMatchObject({
      accessToken: 'login-access',
      refreshToken: 'login-refresh',
      subscriptionType: 'max',
    });
    expect(provider.claudeOAuthAccount).toMatchObject({
      accountUuid: 'acct-login',
    });

    // The flow is single-use.
    expect(
      (
        await post('/api/config/claude/oauth/callback', {
          state,
          code: 'the-code',
        })
      ).status,
    ).toBe(400);
  });

  test('accepts a callback page URL without a separate state', async () => {
    const { state } = await startFlow();
    fullLoginFetch({}, null);
    const response = await post('/api/config/claude/oauth/callback', {
      code: `https://platform.claude.com/oauth/code/callback?code=url-code&state=${state}`,
    });
    expect(response.status).toBe(200);
    // A failed profile read does not fail the login.
    expect(await response.json()).toMatchObject({
      claudeOAuthAccountEmail: 'login@example.com',
      claudeOAuthSubscriptionType: null,
    });
  });

  test('rejects a pasted state from another flow but keeps this flow', async () => {
    const { state } = await startFlow();
    globalThis.fetch = vi.fn();
    const mismatch = await post('/api/config/claude/oauth/callback', {
      state,
      code: 'the-code#some-other-state',
    });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toEqual({ error: 'State mismatch' });
    expect(globalThis.fetch).not.toHaveBeenCalled();

    fullLoginFetch();
    expect(
      (
        await post('/api/config/claude/oauth/callback', {
          state,
          code: 'the-code',
        })
      ).status,
    ).toBe(200);
  });

  test('binds the flow to the user who started it', async () => {
    const { state } = await startFlow();
    currentUser.id = 'other-admin';
    currentUser.username = 'other-admin';
    globalThis.fetch = vi.fn();
    const response = await post('/api/config/claude/oauth/callback', {
      state,
      code: 'stolen-code',
    });
    expect(response.status).toBe(403);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('keeps the flow after a transient exchange failure', async () => {
    const { state } = await startFlow();
    globalThis.fetch = vi.fn(async () => new Response('', { status: 503 }));
    const failed = await post('/api/config/claude/oauth/callback', {
      state,
      code: 'retry-code',
    });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ retryable: true });

    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(
      (
        await post('/api/config/claude/oauth/callback', {
          state,
          code: 'retry-code',
        })
      ).status,
    ).toBe(502);

    fullLoginFetch();
    expect(
      (
        await post('/api/config/claude/oauth/callback', {
          state,
          code: 'retry-code',
        })
      ).status,
    ).toBe(200);
  });

  test('drops the flow after a definitive rejection', async () => {
    const { state } = await startFlow();
    globalThis.fetch = vi.fn(async () => json({ error: 'invalid_grant' }, 400));
    const failed = await post('/api/config/claude/oauth/callback', {
      state,
      code: 'bad-code',
    });
    expect(failed.status).toBe(400);
    expect(await failed.json()).toMatchObject({ retryable: false });
    const retried = await post('/api/config/claude/oauth/callback', {
      state,
      code: 'bad-code',
    });
    expect(await retried.json()).toEqual({
      error: 'Invalid or expired OAuth state',
    });
  });

  test('re-login retires only the target provider runners and keeps same-account sessions', async () => {
    const target = runtimeConfig.createProvider({
      name: 'Re-login target',
      type: 'official',
      enabled: true,
      claudeOAuthCredentials: {
        accessToken: 'dead-access',
        refreshToken: 'dead-refresh',
        expiresAt: Date.now() - HOUR,
        scopes: ['user:inference', 'user:profile'],
      },
      claudeOAuthAccount: { accountUuid: 'acct-login' },
    });
    db.setSession('relogin-folder', 'claude-session-1');
    db.setSessionProviderId('relogin-folder', null, target.id);

    const { state } = await startFlow({ targetProviderId: target.id });
    fullLoginFetch();
    const response = await post('/api/config/claude/oauth/callback', {
      state,
      code: 'relogin-code',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: target.id,
      claudeAuthKind: 'oauth',
    });
    expect(drainProviderRunnersForCredentialRefresh).toHaveBeenCalledWith(
      target.id,
    );
    expect(closeAllActiveForCredentialRefresh).not.toHaveBeenCalled();
    expect(db.getSession('relogin-folder')).toBe('claude-session-1');
    expect(
      runtimeConfig.getProviderById(target.id)?.claudeOAuthCredentials
        ?.accessToken,
    ).toBe('login-access');
  });

  test('a login into another account invalidates the provider sessions', async () => {
    const target = runtimeConfig.createProvider({
      name: 'Account switch target',
      type: 'official',
      enabled: true,
      claudeOAuthCredentials: {
        accessToken: 'switch-access',
        refreshToken: 'switch-refresh',
        expiresAt: Date.now() + 8 * HOUR,
        scopes: ['user:inference', 'user:profile'],
      },
      claudeOAuthAccount: { accountUuid: 'acct-previous' },
    });
    db.setSession('switch-folder', 'claude-session-2');
    db.setSessionProviderId('switch-folder', null, target.id);

    const { state } = await startFlow({ targetProviderId: target.id });
    fullLoginFetch();
    expect(
      (
        await post('/api/config/claude/oauth/callback', {
          state,
          code: 'switch-code',
        })
      ).status,
    ).toBe(200);
    expect(db.getSession('switch-folder')).toBeUndefined();
    expect(closeAllActiveForCredentialRefresh).not.toHaveBeenCalled();
  });

  test('stores a setup-token login and clears stale OAuth credentials', async () => {
    const target = runtimeConfig.createProvider({
      name: 'Setup-token target',
      type: 'official',
      enabled: false,
      claudeOAuthCredentials: {
        accessToken: 'stale-access',
        refreshToken: 'stale-refresh',
        expiresAt: Date.now() + 8 * HOUR,
        scopes: ['user:inference', 'user:profile'],
      },
    });
    const { authorizeUrl, state } = await startFlow({
      targetProviderId: target.id,
      profile: 'setup_token',
    });
    expect(new URL(authorizeUrl).searchParams.get('scope')).toBe(
      'user:inference',
    );
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return json({
        access_token: 'sk-ant-oat01-long-lived',
        expires_in: 31_536_000,
        scope: 'user:inference',
        account: { uuid: 'acct-setup', email_address: 'setup@example.com' },
      });
    });
    const response = await post('/api/config/claude/oauth/callback', {
      state,
      code: 'setup-code',
    });
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0].expires_in).toBe(31_536_000);
    expect(await response.json()).toMatchObject({
      claudeAuthKind: 'setup_token',
      hasClaudeOAuthCredentials: false,
      claudeOAuthAccountEmail: 'setup@example.com',
    });
    const stored = runtimeConfig.getProviderById(target.id)!;
    expect(stored.claudeOAuthCredentials).toBeNull();
    expect(stored.claudeCodeOauthToken).toBe('sk-ant-oat01-long-lived');
  });

  test('a full login answered without a refresh token clears stale OAuth credentials', async () => {
    const target = runtimeConfig.createProvider({
      name: 'No refresh token target',
      type: 'official',
      enabled: false,
      claudeOAuthCredentials: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: Date.now() + 8 * HOUR,
        scopes: ['user:inference', 'user:profile'],
      },
    });
    const { state } = await startFlow({ targetProviderId: target.id });
    fullLoginFetch({ refresh_token: undefined });
    expect(
      (
        await post('/api/config/claude/oauth/callback', {
          state,
          code: 'no-refresh-code',
        })
      ).status,
    ).toBe(200);
    const stored = runtimeConfig.getProviderById(target.id)!;
    expect(stored.claudeOAuthCredentials).toBeNull();
    expect(stored.claudeCodeOauthToken).toBe('login-access');
  });
});

describe('Claude provider credential writes', () => {
  const credentialsFile = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'pasted-access',
      refreshToken: 'pasted-refresh',
      expiresAt: 1_900_000_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'pro',
    },
  });

  test('parses a pasted .credentials.json on create', async () => {
    const response = await post('/api/config/claude/providers', {
      name: 'Pasted credentials',
      type: 'official',
      claudeCredentialInput: credentialsFile,
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      claudeAuthKind: 'oauth',
      claudeOAuthSubscriptionType: 'pro',
      claudeOAuthCredentialsExpiresAt: 1_900_000_000_000,
    });
    expect(
      runtimeConfig.getProviderById(body.id)?.claudeOAuthCredentials,
    ).toEqual({
      accessToken: 'pasted-access',
      refreshToken: 'pasted-refresh',
      expiresAt: 1_900_000_000_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'pro',
    });
  });

  test('stores a pasted bare token as a setup-token', async () => {
    const response = await post('/api/config/claude/providers', {
      name: 'Pasted setup-token',
      type: 'official',
      claudeCredentialInput: 'sk-ant-oat01-pasted',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      claudeAuthKind: 'setup_token',
      hasClaudeOAuthCredentials: false,
    });
  });

  test.each([
    [
      'broken JSON',
      { claudeCredentialInput: '{"claudeAiOauth":' },
      '不是有效的 JSON',
    ],
    [
      'JSON without tokens',
      { claudeCredentialInput: '{"claudeAiOauth":{"accessToken":"a"}}' },
      '缺少',
    ],
    [
      'a paste combined with an API key',
      {
        claudeCredentialInput: 'sk-ant-oat01-x',
        anthropicApiKey: 'sk-ant-api',
      },
      '不能与其他凭据字段同时提交',
    ],
    [
      'two auth kinds at once',
      {
        anthropicApiKey: 'sk-ant-api03-x',
        claudeCodeOauthToken: 'sk-ant-oat01-y',
      },
      '一次只能设置一种官方认证方式',
    ],
  ])('rejects %s on create', async (_label, fields, message) => {
    const response = await post('/api/config/claude/providers', {
      name: 'Rejected create',
      type: 'official',
      ...fields,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(message);
  });

  test('rejects a credential paste for a third-party provider', async () => {
    const response = await post('/api/config/claude/providers', {
      name: 'Rejected third party',
      type: 'third_party',
      anthropicBaseUrl: 'https://relay.example.com',
      claudeCredentialInput: 'sk-ant-oat01-x',
    });
    expect(response.status).toBe(400);
  });

  test('keeps exactly one auth kind across secret updates', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'Auth kind switching',
      type: 'official',
      enabled: false,
      claudeOAuthCredentials: {
        accessToken: 'kind-access',
        refreshToken: 'kind-refresh',
        expiresAt: Date.now() + 8 * HOUR,
        scopes: ['user:inference', 'user:profile'],
      },
    });
    const secretsUrl = `/api/config/claude/providers/${provider.id}/secrets`;

    const toSetupToken = await put(secretsUrl, {
      claudeCodeOauthToken: 'sk-ant-oat01-switch',
    });
    expect(toSetupToken.status).toBe(200);
    expect((await toSetupToken.json()).provider).toMatchObject({
      claudeAuthKind: 'setup_token',
      hasClaudeOAuthCredentials: false,
    });
    expect(drainProviderRunnersForCredentialRefresh).toHaveBeenCalledWith(
      provider.id,
    );
    expect(closeAllActiveForCredentialRefresh).not.toHaveBeenCalled();

    const toOAuth = await put(secretsUrl, {
      claudeCredentialInput: credentialsFile,
    });
    expect(toOAuth.status).toBe(200);
    expect((await toOAuth.json()).provider).toMatchObject({
      claudeAuthKind: 'oauth',
      hasClaudeCodeOauthToken: false,
    });

    const toApiKey = await put(secretsUrl, {
      anthropicApiKey: 'sk-ant-api03-switch',
    });
    expect(toApiKey.status).toBe(200);
    expect((await toApiKey.json()).provider).toMatchObject({
      claudeAuthKind: 'api_key',
      hasClaudeOAuthCredentials: false,
      hasClaudeCodeOauthToken: false,
    });

    const malformed = await put(secretsUrl, {
      claudeCredentialInput: '{"claudeAiOauth":{"refreshToken":"r"}}',
    });
    expect(malformed.status).toBe(400);
    expect(runtimeConfig.getProviderById(provider.id)?.anthropicApiKey).toBe(
      'sk-ant-api03-switch',
    );
  });
});

describe('Claude provider usage statuses', () => {
  test('reports a setup-token provider as unsupported without a request', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'Usage setup-token',
      type: 'official',
      claudeCodeOauthToken: 'sk-ant-oat01-usage',
    });
    globalThis.fetch = vi.fn();
    const response = await app.request(
      `/api/config/claude/providers/${provider.id}/usage`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'unsupported',
      unsupportedReason: 'setup_token',
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('reports an inference-only grant as unsupported without a request', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'Usage inference-only',
      type: 'official',
      claudeOAuthCredentials: {
        accessToken: 'inference-access',
        refreshToken: 'inference-refresh',
        expiresAt: Date.now() + 8 * HOUR,
        scopes: ['user:inference'],
      },
    });
    globalThis.fetch = vi.fn();
    expect(
      await (
        await app.request(`/api/config/claude/providers/${provider.id}/usage`)
      ).json(),
    ).toMatchObject({
      status: 'unsupported',
      unsupportedReason: 'inference_only',
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('turns a scope 403 from the usage endpoint into unsupported', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'Usage 403',
      type: 'official',
      claudeOAuthCredentials: {
        accessToken: 'forbidden-access',
        refreshToken: 'forbidden-refresh',
        expiresAt: Date.now() + 8 * HOUR,
        scopes: ['user:inference', 'user:profile'],
      },
    });
    globalThis.fetch = vi.fn(async () =>
      json(
        {
          type: 'error',
          error: {
            type: 'permission_error',
            message: 'OAuth token does not meet scope requirement user:profile',
          },
        },
        403,
      ),
    );
    const usageUrl = `/api/config/claude/providers/${provider.id}/usage`;
    const response = await app.request(usageUrl);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      status: 'unsupported',
      unsupportedReason: 'inference_only',
    });
    expect(body.error).toBeUndefined();
    await app.request(usageUrl);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  test('reports needs_relogin when the refresh grant is rejected', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'Usage dead grant',
      type: 'official',
      claudeOAuthCredentials: {
        accessToken: 'dead-usage-access',
        refreshToken: 'dead-usage-refresh',
        expiresAt: Date.now() - 1,
        scopes: ['user:inference', 'user:profile'],
      },
    });
    globalThis.fetch = vi.fn(async () => json({ error: 'invalid_grant' }, 400));
    const usageUrl = `/api/config/claude/providers/${provider.id}/usage`;
    const response = await app.request(usageUrl);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'needs_relogin',
      error: 'OAuth token refresh returned 400 (invalid_grant)',
    });
    // The rejection is persisted; later polls neither refresh nor read usage.
    await app.request(usageUrl);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(
      runtimeConfig.toPublicProvider(
        runtimeConfig.getProviderById(provider.id)!,
      ),
    ).toMatchObject({
      claudeOAuthNeedsReLogin: true,
      claudeOAuthLastRefreshError: { kind: 'invalid_grant' },
    });
  });

  test('falls back to the last snapshot when an expired token cannot be refreshed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T08:00:00.000Z'));
    const provider = runtimeConfig.createProvider({
      name: 'Usage expired transient refresh',
      type: 'official',
      claudeOAuthCredentials: {
        accessToken: 'expiring-access',
        refreshToken: 'expiring-refresh',
        expiresAt: Date.now() + 61 * 60_000,
        scopes: ['user:inference', 'user:profile'],
      },
    });
    const usageUrl = `/api/config/claude/providers/${provider.id}/usage`;
    globalThis.fetch = vi.fn(async () =>
      json({ five_hour: { utilization: 33, resets_at: null } }),
    );
    const first = await (await app.request(usageUrl)).json();

    await vi.advanceTimersByTimeAsync(62 * 60_000);
    globalThis.fetch = vi.fn(async () => new Response('', { status: 503 }));
    const response = await app.request(usageUrl);
    expect(response.status).toBe(200);
    const second = await response.json();
    expect(second.data.five_hour.utilization).toBe(33);
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(second.error).toBe('OAuth token refresh returned 503');
    // Only the refresh was attempted; the expired token was not sent.
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  test('keeps using a still-valid token when a proactive refresh fails transiently', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'Usage transient refresh',
      type: 'official',
      claudeOAuthCredentials: {
        accessToken: 'window-access',
        refreshToken: 'window-refresh',
        expiresAt: Date.now() + 10 * 60_000,
        scopes: ['user:inference', 'user:profile'],
      },
    });
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url) === TOKEN_URL) return new Response('', { status: 502 });
      return json({ five_hour: { utilization: 12, resets_at: null } });
    });
    const response = await app.request(
      `/api/config/claude/providers/${provider.id}/usage`,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data.five_hour.utilization).toBe(12);
    expect(calls).toEqual([
      TOKEN_URL,
      'https://api.anthropic.com/api/oauth/usage',
    ]);
  });
});
