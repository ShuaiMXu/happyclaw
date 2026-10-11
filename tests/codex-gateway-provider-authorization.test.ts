import { describe, expect, test } from 'vitest';

import {
  codexAccountChanged,
  codexProviderCreationDefaults,
  extractCodexCallbackParams,
  planCodexReauthorization,
} from '../src/codex-gateway/provider-authorization.js';
import { CODEX_MODEL_CATALOG } from '../src/codex-gateway/model-catalog.js';
import {
  CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
  type CodexOAuthCredentials,
} from '../src/codex-gateway/types.js';

function credentials(
  overrides: Partial<CodexOAuthCredentials> = {},
): CodexOAuthCredentials {
  return {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: 1,
    accountId: 'account-a',
    planType: 'plus',
    email: 'a@example.invalid',
    updatedAt: 'now',
    ...overrides,
  };
}

describe('extractCodexCallbackParams', () => {
  test.each([
    'http://localhost:1455/auth/callback?code=abc&state=s1',
    'http://127.0.0.1:1455/auth/callback?code=abc&state=s1',
    '?code=abc&state=s1',
    'code=abc&state=s1',
  ])('reads code and state from %s', (input) => {
    expect(extractCodexCallbackParams(input)).toEqual({
      kind: 'code',
      code: 'abc',
      state: 's1',
    });
  });

  test('accepts a bare authorization code', () => {
    expect(extractCodexCallbackParams('  bare-code ')).toEqual({
      kind: 'code',
      code: 'bare-code',
      state: null,
    });
  });

  test('surfaces an authorization error from the callback', () => {
    expect(
      extractCodexCallbackParams(
        'http://localhost:1455/auth/callback?error=access_denied&error_description=User%20cancelled%0Alogin&state=s1',
      ),
    ).toEqual({
      kind: 'error',
      error: 'access_denied',
      description: 'User cancelled login',
      state: 's1',
    });
  });

  test.each([
    'https://evil.example/auth/callback?code=abc',
    'http://localhost:9999/auth/callback?code=abc',
    'http://localhost:1455/auth/callback',
    '',
  ])('rejects %j', (input) => {
    expect(extractCodexCallbackParams(input)).toBeNull();
  });
});

describe('creation defaults', () => {
  test('write the catalog default effort so UI and runtime agree', () => {
    expect(codexProviderCreationDefaults(CODEX_MODEL_CATALOG)).toEqual({
      anthropicModel: 'gpt-6.1-sol',
      customEnv: { CODEX_REASONING_EFFORT: 'low' },
    });
  });
});

describe('codexAccountChanged', () => {
  test('compares account IDs, falling back to e-mail', () => {
    expect(codexAccountChanged(credentials(), credentials())).toBe(false);
    expect(
      codexAccountChanged(credentials(), credentials({ accountId: 'b' })),
    ).toBe(true);
    expect(
      codexAccountChanged(
        credentials({ accountId: null }),
        credentials({ accountId: null }),
      ),
    ).toBe(false);
    expect(
      codexAccountChanged(
        credentials({ accountId: null }),
        credentials({ accountId: null, email: 'b@example.invalid' }),
      ),
    ).toBe(true);
    expect(
      codexAccountChanged(
        credentials({ accountId: null, email: null }),
        credentials({ accountId: null, email: null }),
      ),
    ).toBe(true);
    expect(codexAccountChanged(null, credentials())).toBe(true);
  });
});

describe('planCodexReauthorization', () => {
  const codexProvider = {
    anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
    anthropicAuthToken: 'identifier',
    anthropicModel: 'gpt-6-luna',
    customEnv: { CODEX_REASONING_EFFORT: 'high' },
    codexOAuthCredentials: credentials(),
  };

  test('same-account re-login keeps model, effort, identifier and sessions', () => {
    expect(
      planCodexReauthorization(
        codexProvider,
        credentials({ accessToken: 'new' }),
        CODEX_MODEL_CATALOG,
      ),
    ).toEqual({
      converted: false,
      accountChanged: false,
      anthropicModel: 'gpt-6-luna',
      rotateGatewayIdentifier: false,
    });
  });

  test('a different account invalidates sessions without other changes', () => {
    expect(
      planCodexReauthorization(
        codexProvider,
        credentials({ accountId: 'account-b' }),
        CODEX_MODEL_CATALOG,
      ),
    ).toMatchObject({
      converted: false,
      accountChanged: true,
      anthropicModel: 'gpt-6-luna',
      rotateGatewayIdentifier: false,
    });
  });

  test('converting a third-party provider resets a non-Codex model and writes the default effort', () => {
    expect(
      planCodexReauthorization(
        {
          anthropicBaseUrl: 'https://api.example.test',
          anthropicAuthToken: 'real-third-party-secret',
          anthropicModel: 'claude-sonnet-4-6',
          customEnv: { KEEP: '1' },
          codexOAuthCredentials: null,
        },
        credentials(),
        CODEX_MODEL_CATALOG,
      ),
    ).toEqual({
      converted: true,
      accountChanged: true,
      anthropicModel: 'gpt-6.1-sol',
      customEnv: { KEEP: '1', CODEX_REASONING_EFFORT: 'low' },
      rotateGatewayIdentifier: true,
    });
  });

  test('conversion keeps a Codex catalog model and an existing effort', () => {
    expect(
      planCodexReauthorization(
        {
          anthropicBaseUrl: 'https://proxy.example.test',
          anthropicAuthToken: 'secret',
          anthropicModel: 'gpt-6-astra',
          customEnv: { CODEX_REASONING_EFFORT: 'xhigh' },
          codexOAuthCredentials: null,
        },
        credentials(),
        CODEX_MODEL_CATALOG,
      ),
    ).toEqual({
      converted: true,
      accountChanged: true,
      anthropicModel: 'gpt-6-astra',
      rotateGatewayIdentifier: true,
    });
  });
});
