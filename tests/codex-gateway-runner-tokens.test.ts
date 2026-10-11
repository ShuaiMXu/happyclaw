import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  logger: { warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../src/runtime-config.js', () => ({
  getProviders: mocks.getProviders,
  updateProviderCodexOAuthCredentialsIfCurrent: vi.fn(),
  setProviderCodexOAuthRefreshErrorIfCurrent: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({ logger: mocks.logger }));

import {
  CodexGatewayRunnerLease,
  applyCodexGatewayNoProxy,
  countCodexGatewayTokens,
  issueCodexGatewayToken,
  resolveCodexGatewayLaunchConfig,
  resolveCodexGatewayToken,
  revokeCodexGatewayToken,
} from '../src/codex-gateway/runner-tokens.js';
import {
  isLocalNetworkAddress,
  rejectNonLocalGatewaySource,
} from '../src/codex-gateway/source-guard.js';
import { CODEX_GATEWAY_BASE_URL_PLACEHOLDER } from '../src/codex-gateway/types.js';

const codexProvider = {
  id: 'codex-provider',
  anthropicAuthToken: 'stored-identifier',
  codexOAuthCredentials: { accessToken: 'upstream' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviders.mockReturnValue([codexProvider]);
});

describe('runner gateway tokens', () => {
  test('issue, resolve and revoke a random per-runner token', () => {
    const before = countCodexGatewayTokens();
    const first = issueCodexGatewayToken('provider', {
      kind: 'container',
      groupFolder: 'folder',
      agentId: 'agent',
      agentEffort: 'high',
    });
    const second = issueCodexGatewayToken('provider', { kind: 'host' });
    expect(first.token).toMatch(/^hcgw_[A-Za-z0-9_-]{43}$/);
    expect(first.token).not.toBe(second.token);
    expect(resolveCodexGatewayToken(first.token)).toMatchObject({
      providerId: 'provider',
      owner: { groupFolder: 'folder', agentId: 'agent', agentEffort: 'high' },
    });
    expect(countCodexGatewayTokens()).toBe(before + 2);
    revokeCodexGatewayToken(first.token);
    expect(resolveCodexGatewayToken(first.token)).toBeNull();
    expect(resolveCodexGatewayToken(second.token)).not.toBeNull();
    revokeCodexGatewayToken(second.token);
    expect(countCodexGatewayTokens()).toBe(before);
  });

  test.each(['', 'stored-identifier', 'hcgw_short', `hcgw_${'a'.repeat(43)}`])(
    'rejects unknown or malformed token %j',
    (token) => {
      expect(resolveCodexGatewayToken(token)).toBeNull();
    },
  );

  test('a lease revokes every token it issued and reports the latest verdict', () => {
    const lease = new CodexGatewayRunnerLease({ kind: 'host' });
    const a = lease.issue('provider');
    const b = lease.issue('provider');
    expect(lease.lastVerdict).toBeNull();
    resolveCodexGatewayToken(a)!.lastVerdict = 'local_transient';
    expect(lease.lastVerdict).toBe('local_transient');
    resolveCodexGatewayToken(b)!.lastVerdict = 'ok';
    expect(lease.lastVerdict).toBe('ok');
    lease.revoke();
    expect(resolveCodexGatewayToken(a)).toBeNull();
    expect(resolveCodexGatewayToken(b)).toBeNull();
    expect(() => lease.issue('provider')).toThrow();
  });
});

