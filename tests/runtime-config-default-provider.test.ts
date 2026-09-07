import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-config-default-'));

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
const { trySelectPoolProvider } = await import('../src/container-runner.js');
const configFile = path.join(root, 'config', 'claude-provider.json');

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'groups'), { recursive: true });
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('independent model configurations', () => {
  test('strips root-side permission controls from saved Workspace env', () => {
    runtimeConfig.saveContainerEnvConfig('permission-env-workspace', {
      customEnv: {
        HAPPYCLAW_INTERNAL_IDENTITY_MODE: 'direct',
        HAPPYCLAW_PASSWD_FILE: '/workspace/group/passwd',
        HAPPYCLAW_SESSION_PERMISSION_HELPER: '/workspace/group/evil.sh',
        PROJECT_ENV: 'kept',
      },
    });

    expect(
      runtimeConfig.getContainerEnvConfig('permission-env-workspace').customEnv,
    ).toEqual({ PROJECT_ENV: 'kept' });
  });

  test('honors creation, toggle, and deletion without a default-model lock', () => {
    const initiallyDisabled = runtimeConfig.createProvider({
      name: 'Initially disabled',
      type: 'official',
      anthropicApiKey: 'disabled-key',
      enabled: false,
    });
    expect(initiallyDisabled.enabled).toBe(false);
    runtimeConfig.setProviderEnabled(initiallyDisabled.id, true);
    runtimeConfig.setProviderEnabled(initiallyDisabled.id, false);
    runtimeConfig.deleteProvider(initiallyDisabled.id);
    expect(
      runtimeConfig
        .getProviders()
        .some((provider) => provider.id === initiallyDisabled.id),
    ).toBe(false);

    const first = runtimeConfig.createProvider({
      name: 'Official subscription',
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicModel: 'sonnet',
      enabled: true,
    });
    const second = runtimeConfig.createProvider({
      name: 'Model gateway',
      type: 'third_party',
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicAuthToken: 'gateway-token',
      anthropicModel: 'gateway-model',
      customEnv: { ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: model-b' },
      enabled: true,
    });

    expect(runtimeConfig.getClaudeProviderConfig()).toMatchObject({
      anthropicApiKey: 'official-key',
      anthropicModel: 'sonnet',
    });

    runtimeConfig.setProviderEnabled(first.id, false);
    expect(runtimeConfig.getClaudeProviderConfig()).toMatchObject({
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicAuthToken: 'gateway-token',
      anthropicModel: 'gateway-model',
    });
    expect(runtimeConfig.getActiveProfileCustomEnv()).toEqual({
      ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: model-b',
    });
    runtimeConfig.setProviderEnabled(second.id, false);
    expect(runtimeConfig.getEnabledProviders()).toEqual([]);
    expect(() => runtimeConfig.getClaudeProviderConfig()).toThrow(
      '没有启用的模型配置',
    );
    runtimeConfig.setProviderEnabled(second.id, true);
    runtimeConfig.deleteProvider(first.id);
  });

  test('Agent selection overrides a legacy Workspace Provider environment', () => {
    const selected = runtimeConfig.createProvider({
      name: 'Agent-only model gateway',
      type: 'third_party',
      anthropicBaseUrl: 'https://agent-only.example.test',
      anthropicAuthToken: 'agent-only-token',
      anthropicModel: 'agent-only-model',
      customEnv: { ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: agent-only' },
      enabled: false,
    });
    runtimeConfig.saveContainerEnvConfig('model-workspace', {
      anthropicBaseUrl: 'https://workspace-override.example.test',
      anthropicAuthToken: 'workspace-token',
      anthropicModel: 'workspace-model',
    });

    const result = trySelectPoolProvider('model-workspace', null, selected.id);
    expect(result).toMatchObject({
      profileId: selected.id,
      resolved: {
        config: {
          anthropicBaseUrl: 'https://agent-only.example.test',
          anthropicAuthToken: 'agent-only-token',
          anthropicModel: 'agent-only-model',
        },
        customEnv: { ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: agent-only' },
      },
    });
    expect(db.getSessionProviderId('model-workspace')).toBe(selected.id);
  });

  test('migrates V4 without creating a default-model pointer', () => {
    const stored = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<
      string,
      unknown
    >;
    stored.version = 4;
    delete stored.defaultProviderId;
    fs.writeFileSync(configFile, `${JSON.stringify(stored, null, 2)}\n`);

    runtimeConfig.getProviders();

    const migrated = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(migrated.version).toBe(5);
    expect(migrated).not.toHaveProperty('defaultProviderId');
  });

  test('normalizes an existing V5 default pointer without changing switches', () => {
    const before = runtimeConfig
      .getProviders()
      .map((provider) => ({ id: provider.id, enabled: provider.enabled }));
    const stored = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<
      string,
      unknown
    >;
    stored.defaultProviderId = before[0]?.id ?? 'legacy-default';
    fs.writeFileSync(configFile, `${JSON.stringify(stored, null, 2)}\n`);

    expect(
      runtimeConfig
        .getProviders()
        .map((provider) => ({ id: provider.id, enabled: provider.enabled })),
    ).toEqual(before);
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).not.toHaveProperty(
      'defaultProviderId',
    );
  });

  test('persists refreshed OAuth credentials with full compare-and-swap semantics', () => {
    const original = {
      accessToken: 'oauth-access-original',
      refreshToken: 'oauth-refresh-original',
      expiresAt: 1_800_000_000_000,
      // Imported legacy credentials can lack scopes; reconciliation sees the
      // default scopes emitted by buildClaudeAiOauthPayload.
      scopes: [],
      subscriptionType: 'max',
    };
    const effectiveOriginal = {
      ...original,
      scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
    };
    const refreshed = {
      accessToken: 'oauth-access-refreshed',
      refreshToken: 'oauth-refresh-refreshed',
      expiresAt: 1_800_003_600_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    };
    const provider = runtimeConfig.createProvider({
      name: 'OAuth CAS provider',
      type: 'official',
      claudeOAuthCredentials: original,
      enabled: true,
    });

    expect(
      runtimeConfig.updateProviderOAuthCredentialsIfCurrent(
        provider.id,
        {
          ...effectiveOriginal,
          scopes: [...effectiveOriginal.scopes].reverse(),
        },
        refreshed,
      ),
    ).toBe(true);
    expect(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)
        ?.claudeOAuthCredentials,
    ).toEqual(refreshed);

    expect(
      runtimeConfig.updateProviderOAuthCredentialsIfCurrent(
        provider.id,
        original,
        { ...refreshed, accessToken: 'must-not-win' },
      ),
    ).toBe(false);
    expect(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)
        ?.claudeOAuthCredentials,
    ).toEqual(refreshed);
  });
});
