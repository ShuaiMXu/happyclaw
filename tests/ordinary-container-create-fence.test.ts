import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const installationId = 'a'.repeat(64);
let dataDir = '';

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-create-fence-'));
  vi.resetModules();
  vi.doMock('../src/config.js', () => ({ DATA_DIR: dataDir }));
  vi.doMock('../src/instance-ownership.js', () => ({
    canonicalizeInstallationDataDir: (value: string) => value,
    getInstallationId: () => installationId,
    HAPPYCLAW_INSTALLATION_LABEL: 'com.happyclaw.installation',
    HAPPYCLAW_MANAGED_LABEL: 'com.happyclaw.managed',
    ownedDockerLabelFilters: () => [],
  }));
});

afterEach(() => {
  vi.doUnmock('../src/config.js');
  vi.doUnmock('../src/instance-ownership.js');
  vi.doUnmock('../src/external-capability-container-verification.js');
  vi.useRealTimers();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('ordinary container create fence', () => {
  test('durably publishes, lists, and clears a private marker', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T00:00:00.000Z'));
    const fsync = vi.spyOn(fs, 'fsyncSync');
    const fenceModule =
      await import('../src/ordinary-container-create-fence.js');

    const fence = fenceModule.createOrdinaryContainerCreateFence(
      'happyclaw-owned-1',
      30_000,
    );
    expect(fs.statSync(fence.markerPath).mode & 0o777).toBe(0o600);
    expect(fsync).toHaveBeenCalledTimes(2);
    expect(fenceModule.listOrdinaryContainerCreateFences()).toEqual([fence]);

    fenceModule.clearOrdinaryContainerCreateFence(fence);
    expect(fenceModule.listOrdinaryContainerCreateFences()).toEqual([]);
    expect(fsync).toHaveBeenCalledTimes(3);
    fsync.mockRestore();
  });

  test('rejects duplicate names, unsafe names, and invalid create windows', async () => {
    const fenceModule =
      await import('../src/ordinary-container-create-fence.js');
    fenceModule.createOrdinaryContainerCreateFence('happyclaw-owned-1');
    expect(() =>
      fenceModule.createOrdinaryContainerCreateFence('happyclaw-owned-1'),
    ).toThrow();
    expect(() =>
      fenceModule.createOrdinaryContainerCreateFence('../escape'),
    ).toThrow('Invalid Docker container name');
    expect(() =>
      fenceModule.createOrdinaryContainerCreateFence('happyclaw-owned-2', 0),
    ).toThrow('Invalid ordinary container create window');
  });

  test('startup waits through the durable deadline before clearing the marker', async () => {
    const fenceModule =
      await import('../src/ordinary-container-create-fence.js');
    const fence = fenceModule.createOrdinaryContainerCreateFence(
      'happyclaw-owned-1',
      30_000,
    );
    vi.doMock('../src/external-capability-container-verification.js', () => ({
      EXTERNAL_CONTAINER_MARKER_LABEL: 'com.happyclaw.external',
      isExternalCapabilityContainerName: () => false,
    }));
    const { settleOrdinaryContainerCreateFencesAtStartup } =
      await import('../src/startup-container-cleanup.js');
    let now = fence.expiresAt - 1_000;
    const waits: number[] = [];
    const calls: string[][] = [];
    const settled = await settleOrdinaryContainerCreateFencesAtStartup(
      async (args) => {
        calls.push(args);
        return { ok: true, stdout: '' };
      },
      () => now,
      async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
    );

    expect(waits).toEqual([1_025]);
    expect(settled).toEqual([fence.containerName]);
    expect(calls).toEqual([
      ['rm', '--force', fence.containerName],
      [
        'container',
        'ls',
        '--all',
        '--quiet',
        '--filter',
        `name=^/${fence.containerName}$`,
      ],
    ]);
    expect(fenceModule.listOrdinaryContainerCreateFences()).toEqual([]);
  });

  test('fails closed for malformed, foreign, and non-regular entries', async () => {
    const fenceModule =
      await import('../src/ordinary-container-create-fence.js');
    const fence =
      fenceModule.createOrdinaryContainerCreateFence('happyclaw-owned-1');
    fs.writeFileSync(fence.markerPath, '{not-json', 'utf8');
    expect(() => fenceModule.listOrdinaryContainerCreateFences()).toThrow(
      'Invalid ordinary container create fence payload',
    );

    fs.writeFileSync(
      fence.markerPath,
      `${JSON.stringify({
        version: 1,
        installationId: 'foreign',
        containerName: fence.containerName,
        expiresAt: fence.expiresAt,
      })}\n`,
      'utf8',
    );
    expect(() => fenceModule.listOrdinaryContainerCreateFences()).toThrow(
      'Invalid ordinary container create fence payload',
    );

    fs.unlinkSync(fence.markerPath);
    fs.mkdirSync(fence.markerPath);
    expect(() => fenceModule.listOrdinaryContainerCreateFences()).toThrow(
      'Invalid ordinary container create fence entry',
    );
  });
});
