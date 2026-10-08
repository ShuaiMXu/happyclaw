const SAFE_DOCKER_NETWORK_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const UNSAFE_DOCKER_NETWORKS = new Set(['bridge', 'default', 'host', 'none']);

export function isExternalCapabilityReleaseEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.EXTERNAL_CAPABILITY_RELEASE_ENABLED === 'true';
}

/**
 * External executions must use a pre-created, infrastructure-owned network
 * whose egress policy has been reviewed. The default bridge and host network
 * are deliberately rejected because they provide no capability-specific
 * boundary.
 */
export function getExternalCapabilityDockerNetwork(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = env.EXTERNAL_CAPABILITY_DOCKER_NETWORK?.trim() ?? '';
  if (
    !SAFE_DOCKER_NETWORK_RE.test(value) ||
    UNSAFE_DOCKER_NETWORKS.has(value.toLowerCase())
  ) {
    return null;
  }
  return value;
}
