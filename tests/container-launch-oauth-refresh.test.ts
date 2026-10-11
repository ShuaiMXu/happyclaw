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

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-launch-oauth-refresh-'),
);

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runtimeConfig = await import('../src/runtime-config.js');
const db = await import('../src/db.js');
const containerRunner = await import('../src/container-runner.js');

const MINUTE = 60_000;

function oauthProvider(name: string, expiresInMs: number, enabled = true) {
  return runtimeConfig.createProvider({
    name,
    type: 'official',
    enabled,
    claudeOAuthCredentials: {
      accessToken: `${name}-access`,
      refreshToken: `${name}-refresh`,
      expiresAt: Date.now() + expiresInMs,
      scopes: ['user:inference', 'user:profile'],
    },
  });
}

function clearProviders(): void {
  for (const provider of runtimeConfig.getProviders()) {
    runtimeConfig.deleteProvider(provider.id);
  }
}

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  db.initDatabase();
});

afterEach(() => {
  vi.useRealTimers();
  clearProviders();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('launch-time Claude OAuth renewal', () => {
  test('renews only due OAuth candidates of the automatic pool', async () => {
    const due = oauthProvider('due', 20 * MINUTE);
    oauthProvider('fresh', 8 * 60 * MINUTE);
    oauthProvider('disabled-due', 20 * MINUTE, false);
    runtimeConfig.createProvider({
      name: 'api-key',
      type: 'official',
      enabled: true,
      anthropicApiKey: 'sk-ant-api03-pool',
    });
    const refresh = vi.fn(async () => ({ status: 'not_due' as const }));

    await containerRunner.refreshLaunchOAuthCredentials(
      'launch-pool',
      null,
      null,
      refresh,
    );
    expect(refresh.mock.calls).toEqual([[due.id]]);
  });

  test('renews only the pinned model configuration', async () => {
    const pinned = oauthProvider('pinned', 20 * MINUTE, false);
    oauthProvider('pool-due', 20 * MINUTE);
    const refresh = vi.fn(async () => ({ status: 'not_due' as const }));

    expect(
      containerRunner.launchOAuthRefreshCandidates(
        'launch-pinned',
        null,
        pinned.id,
      ),
    ).toEqual([pinned.id]);
    await containerRunner.refreshLaunchOAuthCredentials(
      'launch-pinned',
      null,
      pinned.id,
      refresh,
    );
    expect(refresh.mock.calls).toEqual([[pinned.id]]);
  });

  test('skips the pool when the workspace overrides provider auth', async () => {
    oauthProvider('override-a', 20 * MINUTE);
    oauthProvider('override-b', 20 * MINUTE);
    runtimeConfig.saveContainerEnvConfig('launch-override', {
      anthropicApiKey: 'sk-ant-api03-workspace',
    });
    expect(
      containerRunner.launchOAuthRefreshCandidates('launch-override'),
    ).toEqual([]);
  });

  test('waits for the renewal of a token about to expire', async () => {
    vi.useFakeTimers();
    const provider = oauthProvider('blocking', 5 * MINUTE);
    let settled = false;
    const refresh = vi.fn(
      () =>
        new Promise<{ status: 'not_due' }>((resolve) => {
          setTimeout(() => resolve({ status: 'not_due' }), 20_000);
        }),
    );
    const launch = containerRunner
      .refreshLaunchOAuthCredentials(
        'launch-blocking',
        null,
        provider.id,
        refresh,
      )
      .then(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(19_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await launch;
    expect(settled).toBe(true);
  });

  test('bounds the wait when the token still has time left', async () => {
    vi.useFakeTimers();
    const provider = oauthProvider('bounded', 25 * MINUTE);
    let settled = false;
    const refresh = vi.fn(
      () => new Promise<{ status: 'not_due' }>(() => undefined),
    );
    const launch = containerRunner
      .refreshLaunchOAuthCredentials(
        'launch-bounded',
        null,
        provider.id,
        refresh,
      )
      .then(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await launch;
    expect(settled).toBe(true);
  });
});
