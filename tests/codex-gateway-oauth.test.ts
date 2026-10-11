import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildCodexCredentials,
  CodexOAuthTokenError,
  exchangeCodexCode,
  parseCodexIdToken,
  refreshCodexToken,
} from '../src/codex-gateway/oauth.js';

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
    });
  });

  test.each([null, 'garbage', jwt(null), jwt([]), jwt(42)])(
    'rejects malformed claim payload %s without throwing',
    (token) => {
      expect(parseCodexIdToken(token)).toEqual({
        accountId: null,
        planType: null,
        email: null,
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

  test.each([
    [json(400, { error: 'invalid_grant' }), false, 'invalid_grant', 400],
    [
      json(401, { error: { code: 'refresh_token_reused', message: 'x' } }),
      false,
      'refresh_token_reused',
      401,
    ],
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
