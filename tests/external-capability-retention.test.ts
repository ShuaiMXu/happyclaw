import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'external-retention-'));
const storeDir = path.join(root, 'store');
const dataDir = path.join(root, 'data');
const vaultRoot = path.join(root, 'vault');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { runExternalCapabilityRetention } =
  await import('../src/external-capability-retention.js');
function runRetention(
  options: Parameters<typeof runExternalCapabilityRetention>[0],
) {
  return runExternalCapabilityRetention({
    ...options,
    verifyRunContainerAbsent: async () => true,
  });
}
const { storeExternalCapabilityArtifact } =
  await import('../src/external-capability-storage.js');

let defaultKeyId = '';
beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'external-retention-owner',
    username: 'external-retention-owner',
    password_hash: 'hash',
    display_name: 'External retention owner',
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
  db.setRegisteredGroup('web:6241df8f-b015-472e-9083-6c4ec31eedc1', {
    name: 'External capability workspace',
    folder: 'flow-munrwfg2-u6u8',
    added_at: now,
    executionMode: 'container',
    created_by: 'external-retention-owner',
  });
  db.setExternalCapabilityStatus('quote-document-process', 'active');
  defaultKeyId = db.createExternalCapabilityKey({
    capabilitySlug: 'quote-document-process',
    label: 'retention default',
  }).key.id;
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

let sequence = 0;
function createRun(availableAt?: string) {
  sequence += 1;
  return db.createExternalCapabilityRun({
    capabilitySlug: 'quote-document-process',
    keyId: defaultKeyId,
    externalTaskId: `retention-task-${sequence}`,
    idempotencyKey: `retention-key-${sequence}`,
    inputManifest: { version: 1 },
    availableAt,
  }).run;
}

function createPlannedIntake(runId: string, intakeReservationTtlMs: number) {
  sequence += 1;
  const reserved = db.reserveExternalCapabilityIntake({
    capabilitySlug: 'quote-document-process',
    keyId: defaultKeyId,
    reservedRawBytes: 1024,
    limits: {
      globalIntakeRequests: 1_000_000,
      capabilityIntakeRequests: 1_000_000,
      keyIntakeRequests: 1_000_000,
      globalIntakeBytes: Number.MAX_SAFE_INTEGER,
      capabilityIntakeBytes: Number.MAX_SAFE_INTEGER,
      keyIntakeBytes: Number.MAX_SAFE_INTEGER,
      keyIntakeAttemptsPerMinute: 1_000_000,
      keyIngressBytesPerDay: Number.MAX_SAFE_INTEGER,
      intakeReservationTtlMs,
    },
  });
  expect(reserved.admitted).toBe(true);
  if (!reserved.admitted) throw new Error('Expected intake admission');
  expect(
    db.preflightExternalCapabilityRunSubmission({
      capabilitySlug: 'quote-document-process',
      keyId: defaultKeyId,
      externalTaskId: `retention-intake-task-${sequence}`,
      idempotencyKey: `retention-intake-key-${sequence}`,
      requestFingerprint: 'a'.repeat(64),
      plannedRunId: runId,
      intakeReservation: {
        id: reserved.reservation.id,
        leaseToken: reserved.reservation.lease_token,
        observedRawBytes: 1024,
      },
    }),
  ).toEqual({ existing: false });
  return reserved.reservation;
}

function reservePlannedInputStorage(runId: string): string {
  const reservationKey = `retention-planned-input-${runId}`;
  expect(
    db.reserveExternalCapabilityStorage({
      reservationKey,
      runId,
      kind: 'input',
      objectKey: 'run-artifacts',
      reservedBytes: 1024,
      filesystemAvailableBytes: Number.MAX_SAFE_INTEGER,
      filesystemSafetyReserveBytes: 0,
      logicalLimitBytes: Number.MAX_SAFE_INTEGER,
    }).admitted,
  ).toBe(true);
  return reservationKey;
}

function createArtifact(runId: string): void {
  storeExternalCapabilityArtifact(vaultRoot, {
    runId,
    artifactId: `artifact-${sequence}`,
    bytes: Buffer.from('private'),
  });
}

