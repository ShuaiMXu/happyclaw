import { describe, expect, test } from 'vitest';

import {
  buildClaudeAuthorizeUrl,
  buildClaudeCodeExchangeBody,
  ClaudeCredentialInputError,
  classifyClaudeRefreshFailure,
  claudeOAuthRefreshScopes,
  claudeOAuthStateMatches,
  extractClaudeOAuthAccount,
  parseClaudeCallbackInput,
  parseClaudeCredentialInput,
  parseClaudeOAuthProfile,
  parseRetryAfterMs,
} from '../src/claude-oauth.js';

describe('Claude OAuth authorize URL', () => {
  test('matches the bundled CLI parameter order with a single code=true', () => {
    const url = buildClaudeAuthorizeUrl({
      codeChallenge: 'challenge-value',
      state: 'state-value',
      profile: 'full',
    });
    expect(url).toBe(
      'https://claude.com/cai/oauth/authorize?code=true' +
        '&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e' +
        '&response_type=code' +
        '&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback' +
        '&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload+user%3Aplugins' +
        '&code_challenge=challenge-value' +
        '&code_challenge_method=S256' +
        '&state=state-value',
    );
    expect(url.match(/code=true/g)).toHaveLength(1);
  });

  test('asks a setup-token login for inference only', () => {
    const url = new URL(
      buildClaudeAuthorizeUrl({
        codeChallenge: 'c',
        state: 's',
        profile: 'setup_token',
      }),
    );
    expect(url.searchParams.get('scope')).toBe('user:inference');
  });
});

describe('Claude OAuth callback input', () => {
  test('accepts a bare code, code#state and a callback page URL', () => {
    expect(parseClaudeCallbackInput('  raw-code \n')).toEqual({
      code: 'raw-code',
      state: null,
    });
    expect(parseClaudeCallbackInput('the-code#the-state')).toEqual({
      code: 'the-code',
      state: 'the-state',
    });
    expect(
      parseClaudeCallbackInput(
        'https://platform.claude.com/oauth/code/callback?code=url-code&state=url-state',
      ),
    ).toEqual({ code: 'url-code', state: 'url-state' });
    expect(
      parseClaudeCallbackInput(
        'https://console.anthropic.com/oauth/code/callback?code=legacy-code&state=legacy-state',
      ),
    ).toEqual({ code: 'legacy-code', state: 'legacy-state' });
    expect(
      parseClaudeCallbackInput('code=query-code&state=query-state'),
    ).toEqual({ code: 'query-code', state: 'query-state' });
  });

  test('rejects empty input and URLs from any other page', () => {
    expect(parseClaudeCallbackInput('   ')).toBeNull();
    expect(
      parseClaudeCallbackInput(
        'https://evil.example/oauth/code/callback?code=stolen&state=s',
      ),
    ).toBeNull();
    expect(parseClaudeCallbackInput('#only-state')).toBeNull();
  });

  test('compares states without leaking a length or prefix match', () => {
    expect(claudeOAuthStateMatches('abc123', 'abc123')).toBe(true);
    expect(claudeOAuthStateMatches('abc123', 'abc124')).toBe(false);
    expect(claudeOAuthStateMatches('abc123', 'abc')).toBe(false);
  });
});

describe('Claude OAuth token bodies', () => {
  test('sends expires_in only for a setup-token exchange, in CLI field order', () => {
    const full = buildClaudeCodeExchangeBody({
      code: 'code',
      codeVerifier: 'verifier',
      state: 'state',
      profile: 'full',
    });
    expect(Object.keys(full)).toEqual([
      'grant_type',
      'code',
      'redirect_uri',
      'client_id',
      'code_verifier',
      'state',
    ]);
    expect(full.redirect_uri).toBe(
      'https://platform.claude.com/oauth/code/callback',
    );
    expect(
      buildClaudeCodeExchangeBody({
        code: 'code',
        codeVerifier: 'verifier',
        state: 'state',
        profile: 'setup_token',
      }).expires_in,
    ).toBe(31_536_000);
  });

  test('rebuilds a claude.ai refresh scope and keeps the stored one as fallback', () => {
    expect(
      claudeOAuthRefreshScopes({
        scopes: [
          'org:create_api_key',
          'user:inference',
          'user:profile',
          'user:projects:read',
        ],
      }),
    ).toEqual({
      scope:
        'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins user:projects:read',
      fallbackScope:
        'org:create_api_key user:inference user:profile user:projects:read',
    });
    expect(claudeOAuthRefreshScopes({ scopes: ['custom:scope'] })).toEqual({
      scope: 'custom:scope',
      fallbackScope: null,
    });
  });

  test('treats invalid_grant and 400/401 as terminal, the rest as transient', () => {
    expect(
      classifyClaudeRefreshFailure(400, '{"error":"invalid_grant"}'),
    ).toMatchObject({ terminal: true, kind: 'invalid_grant' });
    expect(
      classifyClaudeRefreshFailure(401, '{"error":{"type":"invalid_client"}}'),
    ).toMatchObject({
      terminal: true,
      kind: 'rejected',
      code: 'invalid_client',
    });
    expect(classifyClaudeRefreshFailure(429, '')).toMatchObject({
      terminal: false,
    });
    expect(classifyClaudeRefreshFailure(503, '<html>')).toMatchObject({
      terminal: false,
    });
  });

  test('reads Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000);
    expect(
      parseRetryAfterMs(
        'Wed, 02 Sep 2026 08:01:00 GMT',
        Date.parse('2026-09-02T08:00:00Z'),
      ),
    ).toBe(60_000);
    expect(parseRetryAfterMs(null)).toBeNull();
  });
});

