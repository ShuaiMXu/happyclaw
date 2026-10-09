import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import type { ClaimedExternalCapabilityRun } from '../src/types.js';

const mocks = vi.hoisted(() => ({
  releaseForRetry: vi.fn(() => true),
  completeRun: vi.fn(() => true),
  runContainerAgent: vi.fn(),
  getVaultRoot: vi.fn(() => '/tmp/external-capacity-test'),
  getCapability: vi.fn(() => ({
    workspace_jid: 'web:execution-time-workspace',
  })),
  getRunById: vi.fn(),
  reserveContainerCreation: vi.fn(() => '2099-01-01T00:00:00.000Z'),
  finishContainerCreation: vi.fn(() => true),
  authorizeStart: vi.fn(() => ({ outcome: 'started' })),
  publishStart: vi.fn((_runId, _owner, _token, publish) => {
    publish();
    return true;
  }),
  publishAcknowledgement: vi.fn((_runId, _owner, _token, publish) => {
    publish();
    return true;
  }),
  rollbackStart: vi.fn(() => true),
  clearCleanup: vi.fn(() => true),
  markCleanup: vi.fn(() => true),
  reserveStorage: vi.fn(() => 'test-storage-reservation'),
  materializeStorage: vi.fn(),
  settleStorage: vi.fn(),
  releaseStorage: vi.fn(),
  quarantineStorage: vi.fn(),
  deleteArtifact: vi.fn(),
  deleteRuntimeDirectory: vi.fn(),
  storeArtifact: vi.fn(() => ({
    storageRef: 'ecv1:run-1:result-test',
    byteLength: 256,
    sha256: 'b'.repeat(64),
  })),
  readArtifact: vi.fn(() => Buffer.from('image-bytes')),
  measureRuntime: vi.fn(() => 0),
  censusReady: true,
  vaultLockAvailable: true,
  releaseVaultLock: vi.fn(),
  execFile: vi.fn(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => callback(new Error('docker unavailable'), ''),
  ),
  executionStops: new Map<string, () => boolean | Promise<boolean>>(),
}));

vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));

vi.mock('../src/config.js', () => ({
  CONTAINER_IMAGE: 'runner@example-digest',
}));

vi.mock('../src/instance-ownership.js', () => ({
  getInstallationId: () => 'test-installation',
  getInstallationNamespace: () => 'test-installation',
  HAPPYCLAW_MANAGED_LABEL: 'com.happyclaw.managed',
  HAPPYCLAW_INSTALLATION_LABEL: 'com.happyclaw.installation',
  ownedDockerLabelFilters: () => [],
}));

vi.mock('../src/db.js', () => ({
  authorizeExternalCapabilityRunExecutionStart: mocks.authorizeStart,
  claimNextExternalCapabilityRun: vi.fn(),
  clearExternalCapabilityRunContainerCleanupAfterVerifiedAbsence:
    mocks.clearCleanup,
  clearExternalCapabilityRunContainerCleanupRequired: mocks.clearCleanup,
  completeExternalCapabilityRun: mocks.completeRun,
  fenceExpiredStartedExternalCapabilityRunsForRecovery: vi.fn(() => []),
  fenceExternalCapabilityContainerLease: vi.fn(() => 'stale'),
  finishExternalCapabilityRunContainerCreation: mocks.finishContainerCreation,
  getExternalCapabilityBySlug: mocks.getCapability,
  getExternalCapabilityRunById: mocks.getRunById,
  getRegisteredGroup: vi.fn(() => ({
    jid: 'web:workspace',
    folder: 'workspace',
    executionMode: 'container',
  })),
  listExternalCapabilityContainerCleanupDebts: vi.fn(() => []),
  listExternalCapabilityRunsAwaitingStartRecovery: vi.fn(() => []),
  markExternalCapabilityRunContainerCleanupRequired: mocks.markCleanup,
  publishExternalCapabilityRunExecutionAcknowledgement:
    mocks.publishAcknowledgement,
  publishExternalCapabilityRunExecutionStart: mocks.publishStart,
  releaseExternalCapabilityRunForRetry: mocks.releaseForRetry,
  recoverExpiredExternalCapabilityWorkspaceDeletions: vi.fn(() => 0),
  reconcileDeferredExternalCapabilityDefinitions: vi.fn(() => []),
  reserveExternalCapabilityRunContainerCreation: mocks.reserveContainerCreation,
  resolveExternalCapabilityRunStartRecovery: vi.fn(() => true),
  writeExternalCapabilityRunUsage: vi.fn(),
  rollbackExternalCapabilityRunExecutionStartBeforePublication:
    mocks.rollbackStart,
  renewExternalCapabilityRunLease: vi.fn(() => true),
}));

