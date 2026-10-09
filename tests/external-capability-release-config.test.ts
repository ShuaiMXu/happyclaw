import { describe, expect, test } from 'vitest';

import {
  getExternalCapabilityDockerNetwork,
  isExternalCapabilityContainerImagePinned,
  isExternalCapabilityReleaseEnabled,
} from '../src/external-capability-release-config.js';

describe('external capability release configuration', () => {
  test('requires an exact explicit release flag', () => {
    expect(isExternalCapabilityReleaseEnabled({})).toBe(false);
    expect(
      isExternalCapabilityReleaseEnabled({
        EXTERNAL_CAPABILITY_RELEASE_ENABLED: 'TRUE',
      }),
    ).toBe(false);
    expect(
      isExternalCapabilityReleaseEnabled({
        EXTERNAL_CAPABILITY_RELEASE_ENABLED: 'true',
      }),
    ).toBe(true);
  });

  test('requires an immutable digest-pinned runner image', () => {
    const digest = 'a'.repeat(64);
    expect(
      isExternalCapabilityContainerImagePinned(
        `registry.example/happyclaw-agent@sha256:${digest}`,
      ),
    ).toBe(true);
    expect(
      isExternalCapabilityContainerImagePinned(
        `registry.example/happyclaw-agent:release@sha256:${digest}`,
      ),
    ).toBe(true);
    for (const image of [
      '',
      'happyclaw-agent:latest',
      'happyclaw-agent:release',
      'happyclaw-agent@sha256:short',
      `happyclaw-agent@sha512:${digest}`,
    ]) {
      expect(isExternalCapabilityContainerImagePinned(image)).toBe(false);
    }
  });

  test.each(['', 'bridge', 'default', 'host', 'none', '../escape', 'bad name'])(
    'rejects unsafe Docker network %j',
    (network) => {
      expect(
        getExternalCapabilityDockerNetwork({
          EXTERNAL_CAPABILITY_DOCKER_NETWORK: network,
        }),
      ).toBeNull();
    },
  );

  test('accepts a named infrastructure-owned Docker network', () => {
    expect(
      getExternalCapabilityDockerNetwork({
        EXTERNAL_CAPABILITY_DOCKER_NETWORK: 'happyclaw-external-egress',
      }),
    ).toBe('happyclaw-external-egress');
  });
});
