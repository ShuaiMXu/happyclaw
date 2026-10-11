import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-third-party-routes-'),
);

const mocks = vi.hoisted(() => ({
  connectivity: vi.fn(),
}));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: tmpDir,
  STORE_DIR: path.join(tmpDir, 'db'),
  GROUPS_DIR: path.join(tmpDir, 'groups'),
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/provider-connectivity.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  testProviderConnectivity: mocks.connectivity,
}));

vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/middleware/auth.ts')>();
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: 'third-party-admin',
        username: 'third-party-admin',
        display_name: 'Admin',
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

const app = web.createAppForTest({
  queue: {
    stopGroup: vi.fn(async () => {}),
    listDescendantJids: () => [],
    pauseGroupsForMutation: () => ({ id: 0 }),
    resumeGroupsAfterMutation: vi.fn(),
  },
  getRegisteredGroups: () => ({}),
  sessions: {},
} as any);

async function request(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await app.request(`/api/config/claude${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function createThirdParty(patch: Record<string, unknown> = {}) {
  return runtimeConfig.createProvider({
    name: 'GLM',
    type: 'third_party',
    anthropicBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
    anthropicAuthToken: 'glm-old-secret',
    anthropicModel: 'glm-5.3',
    ...patch,
  });
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });
  db.initDatabase();
});

beforeEach(() => {
  fs.rmSync(path.join(tmpDir, 'config'), { recursive: true, force: true });
  mocks.connectivity.mockReset();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('third-party provider routes', () => {
  test('create rejects env the runtime would drop', async () => {
    const { status, body } = await request('POST', '/providers', {
      name: 'Bad',
      type: 'third_party',
      anthropicBaseUrl: 'https://relay.test',
      anthropicAuthToken: 'tok',
      customEnv: { NODE_OPTIONS: '--require x' },
    });
    expect(status).toBe(400);
    expect(body.error).toContain('NODE_OPTIONS');
  });

  test('one PATCH saves fields, auth mode and the new key together', async () => {
    const provider = createThirdParty();
    const { status, body } = await request(
      'PATCH',
      `/providers/${provider.id}`,
      {
        anthropicModel: 'glm-5.3[1m]',
        anthropicAuthMode: 'bearer',
        anthropicAuthToken: 'glm-new-secret',
      },
    );
    expect(status).toBe(200);
    expect(body.provider).toMatchObject({
      anthropicModel: 'glm-5.3[1m]',
      anthropicAuthMode: 'bearer',
    });
    expect(JSON.stringify(body)).not.toContain('glm-new-secret');
    const stored = runtimeConfig.getProviderById(provider.id)!;
    expect(stored.anthropicAuthToken).toBe('glm-new-secret');
  });

  test('PATCH refuses a key change for an official provider', async () => {
    const official = runtimeConfig.createProvider({
      name: 'Claude',
      type: 'official',
      anthropicApiKey: 'sk-ant-key',
    });
    const { status } = await request('PATCH', `/providers/${official.id}`, {
      anthropicAuthToken: 'x',
    });
    expect(status).toBe(400);
  });

  test('duplicate keeps the key and starts disabled', async () => {
    const provider = createThirdParty({ enabled: true });
    const { status, body } = await request(
      'POST',
      `/providers/${provider.id}/duplicate`,
    );
    expect(status).toBe(201);
    expect(body).toMatchObject({
      name: 'GLM (副本)',
      enabled: false,
      hasAnthropicAuthToken: true,
    });
    expect(runtimeConfig.getProviderById(body.id)!.anthropicAuthToken).toBe(
      'glm-old-secret',
    );
  });

  test('toggle refuses to enable a provider without credentials', async () => {
    const provider = createThirdParty({ anthropicAuthToken: '' });
    const { status, body } = await request(
      'POST',
      `/providers/${provider.id}/toggle`,
      { enabled: true },
    );
    expect(status).toBe(400);
    expect(body.error).toContain('凭据');
    expect(runtimeConfig.getProviderById(provider.id)!.enabled).toBe(false);
  });

  test('test connection falls back to the stored key without returning it', async () => {
    const provider = createThirdParty({
      customEnv: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash' },
    });
    mocks.connectivity.mockResolvedValue({ ok: true, probes: [] });
    const { status, body } = await request('POST', '/providers/test', {
      providerId: provider.id,
      anthropicModel: 'glm-5.3[1m]',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, probes: [] });
    expect(mocks.connectivity).toHaveBeenCalledWith({
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      token: 'glm-old-secret',
      // A legacy provider is probed with the header its runtime infers.
      authMode: 'x-api-key',
      model: 'glm-5.3[1m]',
      haikuModel: 'glm-5.3-flash',
      customHeaders: undefined,
    });
  });

  test('an enabled provider cannot be created or left without a key', async () => {
    const created = await request('POST', '/providers', {
      name: 'Keyless',
      type: 'third_party',
      anthropicBaseUrl: 'https://relay.test',
      enabled: true,
    });
    expect(created.status).toBe(400);

    const provider = createThirdParty({ enabled: true });
    const cleared = await request('PATCH', `/providers/${provider.id}`, {
      clearAnthropicAuthToken: true,
    });
    expect(cleared.status).toBe(400);
    expect(cleared.body.error).toContain('先停用');
    expect(runtimeConfig.getProviderById(provider.id)!.anthropicAuthToken).toBe(
      'glm-old-secret',
    );
  });

  test('test connection needs an endpoint and a key', async () => {
    const { status, body } = await request('POST', '/providers/test', {
      anthropicBaseUrl: 'https://relay.test',
    });
    expect(status).toBe(400);
    expect(body.error).toContain('密钥');
    expect(mocks.connectivity).not.toHaveBeenCalled();
  });
});
