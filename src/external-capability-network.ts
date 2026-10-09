import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const NETWORK_INSPECT_TIMEOUT_MS = 5_000;
const NETWORK_INSPECT_MAX_BYTES = 1024 * 1024;
const EXTERNAL_EGRESS_LABEL = 'com.happyclaw.external-capability-egress';
const EGRESS_POLICY_LABEL = 'com.happyclaw.egress-policy';

type DockerNetworkInspect = {
  Name?: unknown;
  Scope?: unknown;
  Driver?: unknown;
  Internal?: unknown;
  Ingress?: unknown;
  ConfigOnly?: unknown;
  EnableIPv6?: unknown;
  Labels?: unknown;
  Options?: unknown;
};

type NetworkInspectExecutor = (networkName: string) => Promise<string>;

const execFileAsync = promisify(execFile);

async function inspectDockerNetwork(networkName: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'docker',
    ['network', 'inspect', networkName],
    {
      encoding: 'utf8',
      timeout: NETWORK_INSPECT_TIMEOUT_MS,
      maxBuffer: NETWORK_INSPECT_MAX_BYTES,
    },
  );
  return stdout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Verify the infrastructure-owned network before activation or dispatch.
 * `Internal=true` prevents direct Internet access; the provider must be reached
 * through an approved proxy attached to this network. Labels are an explicit
 * operator attestation and do not replace the real egress sentinel release test.
 */
export async function probeExternalCapabilityDockerNetwork(
  networkName: string,
  inspect: NetworkInspectExecutor = inspectDockerNetwork,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await inspect(networkName));
  } catch {
    throw new Error(
      'External capability Docker network could not be inspected',
    );
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new Error('External capability Docker network inspect was invalid');
  }

  const network = parsed[0] as DockerNetworkInspect;
  const labels = isRecord(network.Labels) ? network.Labels : {};
  const options = isRecord(network.Options) ? network.Options : {};
  const ipv4GatewayIsolated =
    options['com.docker.network.bridge.gateway_mode_ipv4'] === 'isolated';
  const ipv6GatewayIsolated =
    network.EnableIPv6 !== true ||
    options['com.docker.network.bridge.gateway_mode_ipv6'] === 'isolated';
  if (
    network.Name !== networkName ||
    network.Scope !== 'local' ||
    network.Driver !== 'bridge' ||
    network.Internal !== true ||
    network.Ingress !== false ||
    network.ConfigOnly !== false ||
    !ipv4GatewayIsolated ||
    !ipv6GatewayIsolated ||
    labels[EXTERNAL_EGRESS_LABEL] !== 'true' ||
    labels[EGRESS_POLICY_LABEL] !== 'provider-only'
  ) {
    throw new Error(
      'External capability Docker network does not satisfy the isolation policy',
    );
  }
}
