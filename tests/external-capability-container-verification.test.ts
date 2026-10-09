import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  getRun: vi.fn(),
  clearCleanup: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('../src/db.js', () => ({
  getExternalCapabilityRunById: mocks.getRun,
  clearExternalCapabilityRunContainerCleanupAfterVerifiedAbsence:
    mocks.clearCleanup,
}));

const { verifyExternalCapabilityRunContainerAbsent } =
  await import('../src/external-capability-container-verification.js');
const {
  getInstallationId,
  getInstallationNamespace,
  HAPPYCLAW_INSTALLATION_LABEL,
  HAPPYCLAW_MANAGED_LABEL,
} = await import('../src/instance-ownership.js');

describe('external capability container absence verification', () => {
  beforeEach(() => {
    mocks.execFile.mockReset();
    mocks.getRun.mockReset();
    mocks.clearCleanup.mockReset();
    mocks.getRun.mockReturnValue(undefined);
    mocks.clearCleanup.mockReturnValue(true);
  });

  test('fails closed while an owned namespaced container still exists', async () => {
    mocks.execFile.mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        expect(args).toContain(`label=${HAPPYCLAW_MANAGED_LABEL}=true`);
        expect(args).toContain(
          `label=${HAPPYCLAW_INSTALLATION_LABEL}=${getInstallationId()}`,
        );
        callback(
          null,
          `happyclaw-${getInstallationNamespace()}-external-run-with-hyphens-2-7\n`,
        );
      },
    );

    await expect(
      verifyExternalCapabilityRunContainerAbsent('run-with-hyphens'),
    ).resolves.toBe(false);
    expect(mocks.getRun).not.toHaveBeenCalled();
  });

  test('fails closed while an earliest-generation container still exists', async () => {
    const runId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    mocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) =>
        callback(null, `happyclaw-flow-main-external-${runId}-1712345678901\n`),
    );

    await expect(
      verifyExternalCapabilityRunContainerAbsent(runId),
    ).resolves.toBe(false);
    expect(mocks.getRun).not.toHaveBeenCalled();
  });

  test('ignores containers belonging to another exact run identity', async () => {
    mocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(null, 'happyclaw-external-run-with-hyphens-extra-2-7\n'),
    );

    await expect(
      verifyExternalCapabilityRunContainerAbsent('run-with-hyphens'),
    ).resolves.toBe(true);
  });

  test('clears the exact durable cleanup identity only after name absence', async () => {
    mocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(null, ''),
    );
    mocks.getRun.mockReturnValue({
      container_cleanup_attempt: 4,
      container_cleanup_lease_token: 11,
      container_create_pending_until: null,
    });

    await expect(
      verifyExternalCapabilityRunContainerAbsent('cleanup-run'),
    ).resolves.toBe(true);
    expect(mocks.clearCleanup).toHaveBeenCalledWith('cleanup-run', 4, 11);
  });

  test('clears an expired create reservation only through exact absence fencing', async () => {
    mocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(null, ''),
    );
    mocks.getRun.mockReturnValue({
      container_cleanup_attempt: 5,
      container_cleanup_lease_token: 12,
      container_create_pending_until: '2026-10-01T00:00:00.000Z',
    });
    mocks.clearCleanup.mockReturnValue(true);

    await expect(
      verifyExternalCapabilityRunContainerAbsent('expired-create-run'),
    ).resolves.toBe(true);
    expect(mocks.clearCleanup).toHaveBeenCalledWith(
      'expired-create-run',
      5,
      12,
    );
  });

  test('fails closed while the durable create reservation cannot be cleared', async () => {
    mocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(null, ''),
    );
    mocks.getRun
      .mockReturnValueOnce({
        container_cleanup_attempt: 6,
        container_cleanup_lease_token: 13,
        container_create_pending_until: '2099-01-01T00:00:00.000Z',
      })
      .mockReturnValueOnce({
        container_cleanup_attempt: 6,
        container_cleanup_lease_token: 13,
        container_create_pending_until: '2099-01-01T00:00:00.000Z',
      });
    mocks.clearCleanup.mockReturnValue(false);

    await expect(
      verifyExternalCapabilityRunContainerAbsent('pending-create-run'),
    ).resolves.toBe(false);
    expect(mocks.clearCleanup).toHaveBeenCalledWith(
      'pending-create-run',
      6,
      13,
    );
  });

  test('fails closed on invalid Docker name output', async () => {
    mocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(null, 'bad name\n'),
    );

    await expect(
      verifyExternalCapabilityRunContainerAbsent('cleanup-run'),
    ).resolves.toBe(false);
    expect(mocks.getRun).not.toHaveBeenCalled();
  });
});