vi.mock('../src/external-capability-storage-capacity.js', () => ({
  quarantineExternalCapabilityStorageCapacity: mocks.quarantineStorage,
  recordExternalCapabilityStorageMaterializedCapacity: mocks.materializeStorage,
  releaseExternalCapabilityStorageCapacity: mocks.releaseStorage,
  reserveExternalCapabilityStorageCapacity: mocks.reserveStorage,
  settleExternalCapabilityStorageCapacity: mocks.settleStorage,
}));

vi.mock('../src/external-capabilities.js', () => ({
  getConfiguredExternalCapability: vi.fn(() => ({
    workspace_jid: 'web:workspace',
    workspace_folder: 'workspace',
  })),
  QUOTE_DOCUMENT_CAPABILITY_POLICY: 'server policy',
}));

vi.mock('../src/external-capability-release-config.js', () => ({
  EXTERNAL_RUNNER_PROTOCOL_VERSION: 1,
  getExternalCapabilityDockerNetwork: vi.fn(() => 'external-network'),
  isExternalCapabilityReleaseEnabled: vi.fn(() => true),
}));

vi.mock('../src/external-capability-storage-backfill.js', () => ({
  isExternalCapabilityVaultCensusReady: vi.fn(() => mocks.censusReady),
}));

vi.mock('../src/external-capability-vault-lock.js', () => ({
  acquireExternalCapabilityVaultSharedLock: vi.fn(() =>
    mocks.vaultLockAvailable ? { release: mocks.releaseVaultLock } : null,
  ),
}));

vi.mock('../src/external-capability-execution-control.js', () => ({
  registerExternalCapabilityExecution: vi.fn(
    (runId: string, stop: () => boolean | Promise<boolean>) => {
      mocks.executionStops.set(runId, stop);
      return () => {
        if (mocks.executionStops.get(runId) === stop) {
          mocks.executionStops.delete(runId);
        }
      };
    },
  ),
}));

vi.mock('../src/external-capability-network.js', () => ({
  probeExternalCapabilityDockerNetwork: vi.fn(async () => {}),
}));

vi.mock('../src/external-capability-runner-image.js', () => ({
  assertExternalCapabilityRunnerImage: vi.fn(async () => {}),
}));

vi.mock('../src/external-capability-output-schema.js', () => ({
  decodeExternalOutputSchema: vi.fn(() => ({
    columns: [{ key: 'value', name: 'Value' }],
    sheetName: 'Data',
  })),
}));

vi.mock('../src/external-capability-quota-config.js', () => ({
  getExternalCapabilityQuotaConfig: vi.fn(() => ({
    executionTimeoutMs: 60_000,
    maxOutputRows: 100,
    maxOutputCells: 1_000,
    maxOutputBytes: 1024 * 1024,
    maxTurnsPerRun: 2,
    maxBudgetUsdPerRun: 1,
    globalProviderCostUsdPerDay: 10,
    capabilityProviderCostUsdPerDay: 10,
    keyProviderCostUsdPerDay: 10,
    globalConcurrency: 2,
    capabilityConcurrency: 2,
    keyConcurrency: 1,
  })),
}));

vi.mock('../src/external-capability-result-contract.js', () => ({
  addMissingRequiredWarnings: vi.fn((warnings) => warnings),
  EXTERNAL_CAPABILITY_WARNING_CODES: [],
  isSafeExternalCapabilityCellString: vi.fn(() => true),
  parseExternalCapabilityModelWarnings: vi.fn(() => []),
}));

vi.mock('../src/external-capability-retention.js', () => ({
  runExternalCapabilityRetention: vi.fn(async () => ({
    sanitizedRuns: 0,
    deletedOrphanRunDirectories: 0,
    deletedRuntimeDirectories: 0,
    errors: 0,
  })),
}));

vi.mock('../src/external-capability-safe-error.js', () => ({
  getExternalCapabilitySafeErrorMetadata: vi.fn(() => ({})),
}));

