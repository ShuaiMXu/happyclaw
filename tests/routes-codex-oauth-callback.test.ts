import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-codex-oauth-'));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: tmpDir,
  STORE_DIR: path.join(tmpDir, 'db'),
  GROUPS_DIR: path.join(tmpDir, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/middleware/auth.ts')>();
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: 'codex-oauth-admin',
        username: 'codex-oauth-admin',
        display_name: 'Codex OAuth Admin',
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
const { providerPool } = await import('../src/provider-pool.js');
const {
  CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
  CODEX_OAUTH_REVOKE_URL,
  CODEX_OAUTH_TOKEN_URL,
} = await import('../src/codex-gateway/types.js');

const queue = {
  listDescendantJids: () => [],
  pauseGroupsForMutation: () => ({ id: 1 }),
  resumeGroupsAfterMutation: vi.fn(),
  stopGroup: vi.fn(async () => {}),
  unblockGroupsForRuntimeSafety: vi.fn(),
  drainProviderRunnersForCredentialRefresh: vi.fn(() => 0),
};
const app = web.createAppForTest({
  queue,
  getRegisteredGroups: () => ({}),
  sessions: {},
} as any);

const tokenEndpoint = vi.fn();
const revokeEndpoint = vi.fn();

function jwt(payload: unknown): string {
  return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}
function tokenBody(accountId: string, email = `${accountId}@example.invalid`) {
  return {
    access_token: `access-${accountId}`,
    refresh_token: `refresh-${accountId}`,
    expires_in: 3600,
    id_token: jwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: accountId,
        chatgpt_plan_type: 'plus',
      },
      email,
    }),
  };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function startFlow(targetProviderId?: string): Promise<string> {
  const response = await app.request('/api/config/codex/oauth/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(targetProviderId ? { targetProviderId } : {}),
  });
  expect(response.status).toBe(200);
  return (await response.json()).state;
}
function callback(state: string, code: string): Promise<Response> {
  return app.request('/api/config/codex/oauth/callback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state, code }),
  });
}
const callbackUrl = (state: string, host = 'localhost') =>
  `http://${host}:1455/auth/callback?code=auth-code&state=${state}`;

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });
  db.initDatabase();
});

