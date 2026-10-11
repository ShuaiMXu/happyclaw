import { describe, expect, test } from 'vitest';

import {
  parseProviderEnvImport,
  splitShellWords,
} from '../web/src/utils/provider-env-import.js';
import { describeBaseUrlProblem } from '../web/src/utils/provider-presets.js';

const KIMI_ALIAS = `alias kcc="CLAUDE_CODE_NO_FLICKER=1 CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000 ANTHROPIC_BASE_URL=https://api.kimi.com/coding/ ANTHROPIC_AUTH_TOKEN=sk-kimi-fake API_TIMEOUT_MS=3000000 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 ANTHROPIC_MODEL=kimi-for-coding[1m] ANTHROPIC_DEFAULT_OPUS_MODEL=kimi-for-coding[1m] ANTHROPIC_DEFAULT_SONNET_MODEL=kimi-for-coding[1m] ANTHROPIC_DEFAULT_HAIKU_MODEL=kimi-for-coding[1m] CLAUDE_CODE_SUBAGENT_MODEL=kimi-for-coding[1m] CLAUDE_CODE_EFFORT_LEVEL=max claude --teammate-mode in-process --dangerously-skip-permissions"`;

describe('parseProviderEnvImport', () => {
  test('an alias that matches the defaults imports as plain fields', () => {
    const result = parseProviderEnvImport(KIMI_ALIAS);
    expect(result).toMatchObject({
      name: 'kcc',
      baseUrl: 'https://api.kimi.com/coding/',
      token: 'sk-kimi-fake',
      authMode: 'bearer',
      model: 'kimi-for-coding',
      oneMillionContext: true,
      envOverrides: {},
      customEnv: {},
      rejected: [],
    });
    expect(result.warnings[0]).toContain('--teammate-mode');
  });

  test('keeps only the values that differ from the computed defaults', () => {
    const result = parseProviderEnvImport(
      `alias dcc="CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432 ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic ANTHROPIC_AUTH_TOKEN=sk-fake ANTHROPIC_MODEL=deepseek-v4-pro[1m] ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash[1m] CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-pro[1m] CLAUDE_CODE_EFFORT_LEVEL=max claude"`,
    );
    expect(result.envOverrides).toEqual({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash[1m]',
    });
  });

  test('single-quoted tokens with URL syntax survive intact', () => {
    const result = parseProviderEnvImport(
      `alias g="ANTHROPIC_BASE_URL=https://gw.test/anthropic ANTHROPIC_AUTH_TOKEN='aigateway://gateway/x?auth_type=secret&secret_id=a&secret_key=b' ANTHROPIC_CUSTOM_HEADERS='X-Upstream-Format: responses' ANTHROPIC_MODEL=GPT-5.6-Sol claude"`,
    );
    expect(result.token).toBe(
      'aigateway://gateway/x?auth_type=secret&secret_id=a&secret_key=b',
    );
    expect(result.customEnv).toEqual({
      ANTHROPIC_CUSTOM_HEADERS: 'X-Upstream-Format: responses',
    });
    expect(result.oneMillionContext).toBe(false);
  });

  test('a relay without a model and proxy prefixes are reported, not applied', () => {
    const result = parseProviderEnvImport(
      `alias mycc='HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 ANTHROPIC_BASE_URL=https://relay.test ANTHROPIC_AUTH_TOKEN=tok claude'`,
    );
    expect(result.model).toBeNull();
    expect(result.proxyEnv).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
    });
    expect(result.customEnv).toEqual({});
    expect(result.warnings.join('\n')).toContain('代理变量未导入');
  });

  test('export lines, comments and continuations', () => {
    const result = parseProviderEnvImport(
      [
        '# GLM',
        'export ANTHROPIC_BASE_URL="https://open.bigmodel.cn/api/anthropic"',
        'export ANTHROPIC_API_KEY=glm-fake \\',
        '  ANTHROPIC_MODEL=glm-5.3',
        'export CLAUDE_CODE_MAX_CONTEXT_TOKENS=500000',
      ].join('\n'),
    );
    expect(result).toMatchObject({
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      token: 'glm-fake',
      authMode: 'x-api-key',
      model: 'glm-5.3',
      customEnv: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '500000' },
    });
  });

  test('settings.json env blocks and the deprecated small-fast model', () => {
    const result = parseProviderEnvImport(
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'mm-fake',
          ANTHROPIC_MODEL: 'MiniMax-M3',
          ANTHROPIC_SMALL_FAST_MODEL: 'MiniMax-M3-mini',
          API_TIMEOUT_MS: 3000000,
        },
      }),
    );
    expect(result).toMatchObject({
      token: 'mm-fake',
      model: 'MiniMax-M3',
      envOverrides: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3-mini' },
    });
  });

  test('refuses expansions, dangerous keys and official tokens', () => {
    const result = parseProviderEnvImport(
      'ANTHROPIC_AUTH_TOKEN=$KIMI_KEY PATH=/tmp CLAUDE_CODE_OAUTH_TOKEN=x ANTHROPIC_BASE_URL=https://a.test claude',
    );
    expect(result.token).toBeNull();
    expect(result.rejected.map((item) => item.key)).toEqual([
      'ANTHROPIC_AUTH_TOKEN',
      'PATH',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]);
  });

  test('--model is used when the env sets no model', () => {
    expect(
      parseProviderEnvImport(
        'ANTHROPIC_BASE_URL=https://a.test ANTHROPIC_AUTH_TOKEN=t claude --model glm-5.3[1m]',
      ),
    ).toMatchObject({ model: 'glm-5.3', oneMillionContext: true });
  });

  test('empty input explains what to paste', () => {
    expect(parseProviderEnvImport('claude').warnings[0]).toContain(
      'ANTHROPIC_BASE_URL',
    );
  });
});

describe('splitShellWords', () => {
  test('follows POSIX quoting including the close-reopen idiom', () => {
    expect(
      splitShellWords(`a='it'"'"'s' "x\\"y" b\\ c`)[0].map((w) => w.text),
    ).toEqual(["a=it's", 'x"y', 'b c']);
  });
});

describe('describeBaseUrlProblem', () => {
  test('flags endpoints that would double the API path', () => {
    expect(describeBaseUrlProblem('https://relay.test/v1')).toContain('/v1');
    expect(describeBaseUrlProblem('https://relay.test/v1/messages/')).toContain(
      '/v1',
    );
    expect(describeBaseUrlProblem('https://api.kimi.com/coding/')).toBeNull();
    expect(describeBaseUrlProblem('api.kimi.com')).toContain('http');
  });
});
