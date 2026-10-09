import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';

export interface ExternalRestrictedSdkPolicy {
  restricted: boolean;
  allowedTools: string[];
  tools: string[] | undefined;
  settingSources: [] | undefined;
  skills: string[] | undefined;
  mcpServers: Record<string, never> | undefined;
  allowPlugins: boolean;
  requiresStartAuthorization: boolean;
}

/**
 * External capability calls are host-owned transformations of untrusted data.
 * Keep the SDK capability decision in one pure, testable place so every query
 * path (including continuations) receives the same deny-all policy.
 */
export function resolveExternalRestrictedSdkPolicy(
  input: {
    externalRestrictedExecution?: boolean;
    allowedTools?: string[];
  },
  defaultAllowedTools: readonly string[],
): ExternalRestrictedSdkPolicy {
  if (input.externalRestrictedExecution === true) {
    return {
      restricted: true,
      allowedTools: [],
      tools: [],
      settingSources: [],
      skills: [],
      mcpServers: {},
      allowPlugins: false,
      requiresStartAuthorization: true,
    };
  }

  return {
    restricted: false,
    allowedTools: input.allowedTools ?? [...defaultAllowedTools],
    tools: undefined,
    settingSources: undefined,
    skills: undefined,
    mcpServers: undefined,
    allowPlugins: true,
    requiresStartAuthorization: false,
  };
}

function isEmptyArray(value: unknown): value is [] {
  return Array.isArray(value) && value.length === 0;
}

function isEmptyRecord(value: unknown): value is Record<string, never> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

export const EXTERNAL_RESTRICTED_CAN_USE_TOOL: CanUseTool = async (
  toolName,
) => ({
  behavior: 'deny',
  message: `Tool ${toolName} is disabled for external capability execution.`,
});

/**
 * Every property in the final SDK options object must be explicitly audited.
 * Adding an option to the normal runner path cannot silently add a new external
 * capability: the external query fails before START until this list is updated.
 */
const EXTERNAL_RESTRICTED_SDK_OPTION_KEYS = new Set([
  'pathToClaudeCodeExecutable',
  'model',
  'cwd',
  'systemPrompt',
  'allowedTools',
  'tools',
  'thinking',
  'effort',
  'maxTurns',
  'maxBudgetUsd',
  'permissionMode',
  'permissionPrompts',
  'canUseTool',
  'settingSources',
  'skills',
  'includePartialMessages',
  'mcpServers',
  'strictMcpConfig',
  'persistSession',
  'verbatimPrompts',
]);

/** Fail closed if the exact options passed to SDK query() regain capabilities. */
export function assertExternalRestrictedSdkOptions(
  options: Record<string, unknown>,
  limits: { maxTurns: number; maxBudgetUsd: number },
): void {
  const validLimits =
    Number.isSafeInteger(limits.maxTurns) &&
    limits.maxTurns > 0 &&
    Number.isFinite(limits.maxBudgetUsd) &&
    limits.maxBudgetUsd > 0;
  const hasOnlyAuditedKeys = Reflect.ownKeys(options).every(
    (key) =>
      typeof key === 'string' && EXTERNAL_RESTRICTED_SDK_OPTION_KEYS.has(key),
  );

  if (
    !validLimits ||
    !hasOnlyAuditedKeys ||
    !isEmptyArray(options.allowedTools) ||
    !isEmptyArray(options.tools) ||
    !isEmptyArray(options.settingSources) ||
    !isEmptyArray(options.skills) ||
    !isEmptyRecord(options.mcpServers) ||
    options.strictMcpConfig !== true ||
    options.permissionMode !== 'dontAsk' ||
    options.permissionPrompts !== 'none' ||
    options.canUseTool !== EXTERNAL_RESTRICTED_CAN_USE_TOOL ||
    options.persistSession !== false ||
    options.verbatimPrompts !== true ||
    options.maxTurns !== limits.maxTurns ||
    options.maxBudgetUsd !== limits.maxBudgetUsd
  ) {
    throw new Error('External restricted SDK options are not fail-closed');
  }
}