vi.mock('../src/external-capability-storage.js', () => ({
  deleteExternalCapabilityArtifact: mocks.deleteArtifact,
  deleteExternalCapabilityRuntimeDirectory: mocks.deleteRuntimeDirectory,
  ExternalCapabilityArtifactIntegrityError: class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ExternalCapabilityArtifactIntegrityError';
    }
  },
  getExternalCapabilityVaultRoot: mocks.getVaultRoot,
  measureExternalCapabilityRuntimeStorageBytes: mocks.measureRuntime,
  readExternalCapabilityArtifact: mocks.readArtifact,
  storeExternalCapabilityArtifact: mocks.storeArtifact,
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/container-runner.js', () => ({
  externalCapabilityContainerName: (
    runId: string,
    attempt: number,
    leaseToken: number,
  ) => `happyclaw-external-${runId}-${attempt}-${leaseToken}`,
  runContainerAgent: mocks.runContainerAgent,
}));

const {
  EXTERNAL_RUNTIME_VAULT_OVERHEAD_BYTES,
  countActiveExternalContainerExecutionsForTest,
  countPendingExternalContainerCleanupsForTest,
  executeExternalCapabilityClaimForTest,
  reconcileExternalCapabilityContainersForTest,
  resolveExternalCapabilityContainerWorkspaceJid,
} = await import('../src/external-capability-worker.js');
const { ExternalCapabilityArtifactIntegrityError } =
  await import('../src/external-capability-storage.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function claim(): ClaimedExternalCapabilityRun {
  const now = new Date().toISOString();
  return {
    id: 'run-1',
    capability_slug: 'quote-document-process',
    key_id: 'key-1',
    idempotency_key: 'idempotency-1',
    external_task_id: 'task-1',
    tenant_ref: null,
    account_ref: null,
    callback_context: null,
    input_manifest: {
      outputSchema: {},
      artifacts: [
        {
          id: 'artifact-1',
          displayName: 'source.png',
          detectedMimeType: 'image/png',
          byteLength: 11,
          sha256: 'a'.repeat(64),
          storageRef: 'run-1/artifact-1.bin',
        },
      ],
    },
    input_bytes: 11,
    status: 'running',
    attempt: 1,
    available_at: now,
    lease_owner: 'worker-1',
    lease_token: 1,
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    started_at: null,
    completed_at: null,
    retention_cleaned_at: null,
    container_cleanup_attempt: null,
    container_cleanup_lease_token: null,
    container_create_pending_until: null,
    result: null,
    error_code: null,
    error_message: null,
    created_at: now,
    updated_at: now,
  };
}