describe('resolveCodexGatewayLaunchConfig', () => {
  test('replaces the placeholder URL and stored identifier with a runner token', () => {
    const lease = new CodexGatewayRunnerLease({ kind: 'container' });
    const resolved = resolveCodexGatewayLaunchConfig(
      {
        anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
        anthropicAuthToken: 'stored-identifier',
        anthropicModel: 'gpt-6-sol',
      },
      'container',
      lease,
    );
    expect(resolved.anthropicBaseUrl).toMatch(
      /^http:\/\/host\.docker\.internal:\d+\/gateway\/chatgpt$/,
    );
    expect(resolved.anthropicAuthToken).toMatch(/^hcgw_/);
    expect(resolved.anthropicModel).toBe('gpt-6-sol');
    expect(
      resolveCodexGatewayToken(resolved.anthropicAuthToken)?.providerId,
    ).toBe('codex-provider');
    lease.revoke();
    expect(resolveCodexGatewayToken(resolved.anthropicAuthToken)).toBeNull();
  });

  test('host mode uses loopback', () => {
    const lease = new CodexGatewayRunnerLease({ kind: 'host' });
    const resolved = resolveCodexGatewayLaunchConfig(
      {
        anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
        anthropicAuthToken: 'stored-identifier',
      },
      'host',
      lease,
    );
    expect(resolved.anthropicBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    lease.revoke();
  });

  test('other providers pass through untouched and mint nothing', () => {
    const lease = new CodexGatewayRunnerLease({ kind: 'host' });
    const config = {
      anthropicBaseUrl: 'https://api.example.test',
      anthropicAuthToken: 'third-party-key',
    };
    const before = countCodexGatewayTokens();
    expect(resolveCodexGatewayLaunchConfig(config, 'host', lease)).toBe(config);
    expect(countCodexGatewayTokens()).toBe(before);
  });

  test('an unknown identifier never forwards the stored value', () => {
    const lease = new CodexGatewayRunnerLease({ kind: 'host' });
    const resolved = resolveCodexGatewayLaunchConfig(
      {
        anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
        anthropicAuthToken: 'unknown-identifier',
      },
      'host',
      lease,
    );
    expect(resolved.anthropicAuthToken).toBe('');
    expect(mocks.logger.warn).toHaveBeenCalled();
  });

  test('merges the gateway host into both NO_PROXY spellings once', () => {
    const empty: Record<string, string | undefined> = {};
    applyCodexGatewayNoProxy(empty, 'host');
    expect(empty).toEqual({ NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' });
    const configured: Record<string, string | undefined> = {
      no_proxy: 'localhost, .corp',
    };
    applyCodexGatewayNoProxy(configured, 'container');
    expect(configured).toEqual({
      NO_PROXY: 'localhost,.corp,host.docker.internal',
      no_proxy: 'localhost,.corp,host.docker.internal',
    });
    applyCodexGatewayNoProxy(configured, 'container');
    expect(configured.NO_PROXY).toBe('localhost,.corp,host.docker.internal');
  });
});

describe('gateway source guard', () => {
  test.each([
    '127.0.0.1',
    '127.8.9.10',
    '::1',
    '::ffff:127.0.0.1',
    '10.0.2.100',
    '172.17.0.2',
    '172.31.255.1',
    '192.168.65.1',
    '100.64.0.5',
    '169.254.1.1',
    'fd12:3456::1',
    'fe80::1%eth0',
  ])('accepts local address %s', (address) => {
    expect(isLocalNetworkAddress(address)).toBe(true);
  });

  test.each([
    '8.8.8.8',
    '172.32.0.1',
    '192.169.0.1',
    '100.128.0.1',
    '::ffff:8.8.8.8',
    '2001:db8::1',
    'not-an-ip',
    '',
    undefined,
  ])('rejects non-local address %s', (address) => {
    expect(isLocalNetworkAddress(address)).toBe(false);
  });

  test('reverse-proxy headers are refused even from loopback', () => {
    for (const header of [
      'x-forwarded-for',
      'forwarded',
      'x-real-ip',
      'x-forwarded-host',
      'x-forwarded-proto',
    ]) {
      expect(
        rejectNonLocalGatewaySource(
          new Headers({ [header]: 'value' }),
          '127.0.0.1',
        ),
      ).toContain('proxied');
    }
    expect(rejectNonLocalGatewaySource(new Headers(), '127.0.0.1')).toBeNull();
  });
});
