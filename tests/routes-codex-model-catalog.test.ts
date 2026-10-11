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

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-codex-catalog-'),
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
vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/middleware/auth.ts')>();
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: 'codex-catalog-admin',
        username: 'codex-catalog-admin',
        display_name: 'Codex Catalog Admin',
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
const catalogSync = await import('../src/codex-gateway/model-catalog-sync.js');
const { CODEX_GATEWAY_BASE_URL_PLACEHOLDER } =
  await import('../src/codex-gateway/types.js');

const app = web.createAppForTest({
  queue: {},
  getRegisteredGroups: () => ({}),
  sessions: {},
} as any);

const MODELS_URL =
  'https://chatgpt.com/backend-api/codex/models?client_version=0.162.1';
const modelsEndpoint = vi.fn();

function codexProvider(planType: string | null): string {
  return runtimeConfig.createProvider({
    name: `ChatGPT ${planType}`,
    type: 'third_party',
    anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
    anthropicAuthToken: `gateway-${planType}`,
    anthropicModel: 'gpt-6-sol',
    codexOAuthCredentials: {
      accessToken: `access-${planType}`,
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3_600_000,
      accountId: `account-${planType}`,
      planType,
      email: null,
      updatedAt: new Date().toISOString(),
    },
    enabled: true,
  }).id;
}

const catalog = (query = '') =>
  app.request(`/api/config/codex/model-catalog${query}`);

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });
  db.initDatabase();
});

beforeEach(() => {
  fs.rmSync(path.join(tmpDir, 'config'), { recursive: true, force: true });
  catalogSync.resetCodexCatalogSyncForTests();
  catalogSync.setCodexCatalogDiskCachePathForTests(null);
  modelsEndpoint.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === MODELS_URL) return modelsEndpoint(url, init);
      // The global GitHub sync is not under test here.
      return new Response('offline', { status: 503 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /api/config/codex/model-catalog', () => {
  test('returns the global catalog with per-model request-shape fields', async () => {
    const response = await catalog();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      defaultModel: 'gpt-6.1-sol',
      // gpt-6.1-sol's own catalog default, as new providers get it.
      defaultEffort: 'low',
      source: 'builtin',
    });
    expect(body).not.toHaveProperty('providerId');
    expect(
      body.models.find((entry: any) => entry.value === 'gpt-6.1-sol'),
    ).toMatchObject({
      useResponsesLite: true,
      supportsVerbosity: true,
      defaultVerbosity: 'low',
      contextWindow: 272_000,
      minimalClientVersion: '0.153.0',
      serviceTiers: ['priority'],
    });
    expect(modelsEndpoint).not.toHaveBeenCalled();
  });

  test('filters by the provider plan and falls back to the global catalog', async () => {
    const providerId = codexProvider('promax');
    modelsEndpoint.mockResolvedValue(new Response('down', { status: 502 }));
    const body = await (await catalog(`?providerId=${providerId}`)).json();
    expect(modelsEndpoint).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ providerId, planType: 'promax' });
    expect(body.source).toBe('builtin');
    const values = body.models.map((entry: any) => entry.value);
    expect(values).not.toContain('gpt-6-sol');
    expect(values).toContain('gpt-6.1-sol');
    expect(body.defaultModel).toBe('gpt-6.1-sol');
  });

  test("uses the account's live catalog once fetched", async () => {
    const providerId = codexProvider('plus');
    modelsEndpoint.mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [
            {
              slug: 'gpt-6-sol',
              visibility: 'list',
              priority: 1,
              use_responses_lite: true,
              support_verbosity: true,
              default_verbosity: 'low',
              available_in_plans: ['plus'],
              default_reasoning_level: 'medium',
              supported_reasoning_levels: [
                { effort: 'low' },
                { effort: 'medium' },
              ],
            },
            {
              slug: 'gpt-team-only',
              visibility: 'list',
              priority: 2,
              available_in_plans: ['team'],
              supported_reasoning_levels: [{ effort: 'low' }],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const body = await (await catalog(`?providerId=${providerId}`)).json();
    expect(body.source).toBe('live');
    expect(body.models.map((entry: any) => entry.value)).toEqual(['gpt-6-sol']);
    // The account lacks the default model: its first model and level stand in.
    expect(body).toMatchObject({
      defaultModel: 'gpt-6-sol',
      defaultEffort: 'medium',
    });
    const [, init] = modelsEndpoint.mock.calls[0];
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer access-plus',
      'ChatGPT-Account-ID': 'account-plus',
    });
    // Cached for the hour: a second load does not refetch.
    await catalog(`?providerId=${providerId}`);
    expect(modelsEndpoint).toHaveBeenCalledTimes(1);
  });

  test('returns 404 for unknown or non-Codex providers', async () => {
    const thirdParty = runtimeConfig.createProvider({
      name: 'Relay',
      type: 'third_party',
      anthropicBaseUrl: 'https://relay.example.test',
      anthropicAuthToken: 'secret',
      anthropicModel: 'm',
      enabled: true,
    }).id;
    expect((await catalog('?providerId=missing')).status).toBe(404);
    expect((await catalog(`?providerId=${thirdParty}`)).status).toBe(404);
    expect(modelsEndpoint).not.toHaveBeenCalled();
  });
});