beforeEach(() => {
  fs.rmSync(path.join(tmpDir, 'config'), { recursive: true, force: true });
  vi.clearAllMocks();
  tokenEndpoint.mockReset();
  tokenEndpoint.mockImplementation(async () =>
    json(200, tokenBody('account-a')),
  );
  revokeEndpoint.mockReset();
  revokeEndpoint.mockImplementation(async () => json(200, {}));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === CODEX_OAUTH_REVOKE_URL) return revokeEndpoint(url, init);
      if (url !== CODEX_OAUTH_TOKEN_URL) throw new Error(`blocked ${url}`);
      return tokenEndpoint(url, init);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('POST /api/config/codex/oauth/callback', () => {
  test('creates a provider with the catalog default model and effort', async () => {
    const state = await startFlow();
    const response = await callback(state, callbackUrl(state, '127.0.0.1'));
    expect(response.status).toBe(200);
    const provider = await response.json();
    expect(provider).toMatchObject({
      anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
      anthropicModel: 'gpt-6.1-sol',
      customEnv: { CODEX_REASONING_EFFORT: 'low' },
      hasCodexOAuthCredentials: true,
      codexOAuthNeedsReauth: false,
      codexOAuthLastRefreshError: null,
      codexDefaultEffort: 'low',
    });
  });

  test('an error= callback is explained and the flow stays usable', async () => {
    const state = await startFlow();
    const denied = await callback(
      state,
      `http://localhost:1455/auth/callback?error=access_denied&state=${state}`,
    );
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({
      error: expect.stringContaining('access_denied'),
      retryable: true,
    });
    expect(tokenEndpoint).not.toHaveBeenCalled();
    expect((await callback(state, callbackUrl(state))).status).toBe(200);
  });

  test('a connection that never opened keeps the flow so the same code can be retried', async () => {
    tokenEndpoint
      .mockRejectedValueOnce(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
        }),
      )
      .mockResolvedValueOnce(json(200, tokenBody('account-a')));
    const state = await startFlow();
    const failed = await callback(state, callbackUrl(state));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ retryable: true });
    expect((await callback(state, callbackUrl(state))).status).toBe(200);
    expect(tokenEndpoint).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['an upstream 5xx', () => json(503, { error: 'temporarily_unavailable' })],
    [
      'a dropped connection',
      () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
        });
      },
    ],
  ])(
    'after %s the code may be consumed, so it is never sent again',
    async (_label, answer) => {
      tokenEndpoint.mockImplementationOnce(async () => answer());
      const state = await startFlow();
      const failed = await callback(state, callbackUrl(state));
      expect(failed.status).toBe(502);
      const body = await failed.json();
      expect(body.retryable).toBe(false);
      expect(body.error).toContain('请重新登录 ChatGPT');
      const again = await callback(state, callbackUrl(state));
      expect(again.status).toBe(400);
      expect(tokenEndpoint).toHaveBeenCalledTimes(1);
    },
  );

  test('a rejected code consumes the flow', async () => {
    tokenEndpoint.mockResolvedValueOnce(json(400, { error: 'invalid_grant' }));
    const state = await startFlow();
    const failed = await callback(state, callbackUrl(state));
    expect(failed.status).toBe(400);
    expect(await failed.json()).toMatchObject({ retryable: false });
    const again = await callback(state, callbackUrl(state));
    expect(again.status).toBe(400);
    expect((await again.json()).error).toContain('Invalid or expired');
  });

  test('a mismatched or foreign callback URL keeps the flow', async () => {
    const state = await startFlow();
    expect((await callback(state, callbackUrl('other-state'))).status).toBe(
      400,
    );
    expect(
      (
        await callback(
          state,
          `https://evil.example/auth/callback?code=x&state=${state}`,
        )
      ).status,
    ).toBe(400);
    expect((await callback(state, callbackUrl(state))).status).toBe(200);
  });

  test('re-login with the same account keeps sessions and the identifier, drains runners and clears health', async () => {
    const state = await startFlow();
    const created = await (await callback(state, callbackUrl(state))).json();
    const before = runtimeConfig.getProviderById(created.id)!;
    db.setSessionProviderId('same-account-ws', null, created.id);
    providerPool.reportFailure(created.id, true);
    runtimeConfig.setProviderCodexOAuthRefreshErrorIfCurrent(
      created.id,
      before.codexOAuthCredentials!,
      {
        kind: 'reauth_required',
        message: 'refresh_token 被拒绝（invalid_grant）',
        at: new Date().toISOString(),
      },
    );

    const relogin = await startFlow(created.id);
    const response = await callback(relogin, callbackUrl(relogin));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: created.id,
      codexOAuthNeedsReauth: false,
    });
    const after = runtimeConfig.getProviderById(created.id)!;
    expect(after.anthropicAuthToken).toBe(before.anthropicAuthToken);
    expect(db.getSessionProviderId('same-account-ws')).toBe(created.id);
    expect(queue.drainProviderRunnersForCredentialRefresh).toHaveBeenCalledWith(
      created.id,
    );
    expect(providerPool.getHealthStatus(created.id).healthy).toBe(true);
  });

  test('re-login with a different account invalidates the provider sessions', async () => {
    const state = await startFlow();
    const created = await (await callback(state, callbackUrl(state))).json();
    db.setSessionProviderId('switch-account-ws', null, created.id);

    tokenEndpoint.mockResolvedValueOnce(json(200, tokenBody('account-b')));
    const relogin = await startFlow(created.id);
    const response = await callback(relogin, callbackUrl(relogin));
    expect(response.status).toBe(200);
    expect(
      runtimeConfig.getProviderById(created.id)!.codexOAuthCredentials,
    ).toMatchObject({ accountId: 'account-b' });
    expect(db.getSessionProviderId('switch-account-ws')).toBeUndefined();
    expect(queue.drainProviderRunnersForCredentialRefresh).toHaveBeenCalledWith(
      created.id,
    );
  });

  test('re-login with a different account revokes the replaced refresh token in the background', async () => {
    const state = await startFlow();
    const created = await (await callback(state, callbackUrl(state))).json();
    expect(revokeEndpoint).not.toHaveBeenCalled();

    // Same account: the new login keeps serving, nothing is revoked.
    const same = await startFlow(created.id);
    expect((await callback(same, callbackUrl(same))).status).toBe(200);
    expect(revokeEndpoint).not.toHaveBeenCalled();

    // A revoke that fails must not fail the login.
    revokeEndpoint.mockImplementationOnce(async () => {
      throw new TypeError('fetch failed');
    });
    tokenEndpoint.mockResolvedValueOnce(json(200, tokenBody('account-b')));
    const relogin = await startFlow(created.id);
    expect((await callback(relogin, callbackUrl(relogin))).status).toBe(200);
    await vi.waitFor(() => expect(revokeEndpoint).toHaveBeenCalledTimes(1));
    const init = revokeEndpoint.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toMatchObject({
      token: 'refresh-account-a',
      token_type_hint: 'refresh_token',
    });
    expect(
      runtimeConfig.getProviderById(created.id)!.codexOAuthCredentials,
    ).toMatchObject({ refreshToken: 'refresh-account-b' });
  });

  test('deleting a ChatGPT provider revokes its grant without waiting for it', async () => {
    const state = await startFlow();
    const created = await (await callback(state, callbackUrl(state))).json();
    let releaseRevoke!: () => void;
    revokeEndpoint.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseRevoke = () => resolve(json(503, {}));
        }),
    );
    const response = await app.request(
      `/api/config/claude/providers/${created.id}`,
      { method: 'DELETE' },
    );
    expect(response.status).toBe(200);
    expect(runtimeConfig.getProviderById(created.id)).toBeNull();
    await vi.waitFor(() => expect(revokeEndpoint).toHaveBeenCalledTimes(1));
    expect(
      JSON.parse(
        (revokeEndpoint.mock.calls[0][1] as RequestInit).body as string,
      ),
    ).toMatchObject({ token: 'refresh-account-a' });
    releaseRevoke();
  });

  test('legacy reauth verdicts for non-grant 4xx answers read back as transient', async () => {
    const state = await startFlow();
    const created = await (await callback(state, callbackUrl(state))).json();
    const stored = runtimeConfig.getProviderById(created.id)!;
    const record = (message: string) =>
      runtimeConfig.setProviderCodexOAuthRefreshErrorIfCurrent(
        created.id,
        stored.codexOAuthCredentials!,
        { kind: 'reauth_required', message, at: new Date().toISOString() },
      );
    record('refresh_token 被拒绝（HTTP 403）');
    expect(
      runtimeConfig.getProviderById(created.id)!.codexOAuthLastRefreshError,
    ).toMatchObject({
      kind: 'transient',
      message: '令牌刷新暂时失败（HTTP 403）',
    });
    record('refresh_token 被拒绝（invalid_grant）');
    expect(
      runtimeConfig.getProviderById(created.id)!.codexOAuthLastRefreshError,
    ).toMatchObject({ kind: 'reauth_required' });
  });

  test('stores the FedRAMP claim with the credentials', async () => {
    tokenEndpoint.mockResolvedValueOnce(
      json(200, {
        ...tokenBody('gov'),
        id_token: jwt({
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'gov',
            chatgpt_account_is_fedramp: true,
          },
        }),
      }),
    );
    const state = await startFlow();
    const created = await (await callback(state, callbackUrl(state))).json();
    expect(
      runtimeConfig.getProviderById(created.id)!.codexOAuthCredentials,
    ).toMatchObject({ accountId: 'gov', isFedramp: true });
  });

  test('converting a third-party provider resets its model, writes the effort and replaces its secret', async () => {
    const thirdParty = runtimeConfig.createProvider({
      name: 'Converted',
      type: 'third_party',
      anthropicBaseUrl: 'https://api.example.test',
      anthropicAuthToken: 'real-third-party-secret',
      anthropicModel: 'claude-sonnet-4-6',
      enabled: false,
    });
    db.setSessionProviderId('converted-ws', null, thirdParty.id);
    const state = await startFlow(thirdParty.id);
    const response = await callback(state, callbackUrl(state));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
      anthropicModel: 'gpt-6.1-sol',
      customEnv: { CODEX_REASONING_EFFORT: 'low' },
      codexDefaultEffort: 'low',
    });
    const stored = runtimeConfig.getProviderById(thirdParty.id)!;
    expect(stored.anthropicAuthToken).not.toBe('real-third-party-secret');
    expect(stored.anthropicAuthToken).toMatch(/^[0-9a-f]{64}$/);
    expect(db.getSessionProviderId('converted-ws')).toBeUndefined();
  });

  test('an unknown target provider is a 404', async () => {
    const state = await startFlow('missing-provider');
    expect((await callback(state, callbackUrl(state))).status).toBe(404);
  });
});
