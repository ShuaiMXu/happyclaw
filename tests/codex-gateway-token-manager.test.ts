import { beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  CodexOAuthCredentials,
  CodexOAuthRefreshErrorState,
} from '../src/codex-gateway/types.js';

const mocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  persist: vi.fn(),
  persistError: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('../src/runtime-config.js', () => ({
  getProviders: mocks.getProviders,
  updateProviderCodexOAuthCredentialsIfCurrent: mocks.persist,
  setProviderCodexOAuthRefreshErrorIfCurrent: mocks.persistError,
}));
vi.mock('../src/codex-gateway/oauth.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  refreshCodexToken: mocks.refresh,
}));
vi.mock('../src/logger.js', () => ({ logger: { warn: vi.fn() } }));

import { CodexOAuthTokenError } from '../src/codex-gateway/oauth.js';
import {
  CodexGatewayAuthError,
  CodexReauthRequiredError,
  CodexRefreshUnavailableError,
  findCodexProviderByGatewayIdentifier,
  resetCodexTokenManagerForTests,
  resolveCodexAccess,
} from '../src/codex-gateway/token-manager.js';

function credentials(
  token = 'upstream-token',
  expired = false,
): CodexOAuthCredentials {
  return {
    accessToken: token,
    refreshToken: `refresh-${token}`,
    expiresAt: Date.now() + (expired ? -1 : 3_600_000),
    accountId: 'account-id',
    planType: 'plus',
    email: 'fake@example.invalid',
    updatedAt: 'now',
  };
}
function tokenResponse(token: string) {
  return {
    accessToken: token,
    refreshToken: `refresh-${token}`,
    expiresAt: Date.now() + 3_600_000,
    idToken: null,
  };
}
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const rejected = (code = 'invalid_grant', status = 400) =>
  new CodexOAuthTokenError(
    `Codex OAuth token endpoint rejected: ${code}`,
    status,
    code,
    false,
  );
const unreachable = () =>
  new CodexOAuthTokenError(
    'Codex OAuth token endpoint unreachable',
    null,
    null,
    true,
  );

let provider: {
  id: string;
  enabled: boolean;
  anthropicAuthToken: string;
  codexOAuthCredentials: CodexOAuthCredentials | null;
  codexOAuthLastRefreshError?: CodexOAuthRefreshErrorState | null;
};
beforeEach(() => {
  vi.clearAllMocks();
  resetCodexTokenManagerForTests();
  provider = {
    id: 'provider',
    enabled: true,
    anthropicAuthToken: 'gateway-identifier',
    codexOAuthCredentials: credentials(),
    codexOAuthLastRefreshError: null,
  };
  // Production getProviders deserializes a fresh credential snapshot per call.
  mocks.getProviders.mockImplementation(() => [structuredClone(provider)]);
  mocks.persist.mockImplementation((_id, expected, refreshed) => {
    if (provider.codexOAuthCredentials?.accessToken !== expected.accessToken)
      return false;
    provider.codexOAuthCredentials = refreshed;
    provider.codexOAuthLastRefreshError = null;
    return true;
  });
  mocks.persistError.mockImplementation((_id, expected, state) => {
    if (provider.codexOAuthCredentials?.accessToken !== expected.accessToken)
      return false;
    provider.codexOAuthLastRefreshError = state;
    return true;
  });
});

