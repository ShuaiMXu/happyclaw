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
  path.join(os.tmpdir(), 'happyclaw-claude-oauth-refresh-'),
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

const db = await import('../src/db.js');
const runtimeConfig = await import('../src/runtime-config.js');
const refresh = await import('../src/claude-oauth-refresh.js');

const originalFetch = globalThis.fetch;
const HOUR = 60 * 60_000;

function createOAuthProvider(
  overrides: Partial<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
  }> = {},
  account?: { accountUuid: string },
) {
  return runtimeConfig.createProvider({
    name: `Refresh fixture ${Math.random().toString(36).slice(2, 8)}`,
    type: 'official',
    enabled: false,
    claudeOAuthCredentials: {
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
      expiresAt: Date.now() - 1,
      scopes: ['user:inference', 'user:profile'],
      ...overrides,
    },
    claudeOAuthAccount: account ?? null,
  });
}

function stored(providerId: string) {
  return runtimeConfig.getProviderById(providerId)!;
}

function tokenResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  db.initDatabase();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  refresh.resetClaudeOAuthRefreshStateForTest();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Claude OAuth renewal window', () => {
  test('renews 45 ± 15 minutes ahead with a stable per-provider lead', () => {
    for (const id of ['a', 'b', 'provider-x', 'f00dbabe']) {
      const lead = refresh.claudeOAuthRefreshLeadMs(id);
      expect(lead).toBeGreaterThanOrEqual(30 * 60_000);
      expect(lead).toBeLessThanOrEqual(60 * 60_000);
      expect(refresh.claudeOAuthRefreshLeadMs(id)).toBe(lead);
    }
    const now = Date.now();
    expect(
      refresh.isClaudeOAuthRefreshDue(
        'a',
        { expiresAt: now + 61 * 60_000 },
        now,
      ),
    ).toBe(false);
    expect(
      refresh.isClaudeOAuthRefreshDue(
        'a',
        { expiresAt: now + 29 * 60_000 },
        now,
      ),
    ).toBe(true);
  });

  test('does not touch the network for a credential outside the window', async () => {
    const provider = createOAuthProvider({ expiresAt: Date.now() + 8 * HOUR });
    globalThis.fetch = vi.fn();
    await expect(
      refresh.refreshClaudeProviderOAuth(provider.id),
    ).resolves.toEqual({ status: 'not_due' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('Claude OAuth host refresh', () => {
  test('single-flights concurrent callers and persists the rotation with fan-out', async () => {
    const provider = createOAuthProvider({}, { accountUuid: 'acct-1' });
    const sessionDir = path.join(
      tmpDir,
      'sessions',
      'refresh-fanout',
      '.claude',
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    db.setSessionProviderId('refresh-fanout', null, provider.id);
    const listener = vi.fn();
    const unsubscribe = refresh.onClaudeOAuthCredentialsRefreshed(listener);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = vi.fn(async (_url, init) => {
      expect(new Headers(init?.headers).get('User-Agent')).toBe('axios/1.15.2');
      await gate;
      return tokenResponse({
        access_token: 'access-new',
        refresh_token: 'refresh-new',
        expires_in: 28_800,
        scope: 'user:inference user:profile user:sessions:claude_code',
        account: { uuid: 'acct-1', email_address: 'owner@example.com' },
        organization: { uuid: 'org-1' },
      });
    });

    const first = refresh.refreshClaudeProviderOAuth(provider.id);
    const second = refresh.refreshClaudeProviderOAuth(provider.id);
    release();
    const [a, b] = await Promise.all([first, second]);
    unsubscribe();

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(a.status).toBe('refreshed');
    expect(b).toBe(a);
    const updated = stored(provider.id);
    expect(updated.claudeOAuthCredentials).toMatchObject({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
    });
    expect(updated.claudeOAuthCredentials!.expiresAt).toBeGreaterThan(
      Date.now() + 7 * HOUR,
    );
    expect(updated.claudeOAuthAccount).toEqual({
      accountUuid: 'acct-1',
      emailAddress: 'owner@example.com',
      organizationUuid: 'org-1',
    });
    expect(updated.claudeOAuthLastRefreshAt).toBeGreaterThan(0);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(sessionDir, '.credentials.json'), 'utf8'),
      ).claudeAiOauth.refreshToken,
    ).toBe('refresh-new');
    expect(listener).toHaveBeenCalledWith(provider.id);
  });

  test('marks invalid_grant as needing a new login and stops retrying', async () => {
    const provider = createOAuthProvider();
    globalThis.fetch = vi.fn(async () =>
      tokenResponse(
        { error: 'invalid_grant', error_description: 'Refresh token revoked' },
        400,
      ),
    );

    await expect(
      refresh.refreshClaudeProviderOAuth(provider.id),
    ).resolves.toMatchObject({ status: 'failed', terminal: true });
    expect(stored(provider.id).claudeOAuthLastRefreshError).toMatchObject({
      kind: 'invalid_grant',
      message: 'OAuth token refresh returned 400 (invalid_grant)',
    });
    expect(runtimeConfig.toPublicProvider(stored(provider.id))).toMatchObject({
      claudeOAuthNeedsReLogin: true,
    });

    await expect(
      refresh.refreshClaudeProviderOAuth(provider.id, { force: true }),
    ).resolves.toMatchObject({ status: 'needs_relogin' });
    expect(globalThis.fetch).toHaveBeenCalledOnce();

    // New credentials lift the state.
    runtimeConfig.updateProviderSecrets(provider.id, {
      claudeOAuthCredentials: {
        accessToken: 'relogin-access',
        refreshToken: 'relogin-refresh',
        expiresAt: Date.now() + 8 * HOUR,
        scopes: ['user:inference', 'user:profile'],
      },
    });
    expect(stored(provider.id).claudeOAuthLastRefreshError).toBeNull();
  });

  test('treats a 401 rejection as terminal', async () => {
    const provider = createOAuthProvider();
    globalThis.fetch = vi.fn(async () => new Response('', { status: 401 }));
    await expect(
      refresh.refreshClaudeProviderOAuth(provider.id),
    ).resolves.toMatchObject({ status: 'failed', terminal: true });
    expect(stored(provider.id).claudeOAuthLastRefreshError?.kind).toBe(
      'rejected',
    );
  });

  test('backs off transient failures and honors Retry-After', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T08:00:00.000Z'));
    const provider = createOAuthProvider();
    globalThis.fetch = vi.fn(async () => new Response('', { status: 503 }));

    await expect(
      refresh.refreshClaudeProviderOAuth(provider.id),
    ).resolves.toMatchObject({ status: 'failed', terminal: false });
    await expect(
      refresh.refreshClaudeProviderOAuth(provider.id),
    ).resolves.toMatchObject({ status: 'backoff' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(stored(provider.id).claudeOAuthLastRefreshError).toBeNull();

    await vi.advanceTimersByTimeAsync(30_001);
    globalThis.fetch = vi.fn(
      async () =>
        new Response('', { status: 429, headers: { 'retry-after': '120' } }),
    );
    await refresh.refreshClaudeProviderOAuth(provider.id);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(
      refresh.refreshClaudeProviderOAuth(provider.id),
    ).resolves.toMatchObject({ status: 'backoff' });

    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(
      refresh.refreshClaudeProviderOAuth(provider.id),
    ).resolves.toMatchObject({ status: 'failed', terminal: false });
    expect(stored(provider.id).claudeOAuthLastRefreshError).toBeNull();
  });

  test('retries an invalid_scope rejection once with the stored scope', async () => {
    const provider = createOAuthProvider({
      scopes: ['user:inference', 'user:profile', 'org:create_api_key'],
    });
    const scopes: string[] = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      scopes.push(JSON.parse(String(init?.body)).scope);
      return scopes.length === 1
        ? tokenResponse({ error: 'invalid_scope' }, 400)
        : tokenResponse({ access_token: 'scoped-access', expires_in: 3600 });
    });
    await expect(
      refresh.refreshClaudeProviderOAuth(provider.id),
    ).resolves.toMatchObject({ status: 'refreshed' });
    expect(scopes).toEqual([
      'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins',
      'user:inference user:profile org:create_api_key',
    ]);
    // No rotated refresh token in the response keeps the stored one.
    expect(stored(provider.id).claudeOAuthCredentials?.refreshToken).toBe(
      'refresh-old',
    );
  });

  test('rejects a refresh that silently switches Claude accounts', async () => {
    const provider = createOAuthProvider({}, { accountUuid: 'acct-original' });
    globalThis.fetch = vi.fn(async () =>
      tokenResponse({
        access_token: 'foreign-access',
        refresh_token: 'foreign-refresh',
        expires_in: 3600,
        account: { uuid: 'acct-other' },
      }),
    );
    await expect(
      refresh.refreshClaudeProviderOAuth(provider.id),
    ).resolves.toMatchObject({ status: 'failed', terminal: true });
    expect(stored(provider.id).claudeOAuthCredentials?.accessToken).toBe(
      'access-old',
    );
    expect(stored(provider.id).claudeOAuthLastRefreshError?.kind).toBe(
      'account_mismatch',
    );
  });

  test('never overwrites credentials replaced during the exchange', async () => {
    const provider = createOAuthProvider();
    let resolveRefresh!: (response: Response) => void;
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const pending = refresh.refreshClaudeProviderOAuth(provider.id);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
    runtimeConfig.updateProviderSecrets(provider.id, {
      claudeOAuthCredentials: {
        accessToken: 'admin-access',
        refreshToken: 'admin-refresh',
        expiresAt: Date.now() + 8 * HOUR,
        scopes: ['user:inference', 'user:profile'],
      },
    });
    resolveRefresh(
      tokenResponse({
        access_token: 'late-access',
        refresh_token: 'late-refresh',
        expires_in: 3600,
      }),
    );
    await expect(pending).resolves.toEqual({ status: 'superseded' });
    expect(stored(provider.id).claudeOAuthCredentials?.accessToken).toBe(
      'admin-access',
    );
  });

  test('ignores a terminal rejection of a token that was already replaced', async () => {
    const provider = createOAuthProvider();
    let resolveRefresh!: (response: Response) => void;
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const pending = refresh.refreshClaudeProviderOAuth(provider.id);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
    runtimeConfig.updateProviderSecrets(provider.id, {
      claudeCodeOauthToken: 'sk-ant-oat01-replacement',
    });
    resolveRefresh(tokenResponse({ error: 'invalid_grant' }, 400));
    await expect(pending).resolves.toEqual({ status: 'superseded' });
    expect(stored(provider.id).claudeOAuthLastRefreshError).toBeNull();
  });
});
