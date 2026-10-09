import { describe, expect, test } from 'vitest';

import { EXTERNAL_CONTAINER_MARKER_LABEL } from '../src/external-capability-container-verification.js';
import {
  getInstallationId,
  HAPPYCLAW_INSTALLATION_LABEL,
  HAPPYCLAW_MANAGED_LABEL,
} from '../src/instance-ownership.js';
import {
  buildLegacyStartupContainerListArgs,
  buildStartupContainerListArgs,
  legacyContainerInspectionBelongsToInstallation,
  legacyContainerMountsBelongToInstallation,
  removeAndVerifyStartupContainer,
  selectStoppableStartupContainers,
} from '../src/startup-container-cleanup.js';

const installationId = getInstallationId();
const owned = (name: string, external = '') =>
  `${name}\t${external}\t${installationId}`;

describe('startup container cleanup', () => {
  test('lists only containers owned by this installation', () => {
    expect(buildStartupContainerListArgs()).toEqual([
      'container',
      'ls',
      '--all',
      '--filter',
      `label=${HAPPYCLAW_MANAGED_LABEL}=true`,
      '--filter',
      `label=${HAPPYCLAW_INSTALLATION_LABEL}=${installationId}`,
      '--format',
      `{{.Names}}\t{{.Label "${EXTERNAL_CONTAINER_MARKER_LABEL}"}}\t{{.Label "${HAPPYCLAW_INSTALLATION_LABEL}"}}`,
    ]);
  });

  test('stops owned external orphans when no Vault is available', () => {
    const output = [
      owned('happyclaw-normal-1'),
      owned('happyclaw-external-live-1-7', 'true'),
      owned('happyclaw-external-legacy-1-6'),
    ].join('\n');

    expect(selectStoppableStartupContainers(output, false)).toEqual([
      'happyclaw-normal-1',
      'happyclaw-external-live-1-7',
      'happyclaw-external-legacy-1-6',
    ]);
  });

  test('preserves owned external containers before reconciliation', () => {
    expect(
      selectStoppableStartupContainers(
        [
          owned('happyclaw-normal-1'),
          owned('happyclaw-external-live-1-7', 'true'),
          owned('happyclaw-external-legacy-1-6'),
          owned(
            'happyclaw-flow-main-external-3f2504e0-4f89-41d3-9a0c-0305e82c3301-1712345678901',
          ),
          owned('happyclaw-normal-2', 'false'),
        ].join('\n'),
      ),
    ).toEqual(['happyclaw-normal-1', 'happyclaw-normal-2']);
  });

  test('never claims a foreign or unlabeled lookalike', () => {
    expect(
      selectStoppableStartupContainers(
        [
          `happyclaw-foreign\tfalse\t${'f'.repeat(64)}`,
          'happyclaw-unlabelled\tfalse\t',
          owned('happyclaw-owned', 'false'),
        ].join('\n'),
      ),
    ).toEqual(['happyclaw-owned']);
  });

  test('lists all legacy name candidates without treating the name as ownership', () => {
    expect(buildLegacyStartupContainerListArgs()).toEqual([
      'container',
      'ls',
      '--all',
      '--filter',
      'name=^/happyclaw-',
      '--format',
      '{{.Names}}',
    ]);
  });

  test('claims only unlabeled legacy containers mounted under this data directory', () => {
    const dataDir = '/srv/happyclaw/data';
    const ownedMounts = JSON.stringify([
      { Type: 'bind', Source: '/srv/happyclaw/data/groups/main' },
    ]);
    expect(
      legacyContainerMountsBelongToInstallation(ownedMounts, dataDir),
    ).toBe(true);
    expect(
      legacyContainerMountsBelongToInstallation(
        JSON.stringify([{ Type: 'bind', Source: '/srv/other/data' }]),
        dataDir,
      ),
    ).toBe(false);
    expect(
      legacyContainerInspectionBelongsToInstallation(
        JSON.stringify([
          {
            Config: { Labels: null },
            Mounts: JSON.parse(ownedMounts),
          },
        ]),
        dataDir,
      ),
    ).toBe(true);
    expect(
      legacyContainerInspectionBelongsToInstallation(
        JSON.stringify([
          {
            Config: { Labels: { [HAPPYCLAW_MANAGED_LABEL]: 'true' } },
            Mounts: JSON.parse(ownedMounts),
          },
        ]),
        dataDir,
      ),
    ).toBe(false);
  });

  test('removes by name and requires an all-state absence proof', async () => {
    const calls: string[][] = [];
    await removeAndVerifyStartupContainer('happyclaw-owned', async (args) => {
      calls.push(args);
      return { ok: true, stdout: '' };
    });
    expect(calls).toEqual([
      ['rm', '--force', 'happyclaw-owned'],
      [
        'container',
        'ls',
        '--all',
        '--quiet',
        '--filter',
        'name=^/happyclaw-owned$',
      ],
    ]);

    await expect(
      removeAndVerifyStartupContainer('happyclaw-owned', async (args) => ({
        ok: true,
        stdout: args[0] === 'container' ? 'container-id\n' : '',
      })),
    ).rejects.toThrow('Could not verify removal');
  });
});
