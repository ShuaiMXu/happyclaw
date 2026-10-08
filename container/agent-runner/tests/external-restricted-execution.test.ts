import { describe, expect, test } from 'vitest';

import { resolveExternalRestrictedSdkPolicy } from '../src/external-restricted-execution.js';

const DEFAULT_TOOLS = ['Bash', 'Read', 'Write'];

describe('external restricted SDK policy', () => {
  test('removes every SDK tool and extension surface for external executions', () => {
    const policy = resolveExternalRestrictedSdkPolicy(
      {
        externalRestrictedExecution: true,
        allowedTools: ['Bash'],
      },
      DEFAULT_TOOLS,
    );

    expect(policy).toEqual({
      restricted: true,
      allowedTools: [],
      tools: [],
      settingSources: [],
      skills: [],
      mcpServers: {},
      allowPlugins: false,
    });
  });

  test('preserves an explicit regular-workspace tool policy', () => {
    const policy = resolveExternalRestrictedSdkPolicy(
      { allowedTools: ['Read'] },
      DEFAULT_TOOLS,
    );

    expect(policy).toEqual({
      restricted: false,
      allowedTools: ['Read'],
      tools: undefined,
      settingSources: undefined,
      skills: undefined,
      mcpServers: undefined,
      allowPlugins: true,
    });
  });

  test('preserves the normal default tools when no explicit policy exists', () => {
    const policy = resolveExternalRestrictedSdkPolicy({}, DEFAULT_TOOLS);

    expect(policy.allowedTools).toEqual(DEFAULT_TOOLS);
    expect(policy.allowedTools).not.toBe(DEFAULT_TOOLS);
    expect(policy.restricted).toBe(false);
  });
});