describe('resolveCodexAccess', () => {
  test('serves a disabled provider: grants exist only for launches that selected it', async () => {
    provider.enabled = false;
    await expect(resolveCodexAccess('provider')).resolves.toMatchObject({
      accessToken: 'upstream-token',
    });
  });
  test('returns current credentials without a refresh', async () => {
    await expect(resolveCodexAccess('provider')).resolves.toEqual({
      providerId: 'provider',
      accessToken: 'upstream-token',
      accountId: 'account-id',
      isFedramp: false,
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  test('carries the stored FedRAMP status to the request layer', async () => {
    provider.codexOAuthCredentials = { ...credentials(), isFedramp: true };
    await expect(resolveCodexAccess('provider')).resolves.toMatchObject({
      isFedramp: true,
    });
  });
  test('the stored identifier finds its provider but is not an access path', async () => {
    expect(findCodexProviderByGatewayIdentifier('gateway-identifier')?.id).toBe(
      'provider',
    );
    expect(findCodexProviderByGatewayIdentifier('other')).toBeNull();
    expect(findCodexProviderByGatewayIdentifier('')).toBeNull();
    await expect(resolveCodexAccess('gateway-identifier')).rejects.toThrow(
      CodexGatewayAuthError,
    );
  });
  test('concurrent snapshots share one rotating-token refresh', async () => {
    provider.codexOAuthCredentials = credentials('old', true);
    const exchange = gate<ReturnType<typeof tokenResponse>>();
    mocks.refresh.mockReturnValue(exchange.promise);
    const requests = Array.from({ length: 8 }, () =>
      resolveCodexAccess('provider'),
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    exchange.resolve(tokenResponse('new'));
    for (const value of await Promise.all(requests))
      expect(value.accessToken).toBe('new');
    expect(mocks.persist).toHaveBeenCalledTimes(1);
  });
  test('CAS losers re-read valid admin credentials instead of returning an expired waiter snapshot', async () => {
    provider.codexOAuthCredentials = credentials('old', true);
    const exchange = gate<ReturnType<typeof tokenResponse>>();
    mocks.refresh.mockReturnValue(exchange.promise);
    const requests = [
      resolveCodexAccess('provider'),
      resolveCodexAccess('provider'),
    ];
    provider.codexOAuthCredentials = credentials('admin-new');
    provider.codexOAuthCredentials.accountId = 'admin-workspace';
    exchange.resolve(tokenResponse('discarded'));
    for (const value of await Promise.all(requests))
      expect(value).toMatchObject({
        accessToken: 'admin-new',
        accountId: 'admin-workspace',
      });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
  test('CAS losers share a second refresh when the replacement credentials also expired', async () => {
    provider.codexOAuthCredentials = credentials('old', true);
    const exchange = gate<ReturnType<typeof tokenResponse>>();
    mocks.refresh
      .mockReturnValueOnce(exchange.promise)
      .mockResolvedValueOnce(tokenResponse('latest'));
    const requests = [
      resolveCodexAccess('provider'),
      resolveCodexAccess('provider'),
    ];
    provider.codexOAuthCredentials = credentials('admin-expired', true);
    exchange.resolve(tokenResponse('discarded'));
    for (const value of await Promise.all(requests))
      expect(value.accessToken).toBe('latest');
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenNthCalledWith(2, 'refresh-admin-expired');
  });
  test.each(['delete', 'clear'])(
    'revalidates the provider after admin %s during refresh',
    async (action) => {
      provider.codexOAuthCredentials = credentials('old', true);
      const exchange = gate<ReturnType<typeof tokenResponse>>();
      mocks.refresh.mockReturnValue(exchange.promise);
      const request = resolveCodexAccess('provider');
      if (action === 'delete') mocks.getProviders.mockImplementation(() => []);
      if (action === 'clear') provider.codexOAuthCredentials = null;
      exchange.resolve(tokenResponse('new'));
      await expect(request).rejects.toThrow(CodexGatewayAuthError);
    },
  );
  test('a failed old refresh can use credentials concurrently replaced by admin', async () => {
    provider.codexOAuthCredentials = credentials('old', true);
    const exchange = gate<ReturnType<typeof tokenResponse>>();
    mocks.refresh.mockReturnValue(exchange.promise);
    const request = resolveCodexAccess('provider');
    provider.codexOAuthCredentials = credentials('admin-valid');
    exchange.reject(rejected());
    await expect(request).resolves.toMatchObject({
      accessToken: 'admin-valid',
    });
  });
  test('persistent CAS conflicts are bounded and never return expired credentials', async () => {
    provider.codexOAuthCredentials = credentials('old', true);
    mocks.persist.mockReturnValue(false);
    mocks.refresh.mockResolvedValue(tokenResponse('discarded'));
    await expect(resolveCodexAccess('provider')).rejects.toThrow(
      'changed concurrently',
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(3);
  });
});

describe('forced refresh after an upstream 401', () => {
  test('refreshes an unexpired token once and shares it across concurrent 401s', async () => {
    const exchange = gate<ReturnType<typeof tokenResponse>>();
    mocks.refresh.mockReturnValue(exchange.promise);
    const requests = Array.from({ length: 3 }, () =>
      resolveCodexAccess('provider', { rejectedAccessToken: 'upstream-token' }),
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    exchange.resolve(tokenResponse('rotated'));
    for (const value of await Promise.all(requests))
      expect(value.accessToken).toBe('rotated');
  });
  test('a token already replaced by another request is used without refreshing', async () => {
    await expect(
      resolveCodexAccess('provider', { rejectedAccessToken: 'older-token' }),
    ).resolves.toMatchObject({ accessToken: 'upstream-token' });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});

describe('refresh failures', () => {
  test('a rejected refresh grant persists reauth_required and stops refreshing', async () => {
    provider.codexOAuthCredentials = credentials('old', true);
    mocks.refresh.mockRejectedValue(rejected('refresh_token_reused', 401));
    await expect(resolveCodexAccess('provider')).rejects.toThrow(
      CodexReauthRequiredError,
    );
    expect(provider.codexOAuthLastRefreshError).toMatchObject({
      kind: 'reauth_required',
      accessTokenRejected: true,
    });
    expect(provider.codexOAuthLastRefreshError?.message).toContain(
      'refresh_token_reused',
    );
    const second = resolveCodexAccess('provider');
    await expect(second).rejects.toThrow('重新登录 ChatGPT');
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
  test('an unexpired token keeps serving after its refresh grant is rejected, until upstream rejects it', async () => {
    provider.codexOAuthCredentials = credentials('near-expiry');
    provider.codexOAuthCredentials.expiresAt = Date.now() + 60_000;
    mocks.refresh.mockRejectedValue(rejected());
    await expect(resolveCodexAccess('provider')).resolves.toMatchObject({
      accessToken: 'near-expiry',
    });
    expect(provider.codexOAuthLastRefreshError?.kind).toBe('reauth_required');
    await expect(resolveCodexAccess('provider')).resolves.toMatchObject({
      accessToken: 'near-expiry',
    });
    await expect(
      resolveCodexAccess('provider', { rejectedAccessToken: 'near-expiry' }),
    ).rejects.toThrow(CodexReauthRequiredError);
    expect(provider.codexOAuthLastRefreshError?.accessTokenRejected).toBe(true);
    await expect(resolveCodexAccess('provider')).rejects.toThrow(
      CodexReauthRequiredError,
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
  test('new credentials clear the re-login requirement', async () => {
    provider.codexOAuthCredentials = credentials('old', true);
    mocks.refresh.mockRejectedValue(rejected());
    await expect(resolveCodexAccess('provider')).rejects.toThrow(
      CodexReauthRequiredError,
    );
    // runtime-config clears the state whenever credentials are written.
    provider.codexOAuthCredentials = credentials('relogin');
    provider.codexOAuthLastRefreshError = null;
    await expect(resolveCodexAccess('provider')).resolves.toMatchObject({
      accessToken: 'relogin',
    });
  });
  test('missing refresh tokens require a new login', async () => {
    provider.codexOAuthCredentials = {
      ...credentials('old', true),
      refreshToken: '',
    };
    await expect(resolveCodexAccess('provider')).rejects.toThrow(
      CodexReauthRequiredError,
    );
    expect(provider.codexOAuthLastRefreshError?.kind).toBe('reauth_required');
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  test('transient failures back off, keep valid tokens serving and retry later', async () => {
    vi.useFakeTimers({ now: Date.now() });
    try {
      provider.codexOAuthCredentials = credentials('old', true);
      mocks.refresh
        .mockRejectedValueOnce(unreachable())
        .mockResolvedValueOnce(tokenResponse('recovered'));
      const first = resolveCodexAccess('provider');
      await expect(first).rejects.toThrow(CodexRefreshUnavailableError);
      await first.catch((err: CodexRefreshUnavailableError) => {
        expect(err.retryAfterMs).toBeGreaterThan(20_000);
        expect(err.retryAfterMs).toBeLessThanOrEqual(30_000);
      });
      expect(provider.codexOAuthLastRefreshError).toMatchObject({
        kind: 'transient',
      });
      // Inside the backoff window the endpoint is not called again.
      await expect(resolveCodexAccess('provider')).rejects.toThrow(
        CodexRefreshUnavailableError,
      );
      expect(mocks.refresh).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(31_000);
      await expect(resolveCodexAccess('provider')).resolves.toMatchObject({
        accessToken: 'recovered',
      });
      expect(provider.codexOAuthLastRefreshError).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  test('a non-grant 4xx such as a Cloudflare 403 backs off instead of requiring re-login', async () => {
    provider.codexOAuthCredentials = credentials('old', true);
    mocks.refresh.mockRejectedValue(
      new CodexOAuthTokenError(
        'Codex OAuth token endpoint rejected: HTTP 403',
        403,
        null,
        true,
      ),
    );
    await expect(resolveCodexAccess('provider')).rejects.toThrow(
      CodexRefreshUnavailableError,
    );
    expect(provider.codexOAuthLastRefreshError).toMatchObject({
      kind: 'transient',
      message: '令牌刷新暂时失败（HTTP 403）',
    });
  });
  test('transient failures escalate the backoff only once per failed exchange', async () => {
    provider.codexOAuthCredentials = credentials('near-expiry');
    provider.codexOAuthCredentials.expiresAt = Date.now() + 60_000;
    const exchange = gate<ReturnType<typeof tokenResponse>>();
    mocks.refresh.mockReturnValue(exchange.promise);
    const requests = Array.from({ length: 4 }, () =>
      resolveCodexAccess('provider'),
    );
    exchange.reject(unreachable());
    // Still unexpired: every waiter keeps the current token.
    for (const value of await Promise.all(requests))
      expect(value.accessToken).toBe('near-expiry');
    expect(mocks.persistError).toHaveBeenCalledTimes(1);
  });
});
