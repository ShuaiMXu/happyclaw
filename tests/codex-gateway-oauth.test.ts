import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildCodexAuthorizeUrl,
  buildCodexCredentials,
  CodexOAuthTokenError,
  exchangeCodexCode,
  parseCodexIdToken,
  refreshCodexToken,
  retiredCodexReauthReason,
  revokeCodexToken,
  revokeCodexTokenInBackground,
} from '../src/codex-gateway/oauth.js';
import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_REVOKE_URL,
  CODEX_OAUTH_TOKEN_URL,
} from '../src/codex-gateway/types.js';
import { codexUserAgent } from '../src/codex-gateway/client-identity.js';

function jwt(payload: unknown): string {
  return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.test`;
}

describe('Codex OAuth identity', () => {
  test('reads official namespaced ID token claims and forwards the account identity', () => {
    const idToken = jwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'workspace-business',
        chatgpt_plan_type: 'business',
      },
      'https://api.openai.com/profile': { email: 'fake@example.invalid' },
      auth: { chatgpt_account_id: 'legacy-wrong', chatgpt_plan_type: 'free' },
    });
    const identity = {
      accountId: 'workspace-business',
      planType: 'business',
      email: 'fake@example.invalid',
      isFedramp: false,
    };
    expect(parseCodexIdToken(idToken)).toEqual(identity);
    expect(
      buildCodexCredentials({
        accessToken: 'synthetic-access',
        refreshToken: 'synthetic-refresh',
        expiresAt: 1234,
        idToken,
      }),
    ).toMatchObject(identity);
  });

  test('keeps legacy claims and top-level email compatibility', () => {
    expect(
      parseCodexIdToken(
        jwt({
          auth: { chatgpt_account_id: 'personal', chatgpt_plan_type: 'plus' },
          profile: { email: 'old@example.invalid' },
          email: 'top@example.invalid',
        }),
      ),
    ).toEqual({
      accountId: 'personal',
      planType: 'plus',
      email: 'top@example.invalid',
      isFedramp: false,
    });
  });

  test('reads the FedRAMP claim and keeps it across refreshes without an ID token', () => {
    const idToken = jwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'gov-workspace',
        chatgpt_account_is_fedramp: true,
      },
    });
    expect(parseCodexIdToken(idToken).isFedramp).toBe(true);
    const login = buildCodexCredentials({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 1,
      idToken,
    });
    expect(login.isFedramp).toBe(true);
    expect(
      buildCodexCredentials(
        { accessToken: 'b', refreshToken: null, expiresAt: 2, idToken: null },
        login,
      ).isFedramp,
    ).toBe(true);
    // A new ID token is authoritative, as in the official TokenData.
    expect(
      buildCodexCredentials(
        {
          accessToken: 'c',
          refreshToken: null,
          expiresAt: 3,
          idToken: jwt({
            'https://api.openai.com/auth': { chatgpt_account_id: 'gov' },
          }),
        },
        login,
      ).isFedramp,
    ).toBe(false);
    // The claim must be a real boolean true.
    expect(
      parseCodexIdToken(
        jwt({
          'https://api.openai.com/auth': { chatgpt_account_is_fedramp: 'true' },
        }),
      ).isFedramp,
    ).toBe(false);
  });

  test('the authorize URL carries the same originator as backend requests', () => {
    const url = new URL(buildCodexAuthorizeUrl('state-1', 'challenge-1'));
    expect(url.searchParams.get('originator')).toBe('codex-tui');
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
  });

  test.each([null, 'garbage', jwt(null), jwt([]), jwt(42)])(
    'rejects malformed claim payload %s without throwing',
    (token) => {
      expect(parseCodexIdToken(token)).toEqual({
        accountId: null,
        planType: null,
        email: null,
        isFedramp: false,
      });
    },
  );

  test('refresh responses without ID token preserve the existing identity', () => {
    const previous = {
      accessToken: 'old',
      refreshToken: 'refresh',
      expiresAt: 1,
      accountId: 'workspace',
      planType: 'pro',
      email: 'fake@example.invalid',
      updatedAt: 'old',
    };
    expect(
      buildCodexCredentials(
        {
          accessToken: 'new',
          refreshToken: null,
          expiresAt: 9999,
          idToken: null,
        },
        previous,
      ),
    ).toMatchObject({
      accessToken: 'new',
      refreshToken: 'refresh',
      accountId: 'workspace',
      planType: 'pro',
      email: 'fake@example.invalid',
    });
  });
});

describe('Codex OAuth token endpoint', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  function stubTokenEndpoint(response: Response | Error) {
    const fetch = vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  test('derives expiry from the access token JWT exp when expires_in is absent', async () => {
    const exp = Math.floor(Date.now() / 1000) + 864_000;
    stubTokenEndpoint(
      json(200, { access_token: jwt({ exp }), refresh_token: 'next' }),
    );
    const token = await refreshCodexToken('refresh');
    expect(token.expiresAt).toBe(exp * 1000);
  });

  test('falls back to one hour without expires_in or a JWT exp', async () => {
    stubTokenEndpoint(json(200, { access_token: 'opaque-token' }));
    const before = Date.now();
    const token = await refreshCodexToken('refresh');
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(token.expiresAt).toBeLessThan(before + 3_700_000);
  });

  test('prefers expires_in over the JWT exp', async () => {
    stubTokenEndpoint(
      json(200, { access_token: jwt({ exp: 1 }), expires_in: 120 }),
    );
    const token = await refreshCodexToken('refresh');
    expect(token.expiresAt).toBeGreaterThan(Date.now() + 100_000);
  });

  // login/src/auth/manager.rs request_chatgpt_token_refresh: only 401,
  // 400 + invalid_grant and the three refresh_token_* codes end the grant.
  test.each([
    [json(400, { error: 'invalid_grant' }), false, 'invalid_grant', 400],
    [json(400, { error: 'INVALID_GRANT' }), false, 'INVALID_GRANT', 400],
    [json(401, {}), false, null, 401],
    [
      json(401, { error: { code: 'refresh_token_reused', message: 'x' } }),
      false,
      'refresh_token_reused',
      401,
    ],
    [
      json(403, { error: { code: 'refresh_token_expired' } }),
      false,
      'refresh_token_expired',
      403,
    ],
    [
      json(400, { code: 'refresh_token_invalidated' }),
      false,
      'refresh_token_invalidated',
      400,
    ],
    // Any other 4xx is transient: a Cloudflare challenge, a plain 400.
    [json(403, { error: 'forbidden' }), true, 'forbidden', 403],
    [new Response('<html>challenge</html>', { status: 403 }), true, null, 403],
    [json(400, { error: 'invalid_request' }), true, 'invalid_request', 400],
    [json(403, { error: 'invalid_grant' }), true, 'invalid_grant', 403],
    [json(404, {}), true, null, 404],
    [
      json(503, { error: 'temporarily_unavailable' }),
      true,
      'temporarily_unavailable',
      503,
    ],
    [json(429, {}), true, null, 429],
    [json(200, {}), true, null, null],
    [new TypeError('fetch failed'), true, null, null],
  ])(
    'classifies token endpoint failure %# (transient=%s)',
    async (response, transient, code, status) => {
      stubTokenEndpoint(response);
      const error = await refreshCodexToken('refresh').catch((err) => err);
      expect(error).toBeInstanceOf(CodexOAuthTokenError);
      expect(error).toMatchObject({ transient, code, status });
    },
  );

  test('refresh sends the official auth-client identity and a sorted JSON body', async () => {
    const fetch = stubTokenEndpoint(
      json(200, { access_token: 'next', expires_in: 60 }),
    );
    await refreshCodexToken('refresh-secret');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CODEX_OAUTH_TOKEN_URL);
    expect(init.headers).toEqual({
      originator: 'codex-tui',
      'User-Agent': codexUserAgent(),
      'Content-Type': 'application/json',
    });
    // The auth client has no model-provider `version` header.
    expect(init.body).toBe(
      JSON.stringify({
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: 'refresh-secret',
      }),
    );
  });

  test.each([
    ['ENOTFOUND', false],
    ['ECONNREFUSED', false],
    ['UND_ERR_CONNECT_TIMEOUT', false],
    ['CERT_HAS_EXPIRED', false],
    ['ECONNRESET', true],
    ['UND_ERR_SOCKET', true],
  ])(
    'transport failure %s marks requestDelivered=%s',
    async (code, delivered) => {
      stubTokenEndpoint(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('transport'), { code }),
        }),
      );
      const error = await exchangeCodexCode('code', 'verifier').catch(
        (err) => err,
      );
      expect(error).toMatchObject({
        transient: true,
        requestDelivered: delivered,
      });
    },
  );

  test('a connect failure on every address is still undelivered', async () => {
    const refused = () =>
      Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    stubTokenEndpoint(
      new TypeError('fetch failed', {
        cause: new AggregateError([refused(), refused()]),
      }),
    );
    const error = await exchangeCodexCode('code', 'verifier').catch(
      (err) => err,
    );
    expect(error.requestDelivered).toBe(false);
  });

  test('a response timeout may have consumed the code', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) =>
              init.signal!.addEventListener('abort', () =>
                reject(new DOMException('aborted', 'AbortError')),
              ),
            ),
        ),
      );
      const pending = exchangeCodexCode('code', 'verifier').catch((err) => err);
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await pending;
      expect(error).toMatchObject({ transient: true, requestDelivered: true });
      expect(error.message).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  test('every HTTP answer reached the server', async () => {
    stubTokenEndpoint(json(503, {}));
    const error = await exchangeCodexCode('code', 'verifier').catch(
      (err) => err,
    );
    expect(error.requestDelivered).toBe(true);
  });

  test('upstream error text never becomes part of the error message', async () => {
    stubTokenEndpoint(
      json(400, { error: 'invalid_grant', error_description: 'SECRET detail' }),
    );
    const error = await exchangeCodexCode('code', 'verifier').catch(
      (err) => err,
    );
    expect(String(error.message)).not.toContain('SECRET');
    expect(error.transient).toBe(false);
  });
});

describe('Codex OAuth revocation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('revokes the refresh token with the official body and auth-client headers', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await revokeCodexToken({ accessToken: 'access', refreshToken: 'refresh' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CODEX_OAUTH_REVOKE_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      originator: 'codex-tui',
      'User-Agent': codexUserAgent(),
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      token: 'refresh',
      token_type_hint: 'refresh_token',
      client_id: CODEX_OAUTH_CLIENT_ID,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test('falls back to the access token without a client id', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await revokeCodexToken({ accessToken: 'access', refreshToken: '' });
    expect(
      JSON.parse(
        (fetch.mock.calls[0] as unknown as [string, RequestInit])[1]
          .body as string,
      ),
    ).toEqual({ token: 'access', token_type_hint: 'access_token' });
    await revokeCodexToken({ accessToken: '', refreshToken: '' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('a rejected revocation throws without echoing the body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('SECRET body', { status: 400 })),
    );
    const error = await revokeCodexToken({
      accessToken: 'a',
      refreshToken: 'r',
    }).catch((err) => err);
    expect(error).toBeInstanceOf(CodexOAuthTokenError);
    expect(error.status).toBe(400);
    expect(error.message).not.toContain('SECRET');
  });

  test('background revocation never rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(() =>
      revokeCodexTokenInBackground(
        { accessToken: 'a', refreshToken: 'r' },
        { providerId: 'p', reason: 'test' },
      ),
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('legacy refresh verdicts', () => {
  test.each([
    ['refresh_token 被拒绝（HTTP 403）', '令牌刷新暂时失败（HTTP 403）'],
    ['refresh_token 被拒绝（HTTP 400）', '令牌刷新暂时失败（HTTP 400）'],
    ['refresh_token 被拒绝（forbidden）', '令牌刷新暂时失败（forbidden）'],
    ['refresh_token 被拒绝（HTTP 401）', null],
    ['refresh_token 被拒绝（invalid_grant）', null],
    ['refresh_token 被拒绝（refresh_token_reused）', null],
    ['refresh_token 被拒绝（refresh_token_expired）', null],
    ['refresh_token 被拒绝（refresh_token_invalidated）', null],
    ['凭据缺少 refresh_token', null],
  ])('%s → %s', (message, retired) => {
    expect(retiredCodexReauthReason(message)).toBe(retired);
  });
});
