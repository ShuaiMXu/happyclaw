export interface ExternalRestrictedSdkPolicy {
  restricted: boolean;
  allowedTools: string[];
  skills: string[] | undefined;
  mcpServers: Record<string, never> | undefined;
  allowPlugins: boolean;
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
      skills: [],
      mcpServers: {},
      allowPlugins: false,
    };
  }

  return {
    restricted: false,
    allowedTools: input.allowedTools ?? [...defaultAllowedTools],
    skills: undefined,
    mcpServers: undefined,
    allowPlugins: true,
  };
}
