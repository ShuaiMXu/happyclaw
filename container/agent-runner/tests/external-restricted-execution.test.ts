import { describe, expect, test } from 'vitest';

import {
  assertExternalRestrictedSdkOptions,
  EXTERNAL_RESTRICTED_CAN_USE_TOOL,
  resolveExternalRestrictedSdkPolicy,
} from '../src/external-restricted-execution.js';

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
      requiresStartAuthorization: true,
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
      requiresStartAuthorization: false,
    });
  });

  test('preserves the normal default tools when no explicit policy exists', () => {
    const policy = resolveExternalRestrictedSdkPolicy({}, DEFAULT_TOOLS);

    expect(policy.allowedTools).toEqual(DEFAULT_TOOLS);
    expect(policy.allowedTools).not.toBe(DEFAULT_TOOLS);
    expect(policy.restricted).toBe(false);
  });

  test('accepts only the exact fail-closed options passed to SDK query()', () => {
    const limits = { maxTurns: 4, maxBudgetUsd: 0.25 };
    const options: Record<string, unknown> = {
      allowedTools: [],
      tools: [],
      settingSources: [],
      skills: [],
      mcpServers: {},
      strictMcpConfig: true,
      permissionMode: 'dontAsk',
      permissionPrompts: 'none',
      canUseTool: EXTERNAL_RESTRICTED_CAN_USE_TOOL,
      persistSession: false,
      verbatimPrompts: true,
      maxTurns: limits.maxTurns,
      maxBudgetUsd: limits.maxBudgetUsd,
    };

    expect(() =>
      assertExternalRestrictedSdkOptions(options, limits),
    ).not.toThrow();

    for (const invalidLimits of [
      {} as { maxTurns: number; maxBudgetUsd: number },
      { maxTurns: 0, maxBudgetUsd: limits.maxBudgetUsd },
      { maxTurns: 1.5, maxBudgetUsd: limits.maxBudgetUsd },
      { maxTurns: limits.maxTurns, maxBudgetUsd: 0 },
      { maxTurns: limits.maxTurns, maxBudgetUsd: Number.NaN },
    ]) {
      expect(() =>
        assertExternalRestrictedSdkOptions(options, invalidLimits),
      ).toThrow(/not fail-closed/);
    }

    for (const unsafe of [
      { ...options, tools: ['Read'] },
      { ...options, allowedTools: ['Task'] },
      { ...options, settingSources: ['project'] },
      { ...options, skills: ['all'] },
      { ...options, mcpServers: { happyclaw: {} } },
      { ...options, strictMcpConfig: false },
      { ...options, plugins: [{ type: 'local', path: '/plugin' }] },
      { ...options, agents: { worker: {} } },
      { ...options, agent: 'worker' },
      { ...options, additionalDirectories: ['/workspace/group'] },
      { ...options, projectConfigRoot: '/workspace/group' },
      { ...options, toolAliases: { Read: 'mcp__unsafe__read' } },
      { ...options, hooks: { PreToolUse: [] } },
      { ...options, settings: { permissions: {} } },
      { ...options, sandbox: { enabled: false } },
      { ...options, extraArgs: { 'dangerously-skip-permissions': null } },
      { ...options, resume: 'prior-session' },
      { ...options, permissionPromptToolName: 'mcp__unsafe__approve' },
      { ...options, onElicitation: async () => ({ action: 'accept' }) },
      { ...options, permissionMode: 'bypassPermissions' },
      { ...options, permissionPrompts: 'host' },
      { ...options, allowDangerouslySkipPermissions: true },
      { ...options, canUseTool: async () => ({ behavior: 'allow' }) },
      { ...options, persistSession: true },
      { ...options, verbatimPrompts: false },
      { ...options, maxTurns: limits.maxTurns + 1 },
      { ...options, maxBudgetUsd: limits.maxBudgetUsd + 1 },
    ]) {
      expect(() => assertExternalRestrictedSdkOptions(unsafe, limits)).toThrow(
        /not fail-closed/,
      );
    }
  });
});
