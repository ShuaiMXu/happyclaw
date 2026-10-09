import { describe, expect, test } from 'vitest';

import { probeExternalCapabilityDockerNetwork } from '../src/external-capability-network.js';

const networkName = 'happyclaw-external-egress';

function inspect(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      Name: networkName,
      Scope: 'local',
      Driver: 'bridge',
      Internal: true,
      Ingress: false,
      ConfigOnly: false,
      EnableIPv6: false,
      Options: {
        'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
      },
      Labels: {
        'com.happyclaw.external-capability-egress': 'true',
        'com.happyclaw.egress-policy': 'provider-only',
      },
      ...overrides,
    },
  ]);
}

describe('external capability Docker network readiness', () => {
  test('accepts a dedicated internal provider-only network', async () => {
    await expect(
      probeExternalCapabilityDockerNetwork(networkName, async () => inspect()),
    ).resolves.toBeUndefined();
  });

  test.each([
    ['name mismatch', { Name: 'other' }],
    ['non-local scope', { Scope: 'swarm' }],
    ['non-bridge driver', { Driver: 'host' }],
    ['direct Internet egress', { Internal: false }],
    ['ingress network', { Ingress: true }],
    ['config-only network', { ConfigOnly: true }],
    ['host-addressable IPv4 gateway', { Options: {} }],
    [
      'host-addressable IPv6 gateway',
      {
        EnableIPv6: true,
        Options: {
          'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
        },
      },
    ],
    ['missing labels', { Labels: {} }],
    [
      'unapproved policy',
      {
        Labels: {
          'com.happyclaw.external-capability-egress': 'true',
          'com.happyclaw.egress-policy': 'open-internet',
        },
      },
    ],
  ])('rejects %s', async (_label, overrides) => {
    await expect(
      probeExternalCapabilityDockerNetwork(networkName, async () =>
        inspect(overrides),
      ),
    ).rejects.toThrow(/isolation policy/);
  });

  test('rejects missing or malformed inspect output without exposing it', async () => {
    await expect(
      probeExternalCapabilityDockerNetwork(networkName, async () => 'not-json'),
    ).rejects.toThrow(
      'External capability Docker network could not be inspected',
    );
    await expect(
      probeExternalCapabilityDockerNetwork(networkName, async () => '[]'),
    ).rejects.toThrow('External capability Docker network inspect was invalid');
  });
});