function createRuntime(runId: string): string {
  const runtimeName = `${runId}-A${String(sequence).padStart(5, '0')}`;
  fs.mkdirSync(path.join(vaultRoot, 'runtime', runtimeName), {
    recursive: true,
    mode: 0o700,
  });
  return runtimeName;
}

function completeRun(status: 'succeeded' | 'failed' | 'cancelled') {
  const run = createRun();
  createArtifact(run.id);
  const runtimeName = createRuntime(run.id);
  const claim = db.claimNextExternalCapabilityRun('retention-test', 60_000)!;
  expect(claim.id).toBe(run.id);
  const settled =
    status === 'succeeded'
      ? db.completeExternalCapabilityRun(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          { status, result: { format: 'xlsx' } },
        )
      : db.completeExternalCapabilityRun(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          status === 'failed'
            ? {
                status,
                error: { code: 'TEST_FAILURE', message: 'safe failure' },
              }
            : { status },
        );
  expect(settled).toBe(true);
  return { run, runtimeName };
}

const FUTURE_NOW = new Date(Date.now() + 48 * 60 * 60_000);
const RETENTION_MS = 24 * 60 * 60_000;

describe('external capability retention', () => {
  test('scrubs terminal rows while deleting private durable and runtime data', async () => {
    const completed = [
      completeRun('succeeded'),
      completeRun('failed'),
      completeRun('cancelled'),
    ];
    fs.utimesSync(
      path.join(vaultRoot, 'runtime', completed[0]!.runtimeName),
      FUTURE_NOW,
      FUTURE_NOW,
    );

    let cleanupResolved = false;
    const cleanup = runRetention({
      now: FUTURE_NOW,
      retentionMs: RETENTION_MS,
      vaultRoot,
      runBatchSize: 1,
    }).finally(() => {
      cleanupResolved = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cleanupResolved).toBe(false);
    const result = await cleanup;

    expect(result).toMatchObject({ sanitizedRuns: 3, errors: 0 });
    for (const { run, runtimeName } of completed) {
      const sanitized = db.getExternalCapabilityRunById(run.id)!;
      expect(sanitized).toMatchObject({
        id: run.id,
        status: expect.any(String),
        tenant_ref: null,
        account_ref: null,
        callback_context: null,
        retention_cleaned_at: expect.any(String),
        result: null,
        error_message: null,
        input_manifest: {
          retentionTombstone: true,
          retainedInputBytes: 0,
        },
      });
      expect(sanitized.retention_cleaned_at).toBe(
        sanitized.input_manifest.cleanedAt,
      );
      expect(fs.existsSync(path.join(vaultRoot, 'runs', run.id))).toBe(false);
      expect(fs.existsSync(path.join(vaultRoot, 'runtime', runtimeName))).toBe(
        false,
      );
    }

    const original = completed[0]!.run;
    const replay = db.createExternalCapabilityRun({
      capabilitySlug: original.capability_slug,
      keyId: original.key_id,
      externalTaskId: original.external_task_id,
      idempotencyKey: original.idempotency_key,
      inputManifest: { version: 1 },
    });
    expect(replay).toMatchObject({
      created: false,
      reason: 'duplicate',
      run: { id: original.id },
    });
  });

  test('releases durable Vault bytes only after physical retention cleanup', async () => {
    const run = createRun();
    const reservationKey = `retention-storage-${run.id}`;
    expect(
      db.reserveExternalCapabilityStorage({
        reservationKey,
        runId: run.id,
        kind: 'input',
        objectKey: 'run-artifacts',
        reservedBytes: 7,
        filesystemAvailableBytes: Number.MAX_SAFE_INTEGER,
        filesystemSafetyReserveBytes: 0,
        logicalLimitBytes: Number.MAX_SAFE_INTEGER,
      }).admitted,
    ).toBe(true);
    createArtifact(run.id);
    expect(db.settleExternalCapabilityStorage(reservationKey, 7)).toBe(true);
    const claim = db.claimNextExternalCapabilityRun(
      'retention-storage-release',
      60_000,
    )!;
    expect(claim.id).toBe(run.id);
    expect(
      db.completeExternalCapabilityRun(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        { status: 'cancelled' },
      ),
    ).toBe(true);

    expect(
      await runRetention({
        now: FUTURE_NOW,
        retentionMs: RETENTION_MS,
        vaultRoot,
      }),
    ).toMatchObject({
      sanitizedRuns: 1,
      deletedReleasedStorageReservations: expect.any(Number),
      errors: 0,
    });
    expect(
      db.getExternalCapabilityStorageReservationForTest(reservationKey),
    ).toBeUndefined();
  });

  test('purges released storage history only after the owning run is retention-cleaned', async () => {
    const run = createRun();
    const reservationKey = `retention-gc-lifecycle-${run.id}`;
    expect(
      db.reserveExternalCapabilityStorage({
        reservationKey,
        runId: run.id,
        kind: 'input',
        objectKey: 'run-artifacts',
        reservedBytes: 1,
        filesystemAvailableBytes: Number.MAX_SAFE_INTEGER,
        filesystemSafetyReserveBytes: 0,
        logicalLimitBytes: Number.MAX_SAFE_INTEGER,
      }).admitted,
    ).toBe(true);
    expect(db.releaseExternalCapabilityStorage(reservationKey)).toBe(true);
    const purgeCutoff = new Date(Date.now() + 60_000).toISOString();
    expect(
      db.purgeReleasedExternalCapabilityStorageReservations(purgeCutoff),
    ).toBe(0);
    expect(
      db.getExternalCapabilityStorageReservationForTest(reservationKey),
    ).toMatchObject({ state: 'released' });

    const claim = db.claimNextExternalCapabilityRun(
      'retention-storage-gc-lifecycle',
      60_000,
    )!;
    expect(claim.id).toBe(run.id);
    expect(
      db.completeExternalCapabilityRun(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        { status: 'cancelled' },
      ),
    ).toBe(true);
    expect(
      await runRetention({
        now: FUTURE_NOW,
        retentionMs: RETENTION_MS,
        vaultRoot,
      }),
    ).toMatchObject({ sanitizedRuns: 1, errors: 0 });
    expect(
      db.getExternalCapabilityStorageReservationForTest(reservationKey),
    ).toBeUndefined();
  });

  test('keeps an aged pre-write reservation without durable producer lifecycle evidence', async () => {
    const runId = crypto.randomUUID();
    const reservationKey = `retention-prewrite-${runId}`;
    expect(
      db.reserveExternalCapabilityStorage({
        reservationKey,
        runId,
        kind: 'input',
        objectKey: 'run-artifacts',
        reservedBytes: 1024,
        filesystemAvailableBytes: Number.MAX_SAFE_INTEGER,
        filesystemSafetyReserveBytes: 0,
        logicalLimitBytes: Number.MAX_SAFE_INTEGER,
        now: new Date(Date.now() - 48 * 60 * 60_000).toISOString(),
      }).admitted,
    ).toBe(true);

    expect(
      await runRetention({
        now: new Date(),
        retentionMs: RETENTION_MS,
        vaultRoot,
      }),
    ).toMatchObject({ errors: 0 });
    expect(
      db.getExternalCapabilityStorageReservationForTest(reservationKey),
    ).toMatchObject({ state: 'reserved' });
  });

  test('keeps a missing planned input reservation while its intake lease is live', async () => {
    const runId = crypto.randomUUID();
    createPlannedIntake(runId, 24 * 60 * 60_000);
    const reservationKey = reservePlannedInputStorage(runId);

    expect(
      await runRetention({
        now: new Date(Date.now() + 2 * 60 * 60_000),
        retentionMs: 60 * 60_000,
        vaultRoot,
      }),
    ).toMatchObject({ errors: 0 });
    expect(
      db.getExternalCapabilityStorageReservationForTest(reservationKey),
    ).toMatchObject({ state: 'reserved' });
  });

  test('releases a missing planned input reservation after its intake lease expires', async () => {
    const runId = crypto.randomUUID();
    createPlannedIntake(runId, 60 * 60_000);
    const reservationKey = reservePlannedInputStorage(runId);

    expect(
      await runRetention({
        now: FUTURE_NOW,
        retentionMs: RETENTION_MS,
        vaultRoot,
      }),
    ).toMatchObject({ errors: 0 });
    expect(
      db.getExternalCapabilityStorageReservationForTest(reservationKey),
    ).toMatchObject({ state: 'released' });
  });

  test('releases a missing planned input reservation after intake failure', async () => {
    const runId = crypto.randomUUID();
    const intake = createPlannedIntake(runId, 24 * 60 * 60_000);
    const reservationKey = reservePlannedInputStorage(runId);
    expect(
      db.finishExternalCapabilityIntake({
        id: intake.id,
        leaseToken: intake.lease_token,
        outcome: 'failed',
        observedRawBytes: 1024,
      }),
    ).toBe(true);

    expect(
      await runRetention({
        now: FUTURE_NOW,
        retentionMs: RETENTION_MS,
        vaultRoot,
      }),
    ).toMatchObject({ errors: 0 });
    expect(
      db.getExternalCapabilityStorageReservationForTest(reservationKey),
    ).toMatchObject({ state: 'released' });
  });

  test('keeps a planned input reservation while its artifact tree exists', async () => {
    const runId = crypto.randomUUID();
    const intake = createPlannedIntake(runId, 24 * 60 * 60_000);
    const reservationKey = reservePlannedInputStorage(runId);
    createArtifact(runId);
    fs.utimesSync(path.join(vaultRoot, 'runs', runId), FUTURE_NOW, FUTURE_NOW);
    expect(
      db.finishExternalCapabilityIntake({
        id: intake.id,
        leaseToken: intake.lease_token,
        outcome: 'failed',
        observedRawBytes: 1024,
      }),
    ).toBe(true);

    expect(
      await runRetention({
        now: FUTURE_NOW,
        retentionMs: RETENTION_MS,
        vaultRoot,
      }),
    ).toMatchObject({ errors: 0 });
    expect(
      db.getExternalCapabilityStorageReservationForTest(reservationKey),
    ).toMatchObject({ state: 'reserved' });
  });

  test('releases a missing runtime reservation only after lifecycle and Docker absence are verified', async () => {
    const run = createRun();
    const runtimeName = `${run.id}-a1-l1-ABC123`;
    const reservationKey = `retention-runtime-prewrite-${run.id}`;
    expect(
      db.reserveExternalCapabilityStorage({
        reservationKey,
        runId: run.id,
        kind: 'runtime',
        objectKey: runtimeName,
        reservedBytes: 1024,
        filesystemAvailableBytes: Number.MAX_SAFE_INTEGER,
        filesystemSafetyReserveBytes: 0,
        logicalLimitBytes: Number.MAX_SAFE_INTEGER,
        now: new Date(Date.now() - 48 * 60 * 60_000).toISOString(),
      }).admitted,
    ).toBe(true);
    const verifyRunContainerAbsent = vi.fn(async () => false);

    expect(
      await runExternalCapabilityRetention({
        now: new Date(),
        retentionMs: RETENTION_MS,
        vaultRoot,
        verifyRunContainerAbsent,
      }),
    ).toMatchObject({ errors: 0 });
    expect(verifyRunContainerAbsent).toHaveBeenCalledWith(run.id);
    expect(
      db.getExternalCapabilityStorageReservationForTest(reservationKey),
    ).toMatchObject({ state: 'reserved' });

    expect(
      await runRetention({
        now: new Date(),
        retentionMs: RETENTION_MS,
        vaultRoot,
      }),
    ).toMatchObject({ errors: 0 });
    expect(
      db.getExternalCapabilityStorageReservationForTest(reservationKey),
    ).toMatchObject({ state: 'released' });

    const claim = db.claimNextExternalCapabilityRun(
      'retention-runtime-reservation-test',
      60_000,
    )!;
    expect(claim.id).toBe(run.id);
    expect(
      db.completeExternalCapabilityRun(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        { status: 'cancelled' },
      ),
    ).toBe(true);
    expect(
      await runRetention({
        now: FUTURE_NOW,
        retentionMs: RETENTION_MS,
        vaultRoot,
      }),
    ).toMatchObject({ sanitizedRuns: 1, errors: 0 });
  });

  test('retries ledger release after files were already deleted', async () => {
    const completed = completeRun('succeeded');
    const reservationKey = `retention-retry-${completed.run.id}`;
    expect(
      db.reserveExternalCapabilityStorage({
        reservationKey,
        runId: completed.run.id,
        kind: 'input',
        objectKey: 'run-artifacts',
        reservedBytes: 7,
        filesystemAvailableBytes: Number.MAX_SAFE_INTEGER,
        filesystemSafetyReserveBytes: 0,
        logicalLimitBytes: Number.MAX_SAFE_INTEGER,
      }).admitted,
    ).toBe(true);
    expect(db.settleExternalCapabilityStorage(reservationKey, 7)).toBe(true);

    const first = await runExternalCapabilityRetention({
      now: FUTURE_NOW,
      retentionMs: RETENTION_MS,
      vaultRoot,
      verifyRunContainerAbsent: async () => true,
      releaseRunStorage: () => {
        throw new Error('injected storage-ledger failure');
      },
    });
    expect(first).toMatchObject({ sanitizedRuns: 0, errors: 1 });
    expect(fs.existsSync(path.join(vaultRoot, 'runs', completed.run.id))).toBe(
      false,
    );
    expect(
      db.getExternalCapabilityStorageReservationForTest(reservationKey),
    ).toMatchObject({ state: 'occupied' });
    expect(
      db.getExternalCapabilityRunById(completed.run.id)?.retention_cleaned_at,
    ).toBeNull();

    expect(
      await runRetention({
        now: FUTURE_NOW,
        retentionMs: RETENTION_MS,
        vaultRoot,
      }),
    ).toMatchObject({
      sanitizedRuns: 1,
      deletedReleasedStorageReservations: expect.any(Number),
      errors: 0,
    });
    expect(
      db.getExternalCapabilityStorageReservationForTest(reservationKey),
    ).toBeUndefined();
  });

  test('preserves private request-context equality after tombstoning', async () => {
    sequence += 1;
    const externalTaskId = `retention-context-task-${sequence}`;
    const idempotencyKey = `retention-context-key-${sequence}`;
    const inputManifest = { version: 1, operation: 'context-receipt' };
    const callbackContext = { requestId: 'callback-1', notify: true };
    const created = db.createExternalCapabilityRun({
      capabilitySlug: 'quote-document-process',
      keyId: defaultKeyId,
      externalTaskId,
      idempotencyKey,
      tenantRef: 'tenant-1',
      accountRef: 'account-1',
      callbackContext,
      inputManifest,
    });
    expect(created.created).toBe(true);
    const claim = db.claimNextExternalCapabilityRun(
      'retention-context-test',
      60_000,
    )!;
    expect(claim.id).toBe(created.run.id);
    expect(
      db.completeExternalCapabilityRun(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        { status: 'cancelled' },
      ),
    ).toBe(true);

    expect(
      await runRetention({
        now: FUTURE_NOW,
        retentionMs: RETENTION_MS,
        vaultRoot,
      }),
    ).toMatchObject({ sanitizedRuns: 1, errors: 0 });
    const tombstone = db.getExternalCapabilityRunById(created.run.id)!;
    expect(tombstone).toMatchObject({
      tenant_ref: null,
      account_ref: null,
      callback_context: null,
      input_manifest: {
        retentionTombstone: true,
        requestContextSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });

    const replay = (
      overrides: {
        tenantRef?: string;
        accountRef?: string;
        callbackContext?: Record<string, unknown>;
      } = {},
    ) =>
      db.createExternalCapabilityRun({
        capabilitySlug: 'quote-document-process',
        keyId: defaultKeyId,
        externalTaskId,
        idempotencyKey,
        tenantRef: overrides.tenantRef ?? 'tenant-1',
        accountRef: overrides.accountRef ?? 'account-1',
        callbackContext: overrides.callbackContext ?? callbackContext,
        inputManifest,
      });

    expect(replay()).toMatchObject({
      created: false,
      reason: 'duplicate',
      run: { id: created.run.id },
    });
    expect(replay({ tenantRef: 'tenant-2' })).toMatchObject({
      created: false,
      reason: 'conflict',
    });
    expect(replay({ accountRef: 'account-2' })).toMatchObject({
      created: false,
      reason: 'conflict',
    });
    expect(
      replay({ callbackContext: { requestId: 'callback-2', notify: true } }),
    ).toMatchObject({ created: false, reason: 'conflict' });
  });

  test('includes terminal runs and orphan directories exactly at the cutoff', async () => {
    const completed = completeRun('succeeded');
    const completedAt = db.getExternalCapabilityRunById(
      completed.run.id,
    )!.completed_at!;
    const terminalNow = new Date(Date.parse(completedAt) + RETENTION_MS);

    const terminalResult = await runRetention({
      now: terminalNow,
      retentionMs: RETENTION_MS,
      vaultRoot,
    });

    expect(terminalResult).toMatchObject({
      sanitizedRuns: 1,
      deletedRuntimeDirectories: 1,
      errors: 0,
    });
    expect(
      db.getExternalCapabilityRunById(completed.run.id)?.retention_cleaned_at,
    ).not.toBeNull();

    const cutoffMs = Math.floor(Date.now() / 1_000) * 1_000;
    const orphanRunId = crypto.randomUUID();
    createArtifact(orphanRunId);
    const orphanRuntime = createRuntime(orphanRunId);
    const cutoff = new Date(cutoffMs);
    fs.utimesSync(path.join(vaultRoot, 'runs', orphanRunId), cutoff, cutoff);
    fs.utimesSync(
      path.join(vaultRoot, 'runtime', orphanRuntime),
      cutoff,
      cutoff,
    );

    const orphanResult = await runRetention({
      now: new Date(cutoffMs + RETENTION_MS),
      retentionMs: RETENTION_MS,
      vaultRoot,
    });

    expect(orphanResult).toMatchObject({
      deletedOrphanRunDirectories: 1,
      deletedRuntimeDirectories: 1,
      errors: 0,
    });
    expect(fs.existsSync(path.join(vaultRoot, 'runs', orphanRunId))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(vaultRoot, 'runtime', orphanRuntime))).toBe(
      false,
    );
  });

  test('retries terminal runtime cleanup before artifact retention expires', async () => {
    const completed = completeRun('succeeded');

    const result = await runRetention({
      now: new Date(),
      retentionMs: RETENTION_MS,
      vaultRoot,
    });

    expect(result).toMatchObject({
      sanitizedRuns: 0,
      deletedRuntimeDirectories: 1,
      errors: 0,
    });
    expect(
      fs.existsSync(path.join(vaultRoot, 'runtime', completed.runtimeName)),
    ).toBe(false);
    expect(fs.existsSync(path.join(vaultRoot, 'runs', completed.run.id))).toBe(
      true,
    );
    expect(
      db.getExternalCapabilityRunById(completed.run.id)?.retention_cleaned_at,
    ).toBeNull();

    await runRetention({
      now: FUTURE_NOW,
      retentionMs: RETENTION_MS,
      vaultRoot,
    });
  });

  test('keeps private data and the database row when container absence is unverified', async () => {
    const completed = completeRun('succeeded');

    const result = await runExternalCapabilityRetention({
      now: FUTURE_NOW,
      retentionMs: RETENTION_MS,
      vaultRoot,
      verifyRunContainerAbsent: async () => false,
    });

    expect(result).toMatchObject({
      sanitizedRuns: 0,
      deletedRuntimeDirectories: 0,
      errors: 1,
    });
    expect(
      db.getExternalCapabilityRunById(completed.run.id)?.retention_cleaned_at,
    ).toBeNull();
    expect(fs.existsSync(path.join(vaultRoot, 'runs', completed.run.id))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(vaultRoot, 'runtime', completed.runtimeName)),
    ).toBe(true);

    expect(
      await runRetention({
        now: FUTURE_NOW,
        retentionMs: RETENTION_MS,
        vaultRoot,
      }),
    ).toMatchObject({ sanitizedRuns: 1, deletedRuntimeDirectories: 1 });
  });

  test('keeps runtime data while an in-flight Docker create reservation is live', async () => {
    const run = createRun();
    createArtifact(run.id);
    const runtimeName = createRuntime(run.id);
    const claim = db.claimNextExternalCapabilityRun(
      'retention-live-create',
      60_000,
    )!;
    expect(claim.id).toBe(run.id);
    expect(
      db.markExternalCapabilityRunContainerCleanupRequired(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        claim.attempt,
      ),
    ).toBe(true);
    const pendingUntil = db.reserveExternalCapabilityRunContainerCreation(
      claim.id,
      claim.lease_owner,
      claim.lease_token,
      claim.attempt,
      60_000,
      45_000,
    );
    expect(pendingUntil).not.toBeNull();
    expect(
      db.cancelExternalCapabilityRun(run.capability_slug, run.key_id, run.id)
        ?.cancelled,
    ).toBe(true);
    const verifyRunContainerAbsent = vi.fn(async () => true);

    const result = await runExternalCapabilityRetention({
      now: new Date(),
      retentionMs: 0,
      vaultRoot,
      verifyRunContainerAbsent,
    });

    expect(result).toMatchObject({
      sanitizedRuns: 0,
      deletedRuntimeDirectories: 0,
      errors: 0,
    });
    expect(verifyRunContainerAbsent).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(vaultRoot, 'runtime', runtimeName))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(vaultRoot, 'runs', run.id))).toBe(true);
    expect(
      db.finishExternalCapabilityRunContainerCreation(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        claim.attempt,
        pendingUntil!,
        60_000,
      ),
    ).toBe(false);
    expect(
      db.clearExternalCapabilityRunContainerCleanupAfterVerifiedAbsence(
        run.id,
        claim.attempt,
        claim.lease_token,
      ),
    ).toBe(true);
    expect(
      await runRetention({
        now: FUTURE_NOW,
        retentionMs: RETENTION_MS,
        vaultRoot,
      }),
    ).toMatchObject({
      sanitizedRuns: 1,
      deletedRuntimeDirectories: 1,
      errors: 0,
    });
  });

  test('reconciles an expired Docker create reservation before deleting private data', async () => {
    const run = createRun();
    createArtifact(run.id);
    const runtimeName = createRuntime(run.id);
    const claim = db.claimNextExternalCapabilityRun(
      'retention-expired-create',
      60_000,
    )!;
    expect(claim.id).toBe(run.id);
    expect(
      db.markExternalCapabilityRunContainerCleanupRequired(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        claim.attempt,
      ),
    ).toBe(true);
    expect(
      db.reserveExternalCapabilityRunContainerCreation(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        claim.attempt,
        60_000,
        1,
      ),
    ).not.toBeNull();
    expect(
      db.cancelExternalCapabilityRun(run.capability_slug, run.key_id, run.id)
        ?.cancelled,
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const verifyRunContainerAbsent = vi.fn(async (runId: string) =>
      db.clearExternalCapabilityRunContainerCleanupAfterVerifiedAbsence(
        runId,
        claim.attempt,
        claim.lease_token,
      ),
    );

    const result = await runExternalCapabilityRetention({
      now: FUTURE_NOW,
      retentionMs: RETENTION_MS,
      vaultRoot,
      verifyRunContainerAbsent,
    });

    expect(result).toMatchObject({
      sanitizedRuns: 1,
      deletedRuntimeDirectories: 1,
      errors: 0,
    });
    expect(verifyRunContainerAbsent).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(vaultRoot, 'runtime', runtimeName))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(vaultRoot, 'runs', run.id))).toBe(false);
    expect(db.getExternalCapabilityRunById(run.id)).toMatchObject({
      container_cleanup_attempt: null,
      container_cleanup_lease_token: null,
      container_create_pending_until: null,
      retention_cleaned_at: expect.any(String),
    });
  });

  test('retries stale runtime cleanup for unclaimed work without deleting durable input', async () => {
    const running = createRun();
    createArtifact(running.id);
    const runningRuntime = createRuntime(running.id);
    const runningClaim = db.claimNextExternalCapabilityRun(
      'retention-running',
      60_000,
    )!;
    expect(runningClaim.id).toBe(running.id);

    const retry = createRun();
    createArtifact(retry.id);
    const retryRuntime = createRuntime(retry.id);
    const retryClaim = db.claimNextExternalCapabilityRun(
      'retention-retry',
      60_000,
    )!;
    expect(retryClaim.id).toBe(retry.id);
    expect(
      db.releaseExternalCapabilityRunForRetry(
        retryClaim.id,
        retryClaim.lease_owner,
        retryClaim.lease_token,
        new Date(Date.now() + 60_000).toISOString(),
        { code: 'RETRY', message: 'retry later' },
      ),
    ).toBe(true);

    const queued = createRun(new Date(Date.now() + 60_000).toISOString());
    createArtifact(queued.id);
    const queuedRuntime = createRuntime(queued.id);

    const result = await runRetention({
      now: FUTURE_NOW,
      retentionMs: RETENTION_MS,
      vaultRoot,
    });

    expect(result).toMatchObject({
      sanitizedRuns: 0,
      deletedRuntimeDirectories: 2,
      errors: 0,
    });
    for (const run of [running, retry, queued]) {
      expect(db.getExternalCapabilityRunById(run.id)).toBeDefined();
      expect(fs.existsSync(path.join(vaultRoot, 'runs', run.id))).toBe(true);
      expect(
        db.sanitizeExternalCapabilityRunForRetention(
          run.id,
          FUTURE_NOW.toISOString(),
        ),
      ).toBe(false);
    }
    expect(fs.existsSync(path.join(vaultRoot, 'runtime', runningRuntime))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(vaultRoot, 'runtime', retryRuntime))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(vaultRoot, 'runtime', queuedRuntime))).toBe(
      false,
    );
  });

  test('removes only old strictly named orphan directories and is idempotent', async () => {
    const oldRunId = crypto.randomUUID();
    createArtifact(oldRunId);
    const oldRuntime = createRuntime(oldRunId);
    const old = new Date(Date.now() - 48 * 60 * 60_000);
    fs.utimesSync(path.join(vaultRoot, 'runs', oldRunId), old, old);
    fs.utimesSync(path.join(vaultRoot, 'runtime', oldRuntime), old, old);

    const freshRunId = crypto.randomUUID();
    createArtifact(freshRunId);
    const unknown = path.join(vaultRoot, 'runtime', 'unknown');
    fs.mkdirSync(unknown, { recursive: true });

    const first = await runRetention({
      now: new Date(),
      retentionMs: RETENTION_MS,
      vaultRoot,
    });
    expect(first).toMatchObject({
      deletedOrphanRunDirectories: 1,
      deletedRuntimeDirectories: 1,
      errors: 0,
    });
    expect(fs.existsSync(path.join(vaultRoot, 'runs', oldRunId))).toBe(false);
    expect(fs.existsSync(path.join(vaultRoot, 'runtime', oldRuntime))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(vaultRoot, 'runs', freshRunId))).toBe(true);
    expect(fs.existsSync(unknown)).toBe(true);

    expect(
      await runRetention({
        now: new Date(),
        retentionMs: RETENTION_MS,
        vaultRoot,
      }),
    ).toMatchObject({
      sanitizedRuns: 0,
      deletedOrphanRunDirectories: 0,
      deletedRuntimeDirectories: 0,
      errors: 0,
    });
  });
});
