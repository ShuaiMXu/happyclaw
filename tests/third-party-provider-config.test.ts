import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'third-party-provider-'));

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
const { resolveContainerProviderBaseUrl } =
  await import('../src/container-runner.js');

type Config = import('../src/runtime-config.js').ClaudeProviderConfig;

function config(patch: Partial<Config>): Config {
  return {
    anthropicBaseUrl: 'https://example.test/anthropic',
    anthropicAuthToken: 'tok-123456',
    anthropicApiKey: '',
    claudeCodeOauthToken: '',
    claudeOAuthCredentials: null,
    anthropicModel: 'glm-5.3[1m]',
    updatedAt: null,
    ...patch,
  };
}

function envOf(lines: string[]): Record<string, string> {
  return Object.fromEntries(
    lines.map((line) => {
      const eq = line.indexOf('=');
      return [line.slice(0, eq), line.slice(eq + 1)];
    }),
  );
}

beforeEach(() => {
  fs.rmSync(path.join(root, 'config'), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('third-party auth header', () => {
  test('bearer mode sends the token like an ANTHROPIC_AUTH_TOKEN alias', () => {
    const env = envOf(
      runtimeConfig.buildClaudeEnvLines(
        config({ anthropicAuthMode: 'bearer' }),
        {},
      ),
    );
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('tok-123456');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test('x-api-key mode strips a pasted Bearer prefix', () => {
    const env = envOf(
      runtimeConfig.buildClaudeEnvLines(
        config({
          anthropicAuthMode: 'x-api-key',
          anthropicAuthToken: 'Bearer tok-123456',
        }),
        {},
      ),
    );
    expect(env.ANTHROPIC_API_KEY).toBe('tok-123456');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  test('legacy providers without a mode keep the inferred header', () => {
    expect(
      envOf(runtimeConfig.buildClaudeEnvLines(config({}), {}))
        .ANTHROPIC_API_KEY,
    ).toBe('tok-123456');
    expect(
      envOf(
        runtimeConfig.buildClaudeEnvLines(
          config({ anthropicAuthToken: 'Bearer tok-123456' }),
          {},
        ),
      ).ANTHROPIC_AUTH_TOKEN,
    ).toBe('tok-123456');
  });
});

describe('auth mode on the runner launch path', () => {
  // Runners build their env through buildContainerEnvLines, which merges the
  // workspace override first; the mode must survive that merge.
  test('the provider mode reaches the runner env', () => {
    const bearer = envOf(
      runtimeConfig.buildContainerEnvLines(
        config({ anthropicAuthMode: 'bearer' }),
        {},
        {},
      ),
    );
    expect(bearer.ANTHROPIC_AUTH_TOKEN).toBe('tok-123456');
    expect(bearer.ANTHROPIC_API_KEY).toBeUndefined();

    const apiKey = envOf(
      runtimeConfig.buildContainerEnvLines(
        config({
          anthropicAuthMode: 'x-api-key',
          anthropicAuthToken: 'Bearer tok-123456',
        }),
        {},
        {},
      ),
    );
    expect(apiKey.ANTHROPIC_API_KEY).toBe('tok-123456');
  });

  test('a workspace token keeps the legacy inference', () => {
    const env = envOf(
      runtimeConfig.buildContainerEnvLines(
        config({ anthropicAuthMode: 'bearer' }),
        { anthropicAuthToken: 'workspace-token' },
        {},
      ),
    );
    expect(env.ANTHROPIC_API_KEY).toBe('workspace-token');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });
});

describe('third-party model tiers', () => {
  test('the subagent model follows the provider model like the aliases', () => {
    const env = envOf(runtimeConfig.buildClaudeEnvLines(config({}), {}));
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('glm-5.3[1m]');
  });

  test('per-tier overrides win and a blank override means the default', () => {
    const env = envOf(
      runtimeConfig.buildClaudeEnvLines(config({}), {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash',
        CLAUDE_CODE_SUBAGENT_MODEL: '   ',
      }),
    );
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5.3-flash');
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('glm-5.3[1m]');
  });

  test('a pass-through relay without a model emits only explicit mappings', () => {
    const env = envOf(
      runtimeConfig.buildClaudeEnvLines(config({ anthropicModel: '' }), {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5',
      }),
    );
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-5-5');
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('200000');
  });

  test('a host process launched from an alias does not leak its tiers', () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_SUBAGENT_MODEL: 'kimi-for-coding[1m]',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '500000',
      ANTHROPIC_SMALL_FAST_MODEL: 'kimi',
      ANTHROPIC_BETAS: 'x',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
    };
    runtimeConfig.clearInheritedClaudeProviderEnv(env);
    expect(env).toEqual({ HTTPS_PROXY: 'http://127.0.0.1:7890' });
  });
});

describe('validateProviderCustomEnv', () => {
  test('names keys the runtime would silently drop', () => {
    expect(
      runtimeConfig.validateProviderCustomEnv({ PATH: '/x', HOME: '/y' }),
    ).toContain('PATH, HOME');
    expect(
      runtimeConfig.validateProviderCustomEnv({ ANTHROPIC_BASE_URL: 'x' }),
    ).toContain('对应字段');
  });

  test('checks numeric and effort values but accepts blanks', () => {
    expect(
      runtimeConfig.validateProviderCustomEnv({
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1e6',
      }),
    ).toContain('正整数');
    expect(
      runtimeConfig.validateProviderCustomEnv({
        CLAUDE_CODE_EFFORT_LEVEL: 'ultra',
      }),
    ).toContain('CLAUDE_CODE_EFFORT_LEVEL');
    expect(
      runtimeConfig.validateProviderCustomEnv({
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '',
        ANTHROPIC_CUSTOM_HEADERS: 'X-Upstream-Format: responses',
      }),
    ).toBeNull();
  });
});

describe('provider storage', () => {
  test('persists the auth mode and exposes it publicly', () => {
    const created = runtimeConfig.createProvider({
      name: 'Kimi',
      type: 'third_party',
      anthropicBaseUrl: 'https://api.kimi.com/coding/',
      anthropicAuthToken: 'sk-kimi-secret',
      anthropicAuthMode: 'bearer',
      anthropicModel: 'kimi-for-coding[1m]',
    });
    const reloaded = runtimeConfig.getProviderById(created.id)!;
    expect(reloaded.anthropicAuthMode).toBe('bearer');
    expect(runtimeConfig.toPublicProvider(reloaded).anthropicAuthMode).toBe(
      'bearer',
    );
    runtimeConfig.updateProvider(created.id, {
      anthropicAuthMode: 'x-api-key',
    });
    expect(runtimeConfig.getProviderById(created.id)!.anthropicAuthMode).toBe(
      'x-api-key',
    );
  });

  test('duplicates secrets disabled and right after the source', () => {
    const source = runtimeConfig.createProvider({
      name: 'G'.repeat(64),
      type: 'third_party',
      anthropicBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
      anthropicAuthToken: 'glm-secret',
      anthropicModel: 'glm-5.3',
      customEnv: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash' },
      enabled: true,
    });
    const tail = runtimeConfig.createProvider({
      name: 'Tail',
      type: 'third_party',
      anthropicBaseUrl: 'https://example.test',
      anthropicAuthToken: 'tail',
    });
    const copy = runtimeConfig.duplicateProvider(source.id);
    expect(copy.name).toHaveLength(64);
    expect(copy.name.endsWith(' (副本)')).toBe(true);
    expect(copy).toMatchObject({
      enabled: false,
      anthropicAuthToken: 'glm-secret',
      customEnv: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash' },
    });
    expect(runtimeConfig.getProviders().map((p) => p.id)).toEqual([
      source.id,
      copy.id,
      tail.id,
    ]);
  });

  test('refuses to duplicate an OAuth provider', () => {
    const oauth = runtimeConfig.createProvider({
      name: 'Claude',
      type: 'official',
      claudeOAuthCredentials: {
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: Date.now() + 3_600_000,
        scopes: [],
      },
    });
    expect(() => runtimeConfig.duplicateProvider(oauth.id)).toThrow('不能复制');
  });

  test('a provider without credentials cannot join the pool', () => {
    const empty = runtimeConfig.createProvider({
      name: 'Relay',
      type: 'third_party',
      anthropicBaseUrl: 'https://relay.test',
    });
    expect(runtimeConfig.providerHasCredentials(empty)).toBe(false);
    expect(() => runtimeConfig.setProviderEnabled(empty.id, true)).toThrow(
      '凭据',
    );
    runtimeConfig.updateProviderSecrets(empty.id, {
      anthropicAuthToken: 'now-set',
    });
    expect(runtimeConfig.setProviderEnabled(empty.id, true).enabled).toBe(true);
  });
});

describe('resolveContainerProviderBaseUrl', () => {
  test('routes a host-loopback relay through host.docker.internal', () => {
    expect(
      resolveContainerProviderBaseUrl('http://127.0.0.1:8317', 'linux'),
    ).toEqual({
      baseUrl: 'http://host.docker.internal:8317',
      addHostGateway: true,
    });
    expect(
      resolveContainerProviderBaseUrl('http://localhost:8317/api/', 'darwin'),
    ).toEqual({
      baseUrl: 'http://host.docker.internal:8317/api/',
      addHostGateway: false,
    });
  });

  test('leaves remote endpoints untouched', () => {
    expect(
      resolveContainerProviderBaseUrl('https://api.deepseek.com/anthropic'),
    ).toEqual({
      baseUrl: 'https://api.deepseek.com/anthropic',
      addHostGateway: false,
    });
  });
});