describe('external capability shared container capacity', () => {
  test('accounts recovered containers to the durable execution-time target', () => {
    mocks.getRunById.mockReturnValueOnce({
      capability_slug: 'quote-document-process',
    });

    expect(resolveExternalCapabilityContainerWorkspaceJid('run-1')).toBe(
      'web:execution-time-workspace',
    );
    expect(mocks.getCapability).toHaveBeenCalledWith('quote-document-process');
  });

  test('requeues before touching the Vault while its census is blocked', async () => {
    mocks.releaseForRetry.mockClear();
    mocks.runContainerAgent.mockClear();
    mocks.readArtifact.mockClear();
    mocks.releaseVaultLock.mockClear();
    const tryAcquireContainerSlot = vi.fn(() => vi.fn());
    mocks.censusReady = false;

    try {
      await executeExternalCapabilityClaimForTest(claim(), {
        tryAcquireContainerSlot,
        adoptContainerSlot: () => vi.fn(),
      });
    } finally {
      mocks.censusReady = true;
    }

    expect(tryAcquireContainerSlot).not.toHaveBeenCalled();
    expect(mocks.readArtifact).not.toHaveBeenCalled();
    expect(mocks.runContainerAgent).not.toHaveBeenCalled();
    expect(mocks.releaseForRetry).toHaveBeenCalledOnce();
    expect(mocks.releaseForRetry.mock.calls[0]?.[5]).toEqual({
      countsAsAttempt: false,
    });
    expect(mocks.releaseVaultLock).toHaveBeenCalledOnce();
  });

  test('requeues before touching the Vault when its producer lock is unavailable', async () => {
    mocks.releaseForRetry.mockClear();
    mocks.runContainerAgent.mockClear();
    mocks.readArtifact.mockClear();
    mocks.releaseVaultLock.mockClear();
    const tryAcquireContainerSlot = vi.fn(() => vi.fn());
    mocks.vaultLockAvailable = false;

    try {
      await executeExternalCapabilityClaimForTest(claim(), {
        tryAcquireContainerSlot,
        adoptContainerSlot: () => vi.fn(),
      });
    } finally {
      mocks.vaultLockAvailable = true;
    }

    expect(tryAcquireContainerSlot).not.toHaveBeenCalled();
    expect(mocks.readArtifact).not.toHaveBeenCalled();
    expect(mocks.runContainerAgent).not.toHaveBeenCalled();
    expect(mocks.releaseForRetry).toHaveBeenCalledOnce();
    expect(mocks.releaseForRetry.mock.calls[0]?.[5]).toEqual({
      countsAsAttempt: false,
    });
    expect(mocks.releaseVaultLock).not.toHaveBeenCalled();
  });

  test('checks shared capacity before preparing source material', async () => {
    mocks.releaseForRetry.mockClear();
    mocks.completeRun.mockClear();
    mocks.runContainerAgent.mockClear();
    mocks.readArtifact.mockClear();
    const tryAcquireContainerSlot = vi.fn(() => null);

    await executeExternalCapabilityClaimForTest(claim(), {
      tryAcquireContainerSlot,
      adoptContainerSlot: () => vi.fn(),
    });

    expect(mocks.completeRun).not.toHaveBeenCalled();
    expect(mocks.readArtifact).not.toHaveBeenCalled();
    expect(tryAcquireContainerSlot).toHaveBeenCalledWith('web:workspace');
    expect(mocks.runContainerAgent).not.toHaveBeenCalled();
    expect(mocks.releaseForRetry).toHaveBeenCalledOnce();
    expect(mocks.releaseForRetry.mock.calls[0]?.[5]).toEqual({
      countsAsAttempt: false,
    });
  });

  test('releases reserved capacity after a transient preparation failure', async () => {
    mocks.releaseForRetry.mockClear();
    mocks.completeRun.mockClear();
    mocks.runContainerAgent.mockClear();
    const release = vi.fn();
    const tryAcquireContainerSlot = vi.fn(() => release);
    mocks.getVaultRoot.mockImplementationOnce(() => {
      throw new Error('vault unavailable');
    });

    await executeExternalCapabilityClaimForTest(claim(), {
      tryAcquireContainerSlot,
      adoptContainerSlot: () => vi.fn(),
    });

    expect(tryAcquireContainerSlot).toHaveBeenCalledWith('web:workspace');
    expect(release).toHaveBeenCalledOnce();
    expect(mocks.runContainerAgent).not.toHaveBeenCalled();
    expect(mocks.completeRun).not.toHaveBeenCalled();
    expect(mocks.releaseForRetry).toHaveBeenCalledOnce();
  });

  test('rejects host runtime growth beyond the durable reservation', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'external-runtime-bound-'),
    );
    mocks.getVaultRoot.mockReturnValueOnce(root);
    mocks.releaseForRetry.mockClear();
    mocks.completeRun.mockClear();
    mocks.runContainerAgent.mockClear();
    mocks.execFile.mockReset();
    mocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(null, ''),
    );
    mocks.measureRuntime.mockReturnValueOnce(
      claim().input_bytes + EXTERNAL_RUNTIME_VAULT_OVERHEAD_BYTES,
    );
    const release = vi.fn();
    mocks.runContainerAgent.mockImplementationOnce(
      async (
        _group: unknown,
        input: {
          externalExecution: {
            assertRuntimeStorageBound: (additionalBytes: number) => void;
          };
        },
      ) => {
        expect(() =>
          input.externalExecution.assertRuntimeStorageBound(1),
        ).toThrow(/exceeded its durable Vault reservation/);
        throw new Error('runtime storage bound rejected');
      },
    );

    try {
      await executeExternalCapabilityClaimForTest(claim(), {
        tryAcquireContainerSlot: () => release,
        adoptContainerSlot: () => vi.fn(),
      });
      expect(mocks.measureRuntime).toHaveBeenCalledWith(
        root,
        expect.stringMatching(/^run-1-a1-l1-/),
      );
      expect(mocks.releaseForRetry).toHaveBeenCalledOnce();
      expect(mocks.completeRun).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      mocks.measureRuntime.mockReset();
      mocks.measureRuntime.mockReturnValue(0);
      mocks.execFile.mockReset();
      mocks.execFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string) => void,
        ) => callback(new Error('docker unavailable'), ''),
      );
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('terminalizes a malformed persisted manifest without capacity or retry', async () => {
    mocks.releaseForRetry.mockClear();
    mocks.completeRun.mockClear();
    mocks.runContainerAgent.mockClear();
    const tryAcquireContainerSlot = vi.fn(() => vi.fn());
    const invalidClaim = claim();
    invalidClaim.input_manifest = { outputSchema: {} };

    await executeExternalCapabilityClaimForTest(invalidClaim, {
      tryAcquireContainerSlot,
      adoptContainerSlot: () => vi.fn(),
    });

    expect(mocks.releaseForRetry).not.toHaveBeenCalled();
    expect(tryAcquireContainerSlot).not.toHaveBeenCalled();
    expect(mocks.runContainerAgent).not.toHaveBeenCalled();
    expect(mocks.completeRun).toHaveBeenCalledWith(
      invalidClaim.id,
      invalidClaim.lease_owner,
      invalidClaim.lease_token,
      {
        status: 'failed',
        error: {
          code: 'SOURCE_INVALID',
          message: 'The source material is invalid or unsupported.',
        },
      },
    );
  });

  test('terminalizes an invalid workbook after releasing capacity', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'external-invalid-workbook-'),
    );
    mocks.getVaultRoot.mockReturnValueOnce(root);
    mocks.readArtifact.mockReturnValueOnce(Buffer.from('not an xlsx package'));
    mocks.releaseForRetry.mockClear();
    mocks.completeRun.mockClear();
    mocks.runContainerAgent.mockClear();
    mocks.reserveStorage.mockClear();
    mocks.settleStorage.mockClear();
    mocks.releaseStorage.mockClear();
    const release = vi.fn();
    const tryAcquireContainerSlot = vi.fn(() => release);
    const invalidClaim = claim();
    const artifact = (
      invalidClaim.input_manifest.artifacts as Array<Record<string, unknown>>
    )[0]!;
    artifact.displayName = 'source.xlsx';
    artifact.detectedMimeType =
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    try {
      await executeExternalCapabilityClaimForTest(invalidClaim, {
        tryAcquireContainerSlot,
        adoptContainerSlot: () => vi.fn(),
      });

      expect(mocks.releaseForRetry).not.toHaveBeenCalled();
      expect(tryAcquireContainerSlot).toHaveBeenCalledWith('web:workspace');
      expect(release).toHaveBeenCalledOnce();
      expect(mocks.runContainerAgent).not.toHaveBeenCalled();
      expect(mocks.completeRun).toHaveBeenCalledWith(
        invalidClaim.id,
        invalidClaim.lease_owner,
        invalidClaim.lease_token,
        {
          status: 'failed',
          error: {
            code: 'SOURCE_INVALID',
            message: 'The source material is invalid or unsupported.',
          },
        },
      );
      expect(mocks.reserveStorage).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: invalidClaim.id,
          kind: 'runtime',
          byteCount:
            invalidClaim.input_bytes + EXTERNAL_RUNTIME_VAULT_OVERHEAD_BYTES,
          vaultRoot: root,
        }),
      );
      expect(mocks.settleStorage).not.toHaveBeenCalled();
      expect(mocks.releaseStorage).toHaveBeenCalledWith(
        'test-storage-reservation',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('terminalizes artifact integrity failures after releasing capacity', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'external-invalid-storage-'),
    );
    mocks.getVaultRoot.mockReturnValueOnce(root);
    mocks.readArtifact.mockImplementationOnce(() => {
      throw new ExternalCapabilityArtifactIntegrityError('digest mismatch');
    });
    mocks.releaseForRetry.mockClear();
    mocks.completeRun.mockClear();
    mocks.runContainerAgent.mockClear();
    const release = vi.fn();
    const tryAcquireContainerSlot = vi.fn(() => release);

    try {
      await executeExternalCapabilityClaimForTest(claim(), {
        tryAcquireContainerSlot,
        adoptContainerSlot: () => vi.fn(),
      });

      expect(mocks.releaseForRetry).not.toHaveBeenCalled();
      expect(tryAcquireContainerSlot).toHaveBeenCalledWith('web:workspace');
      expect(release).toHaveBeenCalledOnce();
      expect(mocks.runContainerAgent).not.toHaveBeenCalled();
      expect(mocks.completeRun).toHaveBeenCalledWith('run-1', 'worker-1', 1, {
        status: 'failed',
        error: {
          code: 'SOURCE_STORAGE_INTEGRITY_FAILED',
          message: 'The stored source material failed integrity verification.',
        },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('clears a stale cleanup marker only after proving the prior container absent', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'external-stale-cleanup-marker-'),
    );
    const current = claim();
    current.attempt = 2;
    current.lease_token = 2;
    current.container_cleanup_attempt = 1;
    current.container_cleanup_lease_token = 1;
    mocks.getVaultRoot.mockReturnValueOnce(root);
    mocks.getRunById.mockReturnValueOnce(current);
    mocks.clearCleanup.mockClear();
    mocks.markCleanup.mockClear();
    mocks.releaseForRetry.mockClear();
    mocks.execFile.mockReset();
    mocks.execFile.mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        if (args[0] === 'container') callback(null, '');
        else callback(new Error('unexpected Docker command'), '');
      },
    );
    mocks.runContainerAgent.mockRejectedValueOnce(
      new Error('runner unavailable after marker replacement'),
    );

    try {
      await executeExternalCapabilityClaimForTest(current, {
        tryAcquireContainerSlot: () => vi.fn(),
        adoptContainerSlot: () => vi.fn(),
      });

      expect(mocks.clearCleanup).toHaveBeenNthCalledWith(1, current.id, 1, 1);
      expect(mocks.markCleanup).toHaveBeenCalledWith(
        current.id,
        current.lease_owner,
        current.lease_token,
        current.attempt,
      );
      expect(mocks.clearCleanup).toHaveBeenLastCalledWith(
        current.id,
        current.attempt,
        current.lease_token,
      );
      expect(mocks.releaseForRetry).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not verify cancellation until a pending container spawn is fenced', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'external-pre-spawn-cancel-'),
    );
    mocks.getVaultRoot.mockReturnValueOnce(root);
    mocks.releaseForRetry.mockClear();
    mocks.completeRun.mockClear();
    mocks.executionStops.clear();
    const enteredRunner = deferred<void>();
    const allowSpawn = deferred<void>();
    const allowFinish = deferred<void>();
    const release = vi.fn();
    mocks.execFile.mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        if (args[0] === 'stop' || args[0] === 'kill') {
          callback(null, '');
          return;
        }
        if (args[0] === 'container') {
          callback(null, '');
          return;
        }
        callback(new Error('unexpected Docker command'), '');
      },
    );
    mocks.runContainerAgent.mockImplementationOnce(
      async (
        _group: unknown,
        input: {
          externalExecution: {
            authorizeContainerCreation: (
              create: () => Promise<void>,
            ) => Promise<boolean>;
          };
        },
        onSpawn: (container: unknown, containerName: string) => void,
      ) => {
        enteredRunner.resolve();
        await allowSpawn.promise;
        let physicallyCreated = false;
        const authorized =
          await input.externalExecution.authorizeContainerCreation(async () => {
            physicallyCreated = true;
          });
        if (!authorized || !physicallyCreated) {
          throw new Error('container creation was not authorized');
        }
        onSpawn(
          { kill: vi.fn() },
          'happyclaw-external-pre-spawn-cancel-run-1-1',
        );
        await allowFinish.promise;
        throw new Error('cancelled after spawn');
      },
    );

    try {
      const execution = executeExternalCapabilityClaimForTest(claim(), {
        tryAcquireContainerSlot: () => release,
        adoptContainerSlot: () => vi.fn(),
      });
      await enteredRunner.promise;
      const stop = mocks.executionStops.get('run-1');
      expect(stop).toBeDefined();
      let stopSettled = false;
      const stopped = Promise.resolve(stop!()).then((value) => {
        stopSettled = true;
        return value;
      });
      await Promise.resolve();
      expect(stopSettled).toBe(false);

      allowSpawn.resolve();
      await Promise.resolve();
      expect(stopSettled).toBe(false);
      allowFinish.resolve();
      await execution;
      await expect(stopped).resolves.toBe(true);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      allowSpawn.resolve();
      allowFinish.resolve();
      mocks.executionStops.clear();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('requeues a published START when the absent runner never acknowledged it', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'external-live-start-recovery-'),
    );
    mocks.getVaultRoot.mockReturnValueOnce(root);
    mocks.releaseForRetry.mockClear();
    mocks.completeRun.mockClear();
    mocks.rollbackStart.mockClear();
    mocks.authorizeStart.mockClear();
    mocks.publishStart.mockClear();
    mocks.execFile.mockReset();
    mocks.execFile.mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        if (args[0] === 'container') callback(null, '');
        else callback(new Error('unexpected Docker command'), '');
      },
    );
    mocks.runContainerAgent.mockImplementationOnce(
      async (
        _group: unknown,
        input: {
          externalExecution: {
            runtimeDirectory: string;
            authorizeStart: (publish: () => void) => boolean;
            acknowledgeStart: (publish: () => void) => boolean;
          };
        },
        onSpawn: (container: unknown, containerName: string) => void,
      ) => {
        onSpawn(
          { kill: vi.fn() },
          'happyclaw-external-live-start-recovery-1-1',
        );
        expect(
          input.externalExecution.authorizeStart(() => {
            fs.writeFileSync(
              path.join(
                input.externalExecution.runtimeDirectory,
                'authorization',
                'decision.json',
              ),
              JSON.stringify({
                protocol: 1,
                authorizationId: 'live-start-recovery',
                decision: 'start',
              }),
            );
          }),
        ).toBe(true);
        return { status: 'error', result: null };
      },
    );

    try {
      await executeExternalCapabilityClaimForTest(claim(), {
        tryAcquireContainerSlot: () => vi.fn(),
        adoptContainerSlot: () => vi.fn(),
      });

      expect(mocks.rollbackStart).toHaveBeenCalledOnce();
      expect(mocks.releaseForRetry).toHaveBeenCalledOnce();
      expect(mocks.completeRun).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('deletes output and releases its charge when ledger settlement fails', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'external-output-settlement-'),
    );
    mocks.getVaultRoot.mockReturnValueOnce(root);
    mocks.completeRun.mockClear();
    mocks.runContainerAgent.mockClear();
    mocks.publishAcknowledgement.mockClear();
    mocks.reserveStorage.mockReset();
    mocks.reserveStorage.mockImplementation((input: { kind: string }) =>
      input.kind === 'runtime'
        ? 'runtime-storage-reservation'
        : 'output-storage-reservation',
    );
    mocks.settleStorage.mockReset();
    mocks.settleStorage.mockImplementation((key: string) => {
      if (key === 'output-storage-reservation') {
        throw new Error('injected output settlement failure');
      }
    });
    mocks.releaseStorage.mockClear();
    mocks.quarantineStorage.mockClear();
    mocks.deleteArtifact.mockClear();
    mocks.storeArtifact.mockClear();
    mocks.execFile.mockReset();
    mocks.execFile.mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        if (args[0] === 'container') callback(null, '');
        else callback(null, '');
      },
    );
    mocks.runContainerAgent.mockImplementationOnce(
      async (
        _group: unknown,
        input: {
          externalExecution: {
            inputDirectory: string;
            outputDirectory: string;
            runtimeDirectory: string;
            authorizeContainerCreation: (
              create: () => Promise<void>,
            ) => Promise<boolean>;
            authorizeStart: (publish: () => void) => boolean;
            acknowledgeStart: (publish: () => void) => boolean;
          };
        },
        onSpawn: (container: unknown, containerName: string) => void,
        onOutput: (frame: Record<string, unknown>) => Promise<void>,
      ) => {
        expect(
          await input.externalExecution.authorizeContainerCreation(
            async () => {},
          ),
        ).toBe(true);
        onSpawn(
          { kill: vi.fn() },
          'happyclaw-external-output-settlement-run-1-1',
        );
        const authorizationId = 'output-settlement';
        expect(
          input.externalExecution.authorizeStart(() => {
            const authorizationDirectory = path.join(
              input.externalExecution.runtimeDirectory,
              'authorization',
            );
            fs.mkdirSync(authorizationDirectory, { recursive: true });
            fs.writeFileSync(
              path.join(authorizationDirectory, 'decision.json'),
              JSON.stringify({
                protocol: 1,
                authorizationId,
                decision: 'start',
              }),
            );
          }),
        ).toBe(true);
        expect(
          input.externalExecution.acknowledgeStart(() => {
            fs.writeFileSync(
              path.join(
                input.externalExecution.outputDirectory,
                'start-consumed.json',
              ),
              JSON.stringify({
                protocol: 1,
                authorizationId,
                consumed: true,
              }),
            );
          }),
        ).toBe(true);
        const frame = {
          status: 'success',
          result: JSON.stringify({ rows: [{ value: 'ok' }], warnings: [] }),
          sdkMessageUuid: 'output-settlement-usage',
          streamEvent: {
            usage: {
              eventId: 'output-settlement-usage',
              batchIndex: 0,
              batchCount: 1,
              costUSD: 0.01,
              inputTokens: 1,
              outputTokens: 1,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              reasoningTokens: 0,
              durationMs: 1,
              numTurns: 1,
              modelUsage: {},
            },
          },
        };
        await onOutput(frame);
        return frame;
      },
    );

    try {
      await executeExternalCapabilityClaimForTest(claim(), {
        tryAcquireContainerSlot: () => vi.fn(),
        adoptContainerSlot: () => vi.fn(),
      });

      expect(mocks.publishAcknowledgement).toHaveBeenCalledOnce();
      expect(mocks.storeArtifact).toHaveBeenCalledOnce();
      expect(mocks.deleteArtifact).toHaveBeenCalledWith(
        root,
        'ecv1:run-1:result-test',
      );
      expect(mocks.releaseStorage).toHaveBeenCalledWith(
        'output-storage-reservation',
      );
      expect(mocks.quarantineStorage).not.toHaveBeenCalledWith(
        'output-storage-reservation',
      );
      expect(mocks.completeRun).toHaveBeenCalledWith(
        'run-1',
        'worker-1',
        1,
        expect.objectContaining({
          status: 'failed',
          providerCostDisposition: 'settled',
        }),
      );
    } finally {
      mocks.reserveStorage.mockReset();
      mocks.reserveStorage.mockReturnValue('test-storage-reservation');
      mocks.settleStorage.mockReset();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('settles execution while persistent Docker failure keeps shared capacity fenced', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'external-capacity-test-'),
    );
    mocks.getVaultRoot.mockReturnValueOnce(root);
    mocks.releaseForRetry.mockClear();
    mocks.completeRun.mockClear();
    mocks.runContainerAgent.mockClear();
    mocks.execFile.mockReset();
    mocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(new Error('docker unavailable'), ''),
    );
    const release = vi.fn();
    const kill = vi.fn();
    mocks.runContainerAgent.mockImplementationOnce(
      async (
        _group: unknown,
        input: {
          externalExecution: {
            onProtocolFailure: (error: Error, retryable: boolean) => void;
          };
        },
        onSpawn: (container: unknown, containerName: string) => void,
      ) => {
        onSpawn({ kill }, 'happyclaw-external-stuck-run-1-1');
        input.externalExecution.onProtocolFailure(
          new Error('invalid runner protocol'),
          false,
        );
        return { status: 'error', result: null };
      },
    );

    await executeExternalCapabilityClaimForTest(claim(), {
      tryAcquireContainerSlot: () => release,
      adoptContainerSlot: () => vi.fn(),
    });

    expect(mocks.runContainerAgent).toHaveBeenCalledOnce();
    expect(countActiveExternalContainerExecutionsForTest()).toBe(0);
    expect(countPendingExternalContainerCleanupsForTest()).toBe(1);
    expect(release).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith('SIGKILL');

    await expect(
      reconcileExternalCapabilityContainersForTest({
        runDockerCommand: async (args) => {
          if (args.includes('{{.Names}}')) return { ok: true, stdout: '' };
          if (args[0] === 'container') return { ok: true, stdout: '' };
          return { ok: false, stdout: '' };
        },
        wait: async () => {},
        inspectContainerLabels: async () => null,
        fenceLease: () => 'stale',
      }),
    ).resolves.toMatchObject({ unverified: 0 });

    expect(countPendingExternalContainerCleanupsForTest()).toBe(0);
    expect(release).toHaveBeenCalledOnce();
    fs.rmSync(root, { recursive: true, force: true });
  }, 10_000);
});
