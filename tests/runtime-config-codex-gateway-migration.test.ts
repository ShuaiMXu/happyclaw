import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-migration-'));
vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runtime = await import('../src/runtime-config.js');
const gateway = await import('../src/codex-gateway/runner-tokens.js');
const { CODEX_GATEWAY_BASE_URL_PLACEHOLDER } =
  await import('../src/codex-gateway/types.js');
const configFile = path.join(root, 'config', 'claude-provider.json');
const key = crypto.randomBytes(32);
const credentials = {
  accessToken: 'existing-access-token',
  refreshToken: 'existing-refresh-token',
  expiresAt: 2_000_000_000_000,
  accountId: 'existing-account',
  email: 'fixture@example.invalid',
  planType: 'plus',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

function legacyProvider(id: string, identifier = '', codex = true) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(
      JSON.stringify({
        anthropicAuthToken: identifier,
        codexOAuthCredentials: codex ? credentials : null,
      }),
    ),
    cipher.final(),
  ]);
  return {
    id,
    name: id,
    type: 'third_party',
    enabled: true,
    weight: 1,
    anthropicBaseUrl: codex
      ? CODEX_GATEWAY_BASE_URL_PLACEHOLDER
      : 'https://relay.example.invalid',
    anthropicModel: 'gpt-6-sol',
    customEnv: { CODEX_REASONING_EFFORT: 'high' },
    updatedAt: credentials.updatedAt,
    secrets: {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64'),
    },
  };
}

function writeLegacy(version: number, providers = [legacyProvider('codex')]) {
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      version,
      providers,
      balancing: {
        strategy: 'failover',
        unhealthyThreshold: 7,
        recoveryIntervalMs: 1234,
      },
    }),
  );
}

beforeEach(() => {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'config', 'claude-provider.key'),
    key.toString('hex'),
  );
  fs.rmSync(configFile, { force: true });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('legacy ChatGPT gateway identifiers', () => {
  test.each([4, 5])(
    'repairs V%i once without requiring OAuth reauthorization',
    (version) => {
      writeLegacy(version);
      const [provider] = runtime.getProviders();
      expect(provider.anthropicAuthToken).toMatch(/^[a-f0-9]{64}$/);
      expect(provider.codexOAuthCredentials).toEqual(credentials);
      expect(provider.customEnv).toEqual({ CODEX_REASONING_EFFORT: 'high' });
      expect(provider.updatedAt).toBe(credentials.updatedAt);
      const saved = fs.readFileSync(configFile, 'utf8');
      expect(JSON.parse(saved).version).toBe(5);
      expect(JSON.parse(saved).balancing.strategy).toBe('failover');
      expect(saved).not.toContain(provider.anthropicAuthToken);
      expect(saved).not.toContain(credentials.accessToken);
      expect(runtime.getProviders()[0]).toEqual(provider);
      expect(fs.readFileSync(configFile, 'utf8')).toBe(saved);
    },
  );

  test('keeps existing identifiers and third-party credentials unchanged', () => {
    writeLegacy(5, [
      legacyProvider('codex', 'existing-identifier'),
      legacyProvider('relay', '', false),
    ]);
    const saved = fs.readFileSync(configFile, 'utf8');
    expect(runtime.getProviders().map((p) => p.anthropicAuthToken)).toEqual([
      'existing-identifier',
      '',
    ]);
    expect(fs.readFileSync(configFile, 'utf8')).toBe(saved);
  });

  test('allocates different identifiers to disabled and enabled legacy subscriptions', () => {
    writeLegacy(5, [
      legacyProvider('one'),
      { ...legacyProvider('two'), enabled: false },
    ]);
    const providers = runtime.getProviders();
    expect(providers[0].anthropicAuthToken).toMatch(/^[a-f0-9]{64}$/);
    expect(providers[1].anthropicAuthToken).toMatch(/^[a-f0-9]{64}$/);
    expect(providers[0].anthropicAuthToken).not.toBe(
      providers[1].anthropicAuthToken,
    );
    expect(providers[1].enabled).toBe(false);
  });

  test.each(['host', 'container'] as const)(
    'issues a revocable %s runner grant after migration',
    (mode) => {
      writeLegacy(5);
      const provider = runtime.getProviders()[0];
      const { config } = runtime.resolveProviderById(provider.id);
      const lease = new gateway.CodexGatewayRunnerLease({
        kind: mode,
        groupFolder: 'fixture',
      });
      try {
        const launch = gateway.resolveCodexGatewayLaunchConfig(
          config,
          mode,
          lease,
        );
        expect(
          gateway.resolveCodexGatewayToken(launch.anthropicAuthToken)
            ?.providerId,
        ).toBe(provider.id);
        expect(
          gateway.resolveCodexGatewayToken(provider.anthropicAuthToken),
        ).toBeNull();
        lease.revoke();
        expect(
          gateway.resolveCodexGatewayToken(launch.anthropicAuthToken),
        ).toBeNull();
      } finally {
        lease.revoke();
      }
    },
  );

  test('persists an identifier when creating a subscription without one', () => {
    const provider = runtime.createProvider({
      name: 'Imported subscription',
      type: 'third_party',
      anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
      codexOAuthCredentials: credentials,
    });
    expect(provider.anthropicAuthToken).toMatch(/^[a-f0-9]{64}$/);
    expect(runtime.getProviders()[0].anthropicAuthToken).toBe(
      provider.anthropicAuthToken,
    );
  });
});