describe('Claude OAuth identity', () => {
  test('lifts account and organization from a token response', () => {
    expect(
      extractClaudeOAuthAccount({
        access_token: 'ignored',
        account: { uuid: 'acct-1', email_address: 'user@example.com' },
        organization: { uuid: 'org-1', name: 'Example Org' },
      }),
    ).toEqual({
      accountUuid: 'acct-1',
      emailAddress: 'user@example.com',
      organizationUuid: 'org-1',
      organizationName: 'Example Org',
    });
    expect(extractClaudeOAuthAccount({ access_token: 'x' })).toBeNull();
  });

  test('maps the profile organization type to a subscription type', () => {
    expect(
      parseClaudeOAuthProfile({
        account: { uuid: 'acct-2', email: 'max@example.com' },
        organization: {
          uuid: 'org-2',
          name: 'Max Org',
          organization_type: 'claude_max',
        },
      }),
    ).toEqual({
      accountUuid: 'acct-2',
      emailAddress: 'max@example.com',
      organizationUuid: 'org-2',
      organizationName: 'Max Org',
      subscriptionType: 'max',
    });
  });
});

describe('Claude credential paste parser', () => {
  const file = (claudeAiOauth: Record<string, unknown>) =>
    JSON.stringify({ claudeAiOauth, mcpOAuth: { other: true } });

  test('parses a .credentials.json and keeps subscriptionType', () => {
    expect(
      parseClaudeCredentialInput(
        file({
          accessToken: 'sk-ant-oat01-access',
          refreshToken: 'sk-ant-ort01-refresh',
          expiresAt: 1_800_000_000_000,
          scopes: ['user:inference', 'user:profile'],
          subscriptionType: 'max',
        }),
      ),
    ).toEqual({
      kind: 'oauth',
      credentials: {
        accessToken: 'sk-ant-oat01-access',
        refreshToken: 'sk-ant-ort01-refresh',
        expiresAt: 1_800_000_000_000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
      },
    });
  });

  test.each([
    ['epoch milliseconds', 1_800_000_000_000, 1_800_000_000_000],
    ['epoch seconds', 1_800_000_000, 1_800_000_000_000],
    ['numeric millisecond string', '1800000000000', 1_800_000_000_000],
    ['numeric second string', '1800000000', 1_800_000_000_000],
    [
      'ISO string',
      '2027-01-15T08:00:00.000Z',
      Date.parse('2027-01-15T08:00:00Z'),
    ],
    ['missing value', undefined, 0],
  ])('normalizes expiresAt given as %s', (_label, expiresAt, expected) => {
    const parsed = parseClaudeCredentialInput(
      file({ accessToken: 'a', refreshToken: 'r', expiresAt }),
    );
    expect(parsed.kind === 'oauth' && parsed.credentials.expiresAt).toBe(
      expected,
    );
  });

  test('accepts a bare claudeAiOauth object and space-delimited scopes', () => {
    expect(
      parseClaudeCredentialInput(
        JSON.stringify({
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: 1_800_000_000_000,
          scopes: 'user:inference user:profile',
        }),
      ),
    ).toMatchObject({
      kind: 'oauth',
      credentials: { scopes: ['user:inference', 'user:profile'] },
    });
  });

  test('turns a bare token into a setup-token', () => {
    expect(parseClaudeCredentialInput('  sk-ant-oat01-abcdef \n')).toEqual({
      kind: 'setup_token',
      token: 'sk-ant-oat01-abcdef',
    });
    expect(parseClaudeCredentialInput('"sk-ant-oat01-quoted"')).toEqual({
      kind: 'setup_token',
      token: 'sk-ant-oat01-quoted',
    });
  });

  test.each([
    ['broken JSON', '{"claudeAiOauth": {', '不是有效的 JSON'],
    [
      'JSON without a refresh token',
      file({ accessToken: 'a', expiresAt: 1 }),
      '缺少 claudeAiOauth.accessToken 或 refreshToken',
    ],
    ['a JSON array', '[1, 2]', '缺少'],
    [
      'an unparseable expiresAt',
      file({ accessToken: 'a', refreshToken: 'r', expiresAt: 'soon' }),
      'expiresAt',
    ],
    ['an API key', 'sk-ant-api03-key', 'API Key'],
    ['a lone refresh token', 'sk-ant-ort01-refresh', 'refresh token'],
    ['multi-line text', 'accessToken: a\nrefreshToken: r', '空白字符'],
    ['empty input', '   ', '为空'],
  ])('rejects %s with a clear message', (_label, input, message) => {
    expect(() => parseClaudeCredentialInput(input)).toThrow(
      ClaudeCredentialInputError,
    );
    expect(() => parseClaudeCredentialInput(input)).toThrow(message);
  });
});
