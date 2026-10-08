import { describe, expect, test } from 'vitest';

import {
  getExternalCapabilityDockerNetwork,
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
