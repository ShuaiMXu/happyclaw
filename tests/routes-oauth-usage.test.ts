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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-oauth-usage-'));

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
        id: 'quota-route-admin',
        username: 'quota-route-admin',
        display_name: 'Quota Route Admin',
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
const quotaObservation = await import('../src/provider-quota-observation.js');

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

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });
  db.initDatabase();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  quotaObservation.clearAllProviderQuotaObservations();
  closeAllActiveForCredentialRefresh.mockClear();
  drainProviderRunnersForCredentialRefresh.mockClear();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Claude provider usage route', () => {
  test('returns full OAuth data and a separate latest SDK observation', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'OAuth fixture provider',
      type: 'official',
      enabled: true,
      claudeOAuthCredentials: {
        accessToken: 'fixture-access-token',
        refreshToken: 'fixture-refresh-token',
        expiresAt: Date.now() + 60_000,
        scopes: ['user:inference', 'user:profile'],
      },
    });
    quotaObservation.observeProviderQuota(provider.id, {
      source: 'sdk_rate_limit_event',
      observedAt: 1_788_300_000_000,
      status: 'allowed_warning',
      rateLimitType: 'seven_day',
      utilization: 0.53,
      resetsAt: 1_788_700_000,
    });
    globalThis.fetch = vi.fn(async (_url, init) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer fixture-access-token',
      );
      return new Response(
        JSON.stringify({
          five_hour: {
            utilization: 10.25,
            resets_at: '2026-09-02T10:00:00.000Z',
          },
          limits: [
            {
              kind: 'weekly_scoped',
              group: 'model',
              percent: 44.5,
              resets_at: '2026-09-08T10:00:00.000Z',
              scope: { model: { display_name: 'Future model' } },
            },
          ],
          extra_usage: {
            is_enabled: true,
            monthly_limit: 100,
            used_credits: 25,
            utilization: null,
            currency: 'USD',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const response = await app.request(
      `/api/config/claude/providers/${provider.id}/usage`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        five_hour: { utilization: 10.25 },
        model_scoped: [{ display_name: 'Future model', utilization: 44.5 }],
        extra_usage: {
          is_enabled: true,
          monthly_limit: 100,
          used_credits: 25,
          utilization: null,
          currency: 'USD',
        },
      },
      observation: {
        source: 'sdk_rate_limit_event',
        status: 'allowed_warning',
        rateLimitType: 'seven_day',
        utilization: 0.53,
        resetsAt: 1_788_700_000,
      },
    });
  });

  test('serves an observation-only response without OAuth credentials', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'Passive-only provider',
      type: 'official',
      enabled: true,
      anthropicApiKey: 'api-key-does-not-have-oauth-usage',
    });
    quotaObservation.observeProviderQuota(provider.id, {
      source: 'sdk_rate_limit_event',
      observedAt: Date.now(),
      status: 'allowed',
      rateLimitType: 'five_hour',
      utilization: 0.1,
    });

    const response = await app.request(
      `/api/config/claude/providers/${provider.id}/usage`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        five_hour: null,
        seven_day: null,
        model_scoped: [],
        extra_usage: null,
      },
      observation: {
        status: 'allowed',
        rateLimitType: 'five_hour',
        utilization: 0.1,
      },
    });
  });

  test('serves an empty successful response before an API-key provider has an observation', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'Passive provider without an event yet',
      type: 'official',
      enabled: true,
      anthropicApiKey: 'api-key-without-observation',
    });
    globalThis.fetch = vi.fn();

    const response = await app.request(
      `/api/config/claude/providers/${provider.id}/usage`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        five_hour: null,
        seven_day: null,
        model_scoped: [],
        extra_usage: null,
      },
      observation: null,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('clears passive state when the provider credential epoch changes', () => {
    const provider = runtimeConfig.createProvider({
      name: 'Credential rotation provider',
      type: 'official',
      enabled: true,
      claudeOAuthCredentials: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: Date.now() + 60_000,
        scopes: ['user:inference'],
      },
    });
    quotaObservation.observeProviderQuota(provider.id, {
      source: 'sdk_rate_limit_event',
      observedAt: Date.now(),
      status: 'rejected',
    });

    runtimeConfig.updateProviderSecrets(provider.id, {
      claudeOAuthCredentials: {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: Date.now() + 120_000,
        scopes: ['user:inference'],
      },
    });
    expect(
      quotaObservation.getProviderQuotaObservation(provider.id),
    ).toBeNull();
  });

  test('invalidates the three-minute OAuth body cache on credential rotation', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'Cached credential provider',
      type: 'official',
      enabled: false,
      claudeOAuthCredentials: {
        accessToken: 'cached-old-access',
        refreshToken: 'cached-old-refresh',
        expiresAt: Date.now() + 60_000,
        scopes: ['user:inference'],
      },
    });
    let requestCount = 0;
    globalThis.fetch = vi.fn(async () => {
      requestCount += 1;
      return new Response(
        JSON.stringify({
          five_hour: {
            utilization: requestCount === 1 ? 10 : 20,
            resets_at: '2026-09-02T10:00:00.000Z',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const usageUrl = `/api/config/claude/providers/${provider.id}/usage`;
    expect(
      (await (await app.request(usageUrl)).json()).data.five_hour,
    ).toMatchObject({ utilization: 10 });
    expect(
      (await (await app.request(usageUrl)).json()).data.five_hour,
    ).toMatchObject({ utilization: 10 });
    expect(requestCount).toBe(1);

    const rotate = await app.request(
      `/api/config/claude/providers/${provider.id}/secrets`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          claudeOAuthCredentials: {
            accessToken: 'cached-new-access',
            refreshToken: 'cached-new-refresh',
            expiresAt: Date.now() + 120_000,
            scopes: ['user:inference'],
          },
        }),
      },
    );
    expect(rotate.status).toBe(200);
    expect(
      (await (await app.request(usageUrl)).json()).data.five_hour,
    ).toMatchObject({ utilization: 20 });
    expect(requestCount).toBe(2);
  });

  test('keeps the last full snapshot when a 200 response has no usage signals', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T08:00:00.000Z'));
    const provider = runtimeConfig.createProvider({
      name: 'Fieldless response provider',
      type: 'official',
      enabled: false,
      claudeOAuthCredentials: {
        accessToken: 'fieldless-access',
        refreshToken: 'fieldless-refresh',
        expiresAt: Date.now() + 60 * 60_000,
        scopes: ['user:inference'],
      },
    });
    let requestCount = 0;
    globalThis.fetch = vi.fn(async () => {
      requestCount += 1;
      return Response.json(
        requestCount === 1
          ? {
              five_hour: {
                utilization: 31,
                resets_at: '2026-09-02T10:00:00.000Z',
              },
            }
          : { error: 'temporarily unavailable' },
      );
    });
    const usageUrl = `/api/config/claude/providers/${provider.id}/usage`;

    const first = await (await app.request(usageUrl)).json();
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 1);
    const second = await (await app.request(usageUrl)).json();

    expect(requestCount).toBe(2);
    expect(second.data.five_hour.utilization).toBe(31);
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(second.error).toContain('no recognized quota data');
  });

  test('falls back to a passive observation when the OAuth endpoint fails', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'OAuth failure with passive state',
      type: 'official',
      enabled: false,
      claudeOAuthCredentials: {
        accessToken: 'passive-fallback-access',
        refreshToken: 'passive-fallback-refresh',
        expiresAt: Date.now() + 60_000,
        scopes: ['user:inference'],
      },
    });
    quotaObservation.observeProviderQuota(provider.id, {
      source: 'sdk_rate_limit_event',
      observedAt: Date.now(),
      status: 'allowed_warning',
      utilization: 0.8,
    });
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 429 }));

    const response = await app.request(
      `/api/config/claude/providers/${provider.id}/usage`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { five_hour: null, model_scoped: [] },
      error: 'Usage API returned 429',
      observation: { status: 'allowed_warning', utilization: 0.8 },
    });
  });

  test('times out a hung usage request and releases its in-flight slot', async () => {
    vi.useFakeTimers();
    const provider = runtimeConfig.createProvider({
      name: 'Hung OAuth usage provider',
      type: 'official',
      enabled: false,
      claudeOAuthCredentials: {
        accessToken: 'hung-access',
        refreshToken: 'hung-refresh',
        expiresAt: Date.now() + 60_000,
        scopes: ['user:inference'],
      },
    });
    globalThis.fetch = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('usage request aborted')),
            { once: true },
          );
        }),
    );
    const usageUrl = `/api/config/claude/providers/${provider.id}/usage`;

    const hungRequest = app.request(usageUrl);
    await vi.advanceTimersByTimeAsync(0);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await hungRequest).status).toBe(400);

    globalThis.fetch = vi.fn(async () =>
      Response.json({
        five_hour: {
          utilization: 9,
          resets_at: '2026-09-02T10:00:00.000Z',
        },
      }),
    );
    const retried = await app.request(usageUrl);
    expect(retried.status).toBe(200);
    expect((await retried.json()).data.five_hour.utilization).toBe(9);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  test('keeps the timeout active while a response body is stalled', async () => {
    vi.useFakeTimers();
    const provider = runtimeConfig.createProvider({
      name: 'Stalled OAuth body provider',
      type: 'official',
      enabled: false,
      claudeOAuthCredentials: {
        accessToken: 'stalled-body-access',
        refreshToken: 'stalled-body-refresh',
        expiresAt: Date.now() + 60_000,
        scopes: ['user:inference'],
      },
    });
    globalThis.fetch = vi.fn(async (_url, init) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = () => controller.error(new Error('body aborted'));
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const usageUrl = `/api/config/claude/providers/${provider.id}/usage`;

    const stalledRequest = app.request(usageUrl);
    await vi.advanceTimersByTimeAsync(0);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await stalledRequest).status).toBe(400);

    globalThis.fetch = vi.fn(async () =>
      Response.json({
        five_hour: {
          utilization: 11,
          resets_at: '2026-09-02T10:00:00.000Z',
        },
      }),
    );
    const retried = await app.request(usageUrl);
    expect(retried.status).toBe(200);
    expect((await retried.json()).data.five_hour.utilization).toBe(11);
  });

  test('refreshes an expired OAuth token, persists it, and fetches usage with it', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'Expired OAuth provider',
      type: 'official',
      enabled: false,
      claudeOAuthCredentials: {
        accessToken: 'expired-access',
        refreshToken: 'refresh-before-rotation',
        expiresAt: Date.now() - 1,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
      },
    });
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).endsWith('/v1/oauth/token')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          grant_type: 'refresh_token',
          refresh_token: 'refresh-before-rotation',
          scope: 'user:inference user:profile',
        });
        return Response.json({
          access_token: 'refreshed-access',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
          scope: 'user:profile user:inference',
        });
      }
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer refreshed-access',
      );
      return Response.json({
        five_hour: {
          utilization: 42,
          resets_at: '2026-09-02T10:00:00.000Z',
        },
      });
    });

    const response = await app.request(
      `/api/config/claude/providers/${provider.id}/usage`,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data.five_hour.utilization).toBe(42);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(drainProviderRunnersForCredentialRefresh).toHaveBeenCalledOnce();
    expect(drainProviderRunnersForCredentialRefresh).toHaveBeenCalledWith(
      provider.id,
    );
    expect(closeAllActiveForCredentialRefresh).not.toHaveBeenCalled();
    expect(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)
        ?.claudeOAuthCredentials,
    ).toMatchObject({
      accessToken: 'refreshed-access',
      refreshToken: 'rotated-refresh',
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    });
  });

  test('retries one 401 with a refreshed token', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'OAuth 401 provider',
      type: 'official',
      enabled: false,
      claudeOAuthCredentials: {
        accessToken: 'rejected-access',
        refreshToken: '401-refresh',
        expiresAt: Date.now() + 60_000,
        scopes: ['user:inference'],
      },
    });
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).endsWith('/v1/oauth/token')) {
        calls.push('refresh');
        return Response.json({
          access_token: '401-refreshed-access',
          expires_in: 3600,
        });
      }
      const auth = new Headers(init?.headers).get('Authorization') ?? '';
      calls.push(auth);
      if (auth === 'Bearer rejected-access') {
        return new Response(null, { status: 401 });
      }
      return Response.json({
        seven_day: {
          utilization: 17,
          resets_at: '2026-09-08T10:00:00.000Z',
        },
      });
    });

    const response = await app.request(
      `/api/config/claude/providers/${provider.id}/usage`,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data.seven_day.utilization).toBe(17);
    expect(calls).toEqual([
      'Bearer rejected-access',
      'refresh',
      'Bearer 401-refreshed-access',
    ]);
  });

  test('retains the previous full snapshot when refresh succeeds but usage stays unavailable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T08:00:00.000Z'));
    const provider = runtimeConfig.createProvider({
      name: 'Refresh fallback provider',
      type: 'official',
      enabled: false,
      claudeOAuthCredentials: {
        accessToken: 'soon-expired-access',
        refreshToken: 'refresh-fallback-token',
        expiresAt: Date.now() + 60_000,
        scopes: ['user:inference'],
      },
    });
    let call = 0;
    globalThis.fetch = vi.fn(async (url) => {
      call += 1;
      if (call === 1) {
        return Response.json({
          five_hour: {
            utilization: 64,
            resets_at: '2026-09-02T10:00:00.000Z',
          },
        });
      }
      if (String(url).endsWith('/v1/oauth/token')) {
        return Response.json({
          access_token: 'fallback-refreshed-access',
          expires_in: 3600,
        });
      }
      return new Response(null, { status: 503 });
    });
    const usageUrl = `/api/config/claude/providers/${provider.id}/usage`;

    const first = await (await app.request(usageUrl)).json();
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 1);
    const secondResponse = await app.request(usageUrl);
    const second = await secondResponse.json();

    expect(secondResponse.status).toBe(200);
    expect(call).toBe(3);
    expect(second.data.five_hour.utilization).toBe(64);
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(second.error).toBe('Usage API returned 503');
  });

  test('joins the new credential epoch when an old usage request resolves late', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'In-flight credential provider',
      type: 'official',
      enabled: false,
      claudeOAuthCredentials: {
        accessToken: 'in-flight-old-access',
        refreshToken: 'in-flight-old-refresh',
        expiresAt: Date.now() + 60_000,
        scopes: ['user:inference'],
      },
    });
    let resolveOld!: (response: Response) => void;
    let resolveNew!: (response: Response) => void;
    const requestedTokens: string[] = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      requestedTokens.push(
        new Headers(init?.headers).get('Authorization') ?? '',
      );
      return new Promise<Response>((resolve) => {
        if (requestedTokens.length === 1) resolveOld = resolve;
        else resolveNew = resolve;
      });
    });
    const usageUrl = `/api/config/claude/providers/${provider.id}/usage`;

    const oldCaller = app.request(usageUrl);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));

    const rotate = await app.request(
      `/api/config/claude/providers/${provider.id}/secrets`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          claudeOAuthCredentials: {
            accessToken: 'in-flight-new-access',
            refreshToken: 'in-flight-new-refresh',
            expiresAt: Date.now() + 120_000,
            scopes: ['user:inference'],
          },
        }),
      },
    );
    expect(rotate.status).toBe(200);

    const newCaller = app.request(usageUrl);
    const deduplicatedCaller = app.request(usageUrl);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    resolveOld(
      Response.json({
        five_hour: {
          utilization: 10,
          resets_at: '2026-09-02T10:00:00.000Z',
        },
      }),
    );
    await Promise.resolve();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    resolveNew(
      Response.json({
        five_hour: {
          utilization: 20,
          resets_at: '2026-09-02T11:00:00.000Z',
        },
      }),
    );
    const bodies = await Promise.all(
      [oldCaller, newCaller, deduplicatedCaller].map(async (request) =>
        (await request).json(),
      ),
    );

    expect(requestedTokens).toEqual([
      'Bearer in-flight-old-access',
      'Bearer in-flight-new-access',
    ]);
    expect(bodies.map((body) => body.data.five_hour.utilization)).toEqual([
      20, 20, 20,
    ]);
    expect(
      (await (await app.request(usageUrl)).json()).data.five_hour.utilization,
    ).toBe(20);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  test('does not let a late token refresh overwrite an administrator credential rotation', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'Refresh CAS race provider',
      type: 'official',
      enabled: false,
      claudeOAuthCredentials: {
        accessToken: 'cas-old-access',
        refreshToken: 'cas-old-refresh',
        expiresAt: Date.now() - 1,
        scopes: ['user:inference'],
      },
    });
    let resolveOldRefresh!: (response: Response) => void;
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).endsWith('/v1/oauth/token')) {
        return new Promise<Response>((resolve) => {
          resolveOldRefresh = resolve;
        });
      }
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer cas-admin-access',
      );
      return Response.json({
        five_hour: {
          utilization: 22,
          resets_at: '2026-09-02T10:00:00.000Z',
        },
      });
    });
    const usageUrl = `/api/config/claude/providers/${provider.id}/usage`;

    const oldCaller = app.request(usageUrl);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
    const rotate = await app.request(
      `/api/config/claude/providers/${provider.id}/secrets`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          claudeOAuthCredentials: {
            accessToken: 'cas-admin-access',
            refreshToken: 'cas-admin-refresh',
            expiresAt: Date.now() + 60_000,
            scopes: ['user:inference'],
          },
        }),
      },
    );
    expect(rotate.status).toBe(200);

    const currentCaller = app.request(usageUrl);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    expect(
      (await (await currentCaller).json()).data.five_hour.utilization,
    ).toBe(22);
    resolveOldRefresh(
      Response.json({
        access_token: 'cas-must-not-win-access',
        refresh_token: 'cas-must-not-win-refresh',
        expires_in: 3600,
      }),
    );
    expect((await (await oldCaller).json()).data.five_hour.utilization).toBe(
      22,
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)
        ?.claudeOAuthCredentials,
    ).toMatchObject({
      accessToken: 'cas-admin-access',
      refreshToken: 'cas-admin-refresh',
    });
  });

  test('does not resurrect a deleted provider from an old in-flight response', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'Deleted in-flight provider',
      type: 'official',
      enabled: false,
      claudeOAuthCredentials: {
        accessToken: 'deleted-access',
        refreshToken: 'deleted-refresh',
        expiresAt: Date.now() + 60_000,
        scopes: ['user:inference'],
      },
    });
    quotaObservation.observeProviderQuota(provider.id, {
      source: 'sdk_rate_limit_event',
      observedAt: Date.now(),
      status: 'allowed_warning',
    });
    let resolveUsage!: (response: Response) => void;
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveUsage = resolve;
        }),
    );
    const usageUrl = `/api/config/claude/providers/${provider.id}/usage`;

    const oldCaller = app.request(usageUrl);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
    const deleted = await app.request(
      `/api/config/claude/providers/${provider.id}`,
      { method: 'DELETE' },
    );
    expect(deleted.status).toBe(200);
    expect(
      quotaObservation.getProviderQuotaObservation(provider.id),
    ).toBeNull();

    resolveUsage(
      Response.json({
        five_hour: {
          utilization: 99,
          resets_at: '2026-09-02T10:00:00.000Z',
        },
      }),
    );
    expect((await oldCaller).status).toBe(400);
    expect((await app.request(usageUrl)).status).toBe(400);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });
});
