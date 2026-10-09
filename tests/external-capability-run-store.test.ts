import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'external-run-store-'));
const storeDir = path.join(root, 'store');
const dataDir = path.join(root, 'data');
const databasePath = path.join(storeDir, 'messages.db');
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

const CAPABILITY_WORKSPACE_JID = 'web:6241df8f-b015-472e-9083-6c4ec31eedc1';
let defaultKeyId = '';
beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'external-run-owner',
    username: 'external-run-owner',
    password_hash: 'hash',
    display_name: 'External run owner',
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
  db.setRegisteredGroup(CAPABILITY_WORKSPACE_JID, {
    name: 'External capability workspace',
    folder: 'flow-munrwfg2-u6u8',
    added_at: now,
    executionMode: 'container',
    created_by: 'external-run-owner',
  });
  db.setExternalCapabilityStatus('quote-document-process', 'active');
  defaultKeyId = db.createExternalCapabilityKey({
    capabilitySlug: 'quote-document-process',
    label: 'run-store default',
  }).key.id;
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

let sequence = 0;
function createRun(keyId = defaultKeyId) {
  sequence += 1;
  return db.createExternalCapabilityRun({
    capabilitySlug: 'quote-document-process',
    keyId,
    externalTaskId: `t2_task_${sequence}`,
    idempotencyKey: `idempotency_${sequence}`,
    tenantRef: `tenant_${sequence}`,
    accountRef: `account_${sequence}`,
    callbackContext: { schemaVersion: '1', source: 't2_quote_analyze' },
    inputManifest: {
      schemaVersion: 1,
      files: [
        {
          id: `file_${sequence}`,
          storageRef: `ecv1:run_${sequence}:file_${sequence}`,
          detectedMimeType: 'application/pdf',
          byteLength: 12,
          sha256: 'a'.repeat(64),
        },
      ],
    },
  });
}

describe('external capability durable run persistence', () => {
  test('fences crash-stale future producer leases before a Vault census', () => {
    const blockedValue = 'blocked:11111111-1111-4111-8111-111111111111';
    const physicalIdentity = `v2:${'f'.repeat(64)}`;
    try {
      const intake = db.reserveExternalCapabilityIntake({
        capabilitySlug: 'quote-document-process',
        keyId: defaultKeyId,
        reservedRawBytes: 1024,
        limits: {
          globalIntakeLimit: 100,
          capabilityIntakeLimit: 100,
          keyIntakeLimit: 100,
          globalIntakeBytes: 1_000_000,
          capabilityIntakeBytes: 1_000_000,
          keyIntakeBytes: 1_000_000,
          keyIntakeAttemptsPerMinute: 1_000,
          keyIngressBytesPerDay: 1_000_000,
          intakeReservationTtlMs: 60 * 60_000,
        },
      });
      expect(intake.admitted).toBe(true);
      if (!intake.admitted) throw new Error('Expected intake admission');

      const created = createRun();
      const claim = db.claimNextExternalCapabilityRun(
        'future-lease-before-census',
        60 * 60_000,
      )!;
      expect(claim.id).toBe(created.run.id);
      expect(
        db.markExternalCapabilityRunExecutionStarted(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
        ),
      ).toBe(true);

      db.beginExternalCapabilityVaultCensus(blockedValue, physicalIdentity);

      expect(
        db.getExternalCapabilityIntakeReservationForTest(intake.reservation.id),
      ).toMatchObject({ state: 'finished', outcome: 'expired' });
      expect(
        db.renewExternalCapabilityIntake(
          intake.reservation.id,
          intake.reservation.lease_token,
          60_000,
        ),
      ).toBe(false);
      expect(db.getExternalCapabilityRunById(claim.id)).toMatchObject({
        status: 'running',
        lease_owner: null,
        lease_expires_at: null,
        lease_token: claim.lease_token + 1,
        error_code: 'START_RECOVERY_PENDING',
        container_create_pending_until: null,
      });
      expect(
        db.backfillExternalCapabilityStorageOccupancy({
          markerKey: db.EXTERNAL_CAPABILITY_VAULT_CENSUS_STATE_KEY,
          markerValue: physicalIdentity,
          occupancies: [],
          blockedValue,
        }),
      ).toMatchObject({ alreadyComplete: false });
      expect(
        db.resolveExternalCapabilityRunStartRecovery(claim.id, false),
      ).toBe(true);
    } finally {
      db.deleteRouterState(db.EXTERNAL_CAPABILITY_VAULT_CENSUS_STATE_KEY);
      db.deleteRouterState(db.EXTERNAL_CAPABILITY_VAULT_PHYSICAL_IDENTITY_KEY);
    }
  });

  test('creates a typed durable record with opaque caller labels', () => {
    const created = createRun();
    expect(created.created).toBe(true);
    expect(created.run).toMatchObject({
      capability_slug: 'quote-document-process',
      status: 'queued',
      attempt: 0,
      external_task_id: `t2_task_${sequence}`,
      tenant_ref: `tenant_${sequence}`,
      account_ref: `account_${sequence}`,
      result: null,
      error_code: null,
      error_message: null,
    });
    expect(created.run.input_manifest).toMatchObject({ schemaVersion: 1 });
    expect(created.run.callback_context).toEqual({
      schemaVersion: '1',
      source: 't2_quote_analyze',
    });
    const claim = db.claimNextExternalCapabilityRun('cleanup', 60_000)!;
    expect(claim.id).toBe(created.run.id);
    expect(
      db.completeExternalCapabilityRun(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        { status: 'cancelled' },
      ),
    ).toBe(true);
  });

  test('coalesces bearer key usage timestamp writes', () => {
    const created = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'usage timestamp test',
    });
    const initialTime = new Date('2026-10-08T12:00:00.000Z');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(initialTime);
      expect(
        db.authenticateExternalCapabilityKey(created.secret)?.last_used_at,
      ).toBe(initialTime.toISOString());

      vi.setSystemTime(new Date(initialTime.getTime() + 30_000));
      expect(
        db.authenticateExternalCapabilityKey(created.secret)?.last_used_at,
      ).toBe(initialTime.toISOString());
      expect(
        db
          .getExternalCapabilityKeys('quote-document-process')
          .find((key) => key.id === created.key.id)?.last_used_at,
      ).toBe(initialTime.toISOString());

      const nextWrite = new Date(initialTime.getTime() + 60_001);
      vi.setSystemTime(nextWrite);
      expect(
        db.authenticateExternalCapabilityKey(created.secret)?.last_used_at,
      ).toBe(nextWrite.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  test('returns the original immutable run for task or idempotency duplicates', () => {
    const created = createRun();
    const exactRetry = db.createExternalCapabilityRun({
      capabilitySlug: 'quote-document-process',
      keyId: created.run.key_id,
      externalTaskId: created.run.external_task_id,
      idempotencyKey: created.run.idempotency_key,
      tenantRef: created.run.tenant_ref,
      accountRef: created.run.account_ref,
      callbackContext: created.run.callback_context,
      inputManifest: created.run.input_manifest,
    });
    const sameTaskDifferentRequest = db.createExternalCapabilityRun({
      capabilitySlug: 'quote-document-process',
      keyId: created.run.key_id,
      externalTaskId: created.run.external_task_id,
      idempotencyKey: 'another-key',
      inputManifest: { changed: true },
    });
    const sameKeyDifferentTask = db.createExternalCapabilityRun({
      capabilitySlug: 'quote-document-process',
      keyId: created.run.key_id,
      externalTaskId: `another-task-${sequence}`,
      idempotencyKey: created.run.idempotency_key,
      inputManifest: { changed: true },
    });

    expect(exactRetry).toMatchObject({
      created: false,
      reason: 'duplicate',
      run: { id: created.run.id },
    });
    expect(sameTaskDifferentRequest).toMatchObject({
      created: false,
      reason: 'conflict',
      run: { id: created.run.id },
    });
    expect(sameKeyDifferentTask).toMatchObject({
      created: false,
      reason: 'conflict',
      run: { id: created.run.id },
    });
    expect(
      db.getExternalCapabilityRunById(created.run.id)?.input_manifest,
    ).toEqual(created.run.input_manifest);
    const claim = db.claimNextExternalCapabilityRun('cleanup', 60_000)!;
    expect(claim.id).toBe(created.run.id);
    expect(
      db.completeExternalCapabilityRun(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        { status: 'cancelled' },
      ),
    ).toBe(true);
  });

  test('does not let an expired lease renew or settle before takeover', () => {
    const created = createRun();
    const claim = db.claimNextExternalCapabilityRun('worker-a', -1_000)!;
    expect(claim.id).toBe(created.run.id);
    expect(
      db.renewExternalCapabilityRunLease(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        60_000,
      ),
    ).toBe(false);
    expect(
      db.completeExternalCapabilityRun(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        {
          status: 'succeeded',
          result: { schemaVersion: '1', status: 'completed' },
        },
      ),
    ).toBe(false);

    const replacement = db.claimNextExternalCapabilityRun('worker-b', 60_000)!;
    expect(replacement.id).toBe(claim.id);
    expect(replacement.attempt).toBe(claim.attempt);
    expect(
      db.completeExternalCapabilityRun(
        replacement.id,
        replacement.lease_owner,
        replacement.lease_token,
        { status: 'cancelled' },
      ),
    ).toBe(true);
  });

  test('commits Docker-create reservations before I/O and fences cancellation debt', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-09T03:00:00.000Z'));
      const created = createRun();
      const claim = db.claimNextExternalCapabilityRun(
        'container-create-reservation',
        60_000,
      )!;
      expect(claim.id).toBe(created.run.id);
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
          0,
        ),
      ).toBeNull();
      expect(
        db.reserveExternalCapabilityRunContainerCreation(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          claim.attempt,
          60_000,
          db.EXTERNAL_CAPABILITY_MAX_CONTAINER_CREATE_PENDING_MS + 1,
        ),
      ).toBeNull();
      expect(
        db.reserveExternalCapabilityRunContainerCreation(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          claim.attempt,
          30_000,
          45_000,
        ),
      ).toBeNull();

      const pendingUntil = db.reserveExternalCapabilityRunContainerCreation(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        claim.attempt,
        60_000,
        45_000,
      );
      expect(pendingUntil).toBe('2026-10-09T03:00:45.000Z');
      expect(db.getExternalCapabilityRunById(claim.id)).toMatchObject({
        container_cleanup_attempt: claim.attempt,
        container_cleanup_lease_token: claim.lease_token,
        container_create_pending_until: pendingUntil,
      });

      const concurrent = new Database(databasePath);
      concurrent.pragma('busy_timeout = 0');
      expect(() => concurrent.exec('BEGIN IMMEDIATE; ROLLBACK;')).not.toThrow();
      concurrent.close();

      expect(
        db.markExternalCapabilityRunExecutionStarted(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
        ),
      ).toBe(false);
      expect(
        db.releaseExternalCapabilityRunForRetry(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          new Date().toISOString(),
          { code: 'CREATE_PENDING', message: 'create pending' },
        ),
      ).toBe(false);
      expect(
        db.completeExternalCapabilityRun(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          { status: 'cancelled' },
        ),
      ).toBe(false);

      expect(
        db.cancelExternalCapabilityRun(
          claim.capability_slug,
          claim.key_id,
          claim.id,
        )?.cancelled,
      ).toBe(true);
      expect(
        db.clearExternalCapabilityRunContainerCleanupAfterVerifiedAbsence(
          claim.id,
          claim.attempt,
          claim.lease_token,
        ),
      ).toBe(false);

      const blocked = createRun();
      expect(
        db.claimNextExternalCapabilityRun('blocked-by-create', 60_000, {
          globalConcurrency: 1,
        }),
      ).toBeUndefined();
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
      expect(db.getExternalCapabilityRunById(claim.id)).toMatchObject({
        status: 'cancelled',
        container_cleanup_attempt: claim.attempt,
        container_cleanup_lease_token: claim.lease_token,
        container_create_pending_until: null,
      });
      expect(
        db.claimNextExternalCapabilityRun('blocked-by-cleanup-debt', 60_000, {
          globalConcurrency: 1,
        }),
      ).toBeUndefined();
      expect(
        db.clearExternalCapabilityRunContainerCleanupAfterVerifiedAbsence(
          claim.id,
          claim.attempt,
          claim.lease_token,
        ),
      ).toBe(true);

      const admitted = db.claimNextExternalCapabilityRun(
        'after-create-cleanup',
        60_000,
        { globalConcurrency: 1 },
      )!;
      expect(admitted.id).toBe(blocked.run.id);
      expect(
        db.completeExternalCapabilityRun(
          admitted.id,
          admitted.lease_owner,
          admitted.lease_token,
          { status: 'cancelled' },
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('denies Docker-create settlement after its durable deadline', () => {
    vi.useFakeTimers();
    try {
      const startedAt = new Date('2026-10-09T03:30:00.000Z');
      vi.setSystemTime(startedAt);
      const created = createRun();
      const claim = db.claimNextExternalCapabilityRun(
        'expired-create-settlement',
        60_000,
      )!;
      expect(claim.id).toBe(created.run.id);
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
        1_000,
      );
      expect(pendingUntil).not.toBeNull();

      vi.setSystemTime(new Date(startedAt.getTime() + 2_000));
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
      expect(db.getExternalCapabilityRunById(claim.id)).toMatchObject({
        status: 'running',
        container_cleanup_attempt: claim.attempt,
        container_cleanup_lease_token: claim.lease_token,
        container_create_pending_until: null,
      });
      expect(
        db.cancelExternalCapabilityRun(
          claim.capability_slug,
          claim.key_id,
          claim.id,
        )?.cancelled,
      ).toBe(true);
      expect(
        db.clearExternalCapabilityRunContainerCleanupAfterVerifiedAbsence(
          claim.id,
          claim.attempt,
          claim.lease_token,
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('blocks takeover until a persisted Docker-create deadline expires', () => {
    vi.useFakeTimers();
    const concurrent = new Database(databasePath);
    try {
      const now = new Date('2026-10-09T04:00:00.000Z');
      vi.setSystemTime(now);
      const created = createRun();
      const claim = db.claimNextExternalCapabilityRun(
        'pending-takeover-owner',
        60_000,
      )!;
      expect(claim.id).toBe(created.run.id);
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
          45_000,
        ),
      ).not.toBeNull();

      concurrent
        .prepare(
          `UPDATE external_capability_runs
           SET lease_expires_at = ?, container_create_pending_until = ?
           WHERE id = ?`,
        )
        .run(
          new Date(now.getTime() - 1_000).toISOString(),
          new Date(now.getTime() + 30_000).toISOString(),
          claim.id,
        );
      expect(
        db.claimNextExternalCapabilityRun('pending-takeover-blocked', 60_000),
      ).toBeUndefined();

      concurrent
        .prepare(
          `UPDATE external_capability_runs
           SET container_create_pending_until = ?
           WHERE id = ?`,
        )
        .run(new Date(now.getTime() - 1_000).toISOString(), claim.id);
      const replacement = db.claimNextExternalCapabilityRun(
        'pending-takeover-replacement',
        60_000,
      )!;
      expect(replacement.id).toBe(claim.id);
      expect(replacement.lease_token).toBeGreaterThan(claim.lease_token);
      expect(
        db.cancelExternalCapabilityRun(
          replacement.capability_slug,
          replacement.key_id,
          replacement.id,
        )?.cancelled,
      ).toBe(true);
      expect(
        db.clearExternalCapabilityRunContainerCleanupAfterVerifiedAbsence(
          claim.id,
          claim.attempt,
          claim.lease_token,
        ),
      ).toBe(true);
    } finally {
      concurrent.close();
      vi.useRealTimers();
    }
  });

  test('fences the old worker after an expired lease is taken over', () => {
    const created = createRun();
    const stale = db.claimNextExternalCapabilityRun('worker-a', -1_000)!;
    expect(stale.id).toBe(created.run.id);
    const replacement = db.claimNextExternalCapabilityRun('worker-b', 60_000)!;
    expect(replacement.id).toBe(stale.id);
    expect(replacement.attempt).toBe(stale.attempt);
    expect(replacement.lease_token).toBeGreaterThan(stale.lease_token);
    expect(
      db.renewExternalCapabilityRunLease(
        stale.id,
        stale.lease_owner,
        stale.lease_token,
        60_000,
      ),
    ).toBe(false);
    expect(
      db.completeExternalCapabilityRun(
        stale.id,
        stale.lease_owner,
        stale.lease_token,
        {
          status: 'failed',
          error: { code: 'INTERNAL_ERROR', message: 'stale' },
        },
      ),
    ).toBe(false);
    expect(
      db.completeExternalCapabilityRun(
        replacement.id,
        replacement.lease_owner,
        replacement.lease_token,
        {
          status: 'failed',
          error: { code: 'INTERNAL_ERROR', message: 'safe' },
        },
      ),
    ).toBe(true);
  });

  test('preserves a lease renewed before container reconciliation fences it', () => {
    const created = createRun();
    const claim = db.claimNextExternalCapabilityRun(
      'renew-before-reconcile',
      1_000,
    )!;
    expect(claim.id).toBe(created.run.id);
    expect(
      db.renewExternalCapabilityRunLease(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        60_000,
      ),
    ).toBe(true);
    expect(
      db.fenceExternalCapabilityContainerLease({
        runId: claim.id,
        attempt: claim.attempt,
        leaseToken: claim.lease_token,
      }),
    ).toBe('active');
    expect(
      db.completeExternalCapabilityRun(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        { status: 'cancelled' },
      ),
    ).toBe(true);
  });

  test('atomically fences an expired unstarted lease before late renewal', () => {
    const created = createRun();
    const claim = db.claimNextExternalCapabilityRun(
      'fence-before-renew',
      -1_000,
    )!;
    expect(claim.id).toBe(created.run.id);
    expect(
      db.fenceExternalCapabilityContainerLease({
        runId: claim.id,
        attempt: claim.attempt,
        leaseToken: claim.lease_token,
      }),
    ).toBe('fenced');
    expect(
      db.renewExternalCapabilityRunLease(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        60_000,
      ),
    ).toBe(false);
    expect(db.getExternalCapabilityRunById(claim.id)).toMatchObject({
      status: 'retry_wait',
      attempt: 0,
      lease_owner: null,
      lease_token: claim.lease_token + 1,
    });

    const retry = db.claimNextExternalCapabilityRun('retry-cleanup', 60_000)!;
    expect(retry.id).toBe(claim.id);
    expect(
      db.completeExternalCapabilityRun(
        retry.id,
        retry.lease_owner,
        retry.lease_token,
        { status: 'cancelled' },
      ),
    ).toBe(true);
  });

  test('fences a started expired lease until START publication recovery', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2020-01-01T02:00:00.000Z'));
      const created = createRun();
      const claim = db.claimNextExternalCapabilityRun(
        'started-reconcile-fence',
        1_000,
      )!;
      expect(claim.id).toBe(created.run.id);
      expect(
        db.markExternalCapabilityRunExecutionStarted(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          {
            reserveUsd: 2,
            globalUsdPerDay: 1_000,
            capabilityUsdPerDay: 1_000,
            keyUsdPerDay: 1_000,
          },
        ),
      ).toBe(true);

      vi.setSystemTime(new Date('2020-01-01T02:00:02.000Z'));
      expect(
        db.fenceExternalCapabilityContainerLease({
          runId: claim.id,
          attempt: claim.attempt,
          leaseToken: claim.lease_token,
        }),
      ).toBe('fenced');
      expect(db.getExternalCapabilityRunById(claim.id)).toMatchObject({
        status: 'running',
        error_code: 'START_RECOVERY_PENDING',
        lease_owner: null,
        lease_expires_at: null,
        lease_token: claim.lease_token + 1,
      });
      expect(
        db.getExternalCapabilityCostReservationForTest(claim.id),
      ).toMatchObject({ state: 'active', reserved_microusd: 2_000_000 });
      expect(
        db.listExternalCapabilityRunsAwaitingStartRecovery(),
      ).toContainEqual({
        id: claim.id,
        attempt: claim.attempt,
        leaseToken: claim.lease_token,
      });
      expect(
        db.resolveExternalCapabilityRunStartRecovery(claim.id, false),
      ).toBe(true);
      expect(db.getExternalCapabilityRunById(claim.id)).toMatchObject({
        status: 'failed',
        error_code: 'PROCESSING_INTERRUPTED',
      });
      expect(
        db.getExternalCapabilityCostReservationForTest(claim.id),
      ).toMatchObject({ state: 'uncertain', reserved_microusd: 2_000_000 });
      expect(
        db.renewExternalCapabilityRunLease(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          60_000,
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('requeues an expired authorization when START is definitely unpublished', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2020-01-01T02:30:00.000Z'));
      const created = createRun();
      const claim = db.claimNextExternalCapabilityRun(
        'unpublished-start-recovery',
        1_000,
      )!;
      expect(claim.id).toBe(created.run.id);
      expect(
        db.markExternalCapabilityRunExecutionStarted(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          {
            reserveUsd: 2,
            globalUsdPerDay: 1_000,
            capabilityUsdPerDay: 1_000,
            keyUsdPerDay: 1_000,
          },
        ),
      ).toBe(true);

      vi.setSystemTime(new Date('2020-01-01T02:30:02.000Z'));
      expect(
        db.fenceExternalCapabilityContainerLease({
          runId: claim.id,
          attempt: claim.attempt,
          leaseToken: claim.lease_token,
        }),
      ).toBe('fenced');
      expect(db.resolveExternalCapabilityRunStartRecovery(claim.id, true)).toBe(
        true,
      );
      expect(db.getExternalCapabilityRunById(claim.id)).toMatchObject({
        status: 'retry_wait',
        attempt: 1,
        started_at: null,
        error_code: 'CAPABILITY_UNAVAILABLE',
      });
      expect(
        db.getExternalCapabilityCostReservationForTest(claim.id),
      ).toMatchObject({ state: 'released', actual_microusd: 0 });
      const replacement = db.claimNextExternalCapabilityRun(
        'unpublished-start-replacement',
        60_000,
      )!;
      expect(replacement.id).toBe(claim.id);
      expect(
        db.cancelExternalCapabilityRun(
          replacement.capability_slug,
          replacement.key_id,
          replacement.id,
        )?.cancelled,
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('retains attempt accounting when an unstarted claim is released', () => {
    const created = createRun();
    const first = db.claimNextExternalCapabilityRun('worker-a', 60_000)!;
    expect(first.id).toBe(created.run.id);
    expect(first.attempt).toBe(1);
    expect(
      db.releaseExternalCapabilityRunForRetry(
        first.id,
        first.lease_owner,
        first.lease_token,
        new Date(Date.now() - 1_000).toISOString(),
        { code: 'UPSTREAM_UNAVAILABLE', message: 'temporary' },
        { countsAsAttempt: false },
      ),
    ).toBe(true);
    expect(db.getExternalCapabilityRunById(first.id)?.attempt).toBe(0);
    const retried = db.claimNextExternalCapabilityRun('worker-a', 60_000)!;
    expect(retried.id).toBe(first.id);
    expect(retried.attempt).toBe(1);
    expect(
      db.completeExternalCapabilityRun(
        retried.id,
        retried.lease_owner,
        retried.lease_token,
        { status: 'cancelled' },
      ),
    ).toBe(true);
  });

  test('caps repeated definitely-unpublished START crash recovery', () => {
    vi.useFakeTimers();
    try {
      let now = new Date('2020-01-01T02:45:00.000Z');
      vi.setSystemTime(now);
      const created = createRun();

      for (
        let expectedAttempt = 1;
        expectedAttempt <= 3;
        expectedAttempt += 1
      ) {
        const claim = db.claimNextExternalCapabilityRun(
          `unpublished-crash-${expectedAttempt}`,
          1_000,
        )!;
        expect(claim.id).toBe(created.run.id);
        expect(claim.attempt).toBe(expectedAttempt);
        expect(
          db.markExternalCapabilityRunExecutionStarted(
            claim.id,
            claim.lease_owner,
            claim.lease_token,
            {
              reserveUsd: 2,
              globalUsdPerDay: 1_000,
              capabilityUsdPerDay: 1_000,
              keyUsdPerDay: 1_000,
            },
          ),
        ).toBe(true);

        now = new Date(now.getTime() + 2_000);
        vi.setSystemTime(now);
        expect(
          db.fenceExternalCapabilityContainerLease({
            runId: claim.id,
            attempt: claim.attempt,
            leaseToken: claim.lease_token,
          }),
        ).toBe('fenced');
        expect(
          db.resolveExternalCapabilityRunStartRecovery(claim.id, true, 3),
        ).toBe(true);

        expect(db.getExternalCapabilityRunById(claim.id)).toMatchObject(
          expectedAttempt < 3
            ? {
                status: 'retry_wait',
                attempt: expectedAttempt,
                started_at: null,
                error_code: 'CAPABILITY_UNAVAILABLE',
              }
            : {
                status: 'failed',
                attempt: expectedAttempt,
                started_at: null,
                error_code: 'PRESTART_RETRY_EXHAUSTED',
              },
        );
        expect(
          db.getExternalCapabilityCostReservationForTest(claim.id),
        ).toMatchObject({ state: 'released', actual_microusd: 0 });
      }

      expect(
        db.claimNextExternalCapabilityRun('unpublished-crash-extra', 60_000),
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test('revalidates cancellation before publishing START consumption acknowledgement', () => {
    const acknowledged = createRun();
    const acknowledgedClaim = db.claimNextExternalCapabilityRun(
      'worker-acknowledged',
      60_000,
    )!;
    expect(acknowledgedClaim.id).toBe(acknowledged.run.id);
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        acknowledgedClaim.id,
        acknowledgedClaim.lease_owner,
        acknowledgedClaim.lease_token,
      ),
    ).toBe(true);
    const publishAcknowledgement = vi.fn();
    expect(
      db.publishExternalCapabilityRunExecutionAcknowledgement(
        acknowledgedClaim.id,
        acknowledgedClaim.lease_owner,
        acknowledgedClaim.lease_token,
        publishAcknowledgement,
      ),
    ).toBe(true);
    expect(publishAcknowledgement).toHaveBeenCalledOnce();
    expect(
      db.cancelExternalCapabilityRun(
        acknowledgedClaim.capability_slug,
        acknowledgedClaim.key_id,
        acknowledgedClaim.id,
      )?.cancelled,
    ).toBe(true);

    const cancelled = createRun();
    const cancelledClaim = db.claimNextExternalCapabilityRun(
      'worker-cancelled-before-ack',
      60_000,
    )!;
    expect(cancelledClaim.id).toBe(cancelled.run.id);
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        cancelledClaim.id,
        cancelledClaim.lease_owner,
        cancelledClaim.lease_token,
      ),
    ).toBe(true);
    expect(
      db.cancelExternalCapabilityRun(
        cancelledClaim.capability_slug,
        cancelledClaim.key_id,
        cancelledClaim.id,
      )?.cancelled,
    ).toBe(true);
    const rejectedAcknowledgement = vi.fn();
    expect(
      db.publishExternalCapabilityRunExecutionAcknowledgement(
        cancelledClaim.id,
        cancelledClaim.lease_owner,
        cancelledClaim.lease_token,
        rejectedAcknowledgement,
      ),
    ).toBe(false);
    expect(rejectedAcknowledgement).not.toHaveBeenCalled();
  });

  test('rolls back the execution boundary only before START publication', () => {
    const created = createRun();
    const claim = db.claimNextExternalCapabilityRun('worker-a', 60_000)!;
    expect(claim.id).toBe(created.run.id);
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);
    expect(
      db.rollbackExternalCapabilityRunExecutionStartBeforePublication(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);
    expect(db.getExternalCapabilityRunById(claim.id)?.started_at).toBeNull();
    expect(
      db.releaseExternalCapabilityRunForRetry(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        new Date().toISOString(),
        { code: 'START_PUBLICATION_FAILED', message: 'retryable' },
      ),
    ).toBe(true);
    expect(
      db.rollbackExternalCapabilityRunExecutionStartBeforePublication(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(false);
    const cleanup = db.claimNextExternalCapabilityRun('cleanup', 60_000)!;
    expect(cleanup.id).toBe(claim.id);
    expect(
      db.completeExternalCapabilityRun(
        cleanup.id,
        cleanup.lease_owner,
        cleanup.lease_token,
        { status: 'cancelled' },
      ),
    ).toBe(true);
  });

  test('rolls back an unpublished START after lease expiry when ownership was not taken over', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-09T00:00:00.000Z'));
      const created = createRun();
      const claim = db.claimNextExternalCapabilityRun('worker-expired', 1_000)!;
      expect(claim.id).toBe(created.run.id);
      expect(
        db.markExternalCapabilityRunExecutionStarted(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
        ),
      ).toBe(true);

      vi.setSystemTime(new Date('2026-10-09T00:00:02.000Z'));
      expect(
        db.publishExternalCapabilityRunExecutionStart(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          vi.fn(),
        ),
      ).toBe(false);
      expect(
        db.rollbackExternalCapabilityRunExecutionStartBeforePublication(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
        ),
      ).toBe(true);
      expect(db.getExternalCapabilityRunById(claim.id)).toMatchObject({
        status: 'running',
        started_at: null,
        lease_owner: claim.lease_owner,
        lease_token: claim.lease_token,
      });
      expect(
        db.releaseExternalCapabilityRunForRetry(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          new Date().toISOString(),
          { code: 'START_PUBLICATION_FAILED', message: 'retryable' },
        ),
      ).toBe(false);
      const cleanup = db.claimNextExternalCapabilityRun(
        'cleanup-expired',
        60_000,
      )!;
      expect(cleanup.id).toBe(claim.id);
      expect(
        db.completeExternalCapabilityRun(
          cleanup.id,
          cleanup.lease_owner,
          cleanup.lease_token,
          { status: 'cancelled' },
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('reapplies key revocation when unpublished START is rolled back', () => {
    const key = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'rollback revocation race',
    });
    const created = createRun(key.key.id);
    const claim = db.claimNextExternalCapabilityRun('worker-a', 60_000)!;
    expect(claim.id).toBe(created.run.id);
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);

    expect(
      db.revokeExternalCapabilityKey('quote-document-process', key.key.id),
    ).toBe(true);
    expect(db.getExternalCapabilityRunById(claim.id)).toMatchObject({
      status: 'running',
      lease_token: claim.lease_token,
    });

    expect(
      db.rollbackExternalCapabilityRunExecutionStartBeforePublication(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);
    expect(db.getExternalCapabilityRunById(claim.id)).toMatchObject({
      status: 'cancelled',
      started_at: null,
      error_code: 'KEY_REVOKED',
      lease_owner: null,
      lease_expires_at: null,
      lease_token: claim.lease_token + 1,
    });
    expect(
      db.releaseExternalCapabilityRunForRetry(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        new Date().toISOString(),
        { code: 'STALE', message: 'stale worker' },
      ),
    ).toBe(false);
    expect(
      db.completeExternalCapabilityRun(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        { status: 'failed', error: { code: 'STALE', message: 'stale' } },
      ),
    ).toBe(false);
  });

  test('never releases a run for replay after the execution boundary', () => {
    const created = createRun();
    const claim = db.claimNextExternalCapabilityRun('worker-a', 60_000)!;
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(false);

    expect(
      db.releaseExternalCapabilityRunForRetry(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        new Date().toISOString(),
        { code: 'UPSTREAM_UNAVAILABLE', message: 'temporary' },
      ),
    ).toBe(false);
    expect(db.getExternalCapabilityRunById(claim.id)).toMatchObject({
      status: 'running',
    });
    expect(
      db.completeExternalCapabilityRun(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        {
          status: 'failed',
          error: { code: 'PROCESSING_INTERRUPTED', message: 'safe failure' },
        },
      ),
    ).toBe(true);
  });

  test('cancels a running task within its key scope and fences its worker', () => {
    const key = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'cancellation test',
    });
    const created = createRun(key.key.id);
    const claim = db.claimNextExternalCapabilityRun('worker-a', 60_000)!;
    expect(claim.id).toBe(created.run.id);

    const cancelled = db.cancelExternalCapabilityRun(
      created.run.capability_slug,
      created.run.key_id!,
      created.run.id,
    );
    expect(cancelled).toMatchObject({
      cancelled: true,
      run: {
        id: created.run.id,
        status: 'cancelled',
        lease_owner: null,
        lease_expires_at: null,
        error_code: 'CANCELLED_BY_CALLER',
      },
    });
    expect(
      db.completeExternalCapabilityRun(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        {
          status: 'failed',
          error: { code: 'PROCESSING_FAILED', message: 'stale worker' },
        },
      ),
    ).toBe(false);
    expect(
      db.cancelExternalCapabilityRun(
        created.run.capability_slug,
        created.run.key_id!,
        created.run.id,
      )?.cancelled,
    ).toBe(false);
  });

  test('atomically rejects new runs after pause or key revocation', () => {
    expect(
      db.setExternalCapabilityStatus('quote-document-process', 'paused'),
    ).toBe(true);
    expect(() => createRun()).toThrow(db.ExternalCapabilityAdmissionError);
    expect(
      db.setExternalCapabilityStatus('quote-document-process', 'active'),
    ).toBe(true);

    const key = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'admission fence test',
    });
    expect(
      db.revokeExternalCapabilityKey('quote-document-process', key.key.id),
    ).toBe(true);
    expect(() => createRun(key.key.id)).toThrow(
      db.ExternalCapabilityAdmissionError,
    );
  });

  test('keeps queued runs recoverable while a capability is paused', () => {
    const created = createRun();
    expect(
      db.setExternalCapabilityStatus('quote-document-process', 'paused'),
    ).toBe(true);
    expect(db.getExternalCapabilityRunById(created.run.id)).toMatchObject({
      status: 'queued',
      error_code: null,
    });
    expect(
      db.claimNextExternalCapabilityRun('worker-a', 60_000),
    ).toBeUndefined();
    expect(
      db.setExternalCapabilityStatus('quote-document-process', 'active'),
    ).toBe(true);
    const resumed = db.claimNextExternalCapabilityRun('worker-a', 60_000)!;
    expect(resumed.id).toBe(created.run.id);
    expect(
      db.completeExternalCapabilityRun(
        resumed.id,
        resumed.lease_owner,
        resumed.lease_token,
        { status: 'cancelled' },
      ),
    ).toBe(true);
  });

  test('does not cross the execution boundary after a capability pauses', () => {
    const created = createRun();
    const claim = db.claimNextExternalCapabilityRun('worker-a', 60_000)!;
    expect(claim.id).toBe(created.run.id);

    expect(
      db.setExternalCapabilityStatus('quote-document-process', 'paused'),
    ).toBe(true);
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(false);
    expect(db.getExternalCapabilityRunById(claim.id)).toMatchObject({
      status: 'retry_wait',
      attempt: 0,
      started_at: null,
      error_code: 'CAPABILITY_UNAVAILABLE',
      lease_owner: null,
    });
    expect(
      db.setExternalCapabilityStatus('quote-document-process', 'active'),
    ).toBe(true);
    const resumed = db.claimNextExternalCapabilityRun('worker-b', 60_000)!;
    expect(resumed.id).toBe(claim.id);
    expect(resumed.lease_token).toBeGreaterThan(claim.lease_token);
    expect(
      db.completeExternalCapabilityRun(
        resumed.id,
        resumed.lease_owner,
        resumed.lease_token,
        { status: 'cancelled' },
      ),
    ).toBe(true);
  });

  test('parks an unpublished START when the capability pauses', () => {
    const created = createRun();
    const claim = db.claimNextExternalCapabilityRun('worker-a', 60_000)!;
    expect(claim.id).toBe(created.run.id);
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);

    expect(
      db.setExternalCapabilityStatus('quote-document-process', 'paused'),
    ).toBe(true);
    const publishStart = vi.fn();
    expect(
      db.publishExternalCapabilityRunExecutionStart(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        publishStart,
      ),
    ).toBe(false);
    expect(publishStart).not.toHaveBeenCalled();
    expect(
      db.rollbackExternalCapabilityRunExecutionStartBeforePublication(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);
    expect(db.getExternalCapabilityRunById(claim.id)).toMatchObject({
      status: 'retry_wait',
      attempt: 0,
      started_at: null,
      error_code: 'CAPABILITY_UNAVAILABLE',
      lease_owner: null,
      lease_expires_at: null,
      lease_token: claim.lease_token + 1,
    });
    expect(
      db.releaseExternalCapabilityRunForRetry(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        new Date().toISOString(),
        { code: 'STALE', message: 'stale worker' },
      ),
    ).toBe(false);

    expect(
      db.setExternalCapabilityStatus('quote-document-process', 'active'),
    ).toBe(true);
    const resumed = db.claimNextExternalCapabilityRun('cleanup', 60_000)!;
    expect(resumed.id).toBe(claim.id);
    expect(
      db.completeExternalCapabilityRun(
        resumed.id,
        resumed.lease_owner,
        resumed.lease_token,
        { status: 'cancelled' },
      ),
    ).toBe(true);
  });

  test('allows a started execution to settle after a capability pauses', () => {
    const created = createRun();
    const claim = db.claimNextExternalCapabilityRun('worker-a', 60_000)!;
    expect(claim.id).toBe(created.run.id);
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);

    expect(
      db.setExternalCapabilityStatus('quote-document-process', 'paused'),
    ).toBe(true);
    expect(
      db.completeExternalCapabilityRun(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        { status: 'succeeded', result: { format: 'xlsx' } },
      ),
    ).toBe(true);
    expect(
      db.setExternalCapabilityStatus('quote-document-process', 'active'),
    ).toBe(true);
  });

  test('cancels queued runs when their capability key is revoked', () => {
    const key = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'revocation test',
    });
    const created = createRun(key.key.id);
    expect(
      db.revokeExternalCapabilityKey('quote-document-process', key.key.id),
    ).toBe(true);
    expect(db.getExternalCapabilityRunById(created.run.id)).toMatchObject({
      status: 'cancelled',
      error_code: 'KEY_REVOKED',
    });
  });

  test('does not cross the execution boundary after its key is revoked', () => {
    const key = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'execution boundary revocation test',
    });
    const created = createRun(key.key.id);
    const claim = db.claimNextExternalCapabilityRun('worker-a', 60_000)!;
    expect(claim.id).toBe(created.run.id);

    expect(
      db.revokeExternalCapabilityKey('quote-document-process', key.key.id),
    ).toBe(true);
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(false);
    expect(db.getExternalCapabilityRunById(claim.id)).toMatchObject({
      status: 'cancelled',
      started_at: null,
      error_code: 'KEY_REVOKED',
    });
  });

  test('enforces atomic per-key queue and rate admission limits', () => {
    const key = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'quota admission test',
    });
    const first = createRun(key.key.id);
    expect(() =>
      db.createExternalCapabilityRun({
        capabilitySlug: 'quote-document-process',
        keyId: key.key.id,
        externalTaskId: `quota_task_${sequence}`,
        inputManifest: { schemaVersion: 1, requestFingerprint: 'b'.repeat(64) },
        admissionLimits: {
          globalQueueLimit: 100,
          capabilityQueueLimit: 100,
          keyQueueLimit: 1,
          keyRunsPerMinute: 100,
          keyRunsPerDay: 100,
          keyInputBytesPerDay: 100 * 1024 * 1024,
          maxInputBytesPerRun: 10 * 1024 * 1024,
        },
      }),
    ).toThrow(db.ExternalCapabilityQuotaError);
    expect(
      db.cancelExternalCapabilityRun(
        first.run.capability_slug,
        first.run.key_id!,
        first.run.id,
      )?.cancelled,
    ).toBe(true);

    expect(() =>
      db.createExternalCapabilityRun({
        capabilitySlug: 'quote-document-process',
        keyId: key.key.id,
        externalTaskId: `rate_task_${sequence}`,
        inputManifest: { schemaVersion: 1, requestFingerprint: 'c'.repeat(64) },
        admissionLimits: {
          globalQueueLimit: 100,
          capabilityQueueLimit: 100,
          keyQueueLimit: 100,
          keyRunsPerMinute: 1,
          keyRunsPerDay: 100,
          keyInputBytesPerDay: 100 * 1024 * 1024,
          maxInputBytesPerRun: 10 * 1024 * 1024,
        },
      }),
    ).toThrow(db.ExternalCapabilityQuotaError);
  });

  test('enforces per-run and rolling daily validated input byte budgets', () => {
    const key = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'input volume admission test',
    });
    const limits = {
      globalQueueLimit: 100,
      capabilityQueueLimit: 100,
      keyQueueLimit: 100,
      keyRunsPerMinute: 100,
      keyRunsPerDay: 100,
      keyInputBytesPerDay: 10,
      maxInputBytesPerRun: 8,
    };
    const manifest = (byteLength: number) => ({
      artifacts: [{ byteLength }],
    });

    expect(() =>
      db.createExternalCapabilityRun({
        capabilitySlug: 'quote-document-process',
        keyId: key.key.id,
        externalTaskId: `oversized_input_${sequence++}`,
        inputManifest: manifest(9),
        admissionLimits: limits,
      }),
    ).toThrow(db.ExternalCapabilityQuotaError);
    expect(() =>
      db.createExternalCapabilityRun({
        capabilitySlug: 'quote-document-process',
        keyId: key.key.id,
        externalTaskId: `invalid_input_bytes_${sequence++}`,
        inputManifest: { artifacts: [{ byteLength: '7' }] },
        admissionLimits: limits,
      }),
    ).toThrow(/invalid artifact byte lengths/);

    const firstDaily = db.createExternalCapabilityRun({
      capabilitySlug: 'quote-document-process',
      keyId: key.key.id,
      externalTaskId: `daily_input_first_${sequence++}`,
      inputManifest: manifest(6),
      admissionLimits: limits,
    }).run;
    expect(firstDaily.input_bytes).toBe(6);
    expect(() =>
      db.createExternalCapabilityRun({
        capabilitySlug: 'quote-document-process',
        keyId: key.key.id,
        externalTaskId: `daily_input_second_${sequence++}`,
        inputManifest: manifest(5),
        admissionLimits: limits,
      }),
    ).toThrow(db.ExternalCapabilityQuotaError);
    expect(
      db.cancelExternalCapabilityRun(
        'quote-document-process',
        key.key.id,
        firstDaily.id,
      )?.cancelled,
    ).toBe(true);
  });

  test('enforces global and per-key concurrency while claiming', () => {
    const firstKey = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'concurrency key A',
    });
    const secondKey = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'concurrency key B',
    });
    const a1 = db.createExternalCapabilityRun({
      capabilitySlug: 'quote-document-process',
      keyId: firstKey.key.id,
      externalTaskId: `concurrency_a1_${sequence++}`,
      inputManifest: { schemaVersion: 1 },
      availableAt: '2020-01-01T00:00:00.000Z',
    }).run;
    const a2 = db.createExternalCapabilityRun({
      capabilitySlug: 'quote-document-process',
      keyId: firstKey.key.id,
      externalTaskId: `concurrency_a2_${sequence++}`,
      inputManifest: { schemaVersion: 1 },
      availableAt: '2020-01-01T00:00:01.000Z',
    }).run;
    const b1 = db.createExternalCapabilityRun({
      capabilitySlug: 'quote-document-process',
      keyId: secondKey.key.id,
      externalTaskId: `concurrency_b1_${sequence++}`,
      inputManifest: { schemaVersion: 1 },
      availableAt: '2020-01-01T00:00:02.000Z',
    }).run;

    const first = db.claimNextExternalCapabilityRun('quota-worker', 60_000, {
      globalConcurrency: 2,
      capabilityConcurrency: 2,
      keyConcurrency: 1,
    })!;
    const second = db.claimNextExternalCapabilityRun('quota-worker', 60_000, {
      globalConcurrency: 2,
      capabilityConcurrency: 2,
      keyConcurrency: 1,
    })!;
    expect(first.id).toBe(a1.id);
    expect(second.id).toBe(b1.id);
    expect(
      db.claimNextExternalCapabilityRun('quota-worker', 60_000, {
        globalConcurrency: 2,
        keyConcurrency: 1,
      }),
    ).toBeUndefined();

    for (const claim of [first, second]) {
      expect(
        db.completeExternalCapabilityRun(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          { status: 'cancelled' },
        ),
      ).toBe(true);
    }
    const remaining = db.claimNextExternalCapabilityRun(
      'quota-worker',
      60_000,
      {
        globalConcurrency: 2,
        capabilityConcurrency: 2,
        keyConcurrency: 1,
      },
    )!;
    expect(remaining.id).toBe(a2.id);
    expect(
      db.completeExternalCapabilityRun(
        remaining.id,
        remaining.lease_owner,
        remaining.lease_token,
        { status: 'cancelled' },
      ),
    ).toBe(true);
  });

  test('enforces per-capability concurrency across different keys', () => {
    const firstKey = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'capability concurrency key A',
    });
    const secondKey = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'capability concurrency key B',
    });
    const firstRun = createRun(firstKey.key.id);
    const secondRun = createRun(secondKey.key.id);

    const first = db.claimNextExternalCapabilityRun('quota-worker', 60_000, {
      globalConcurrency: 2,
      capabilityConcurrency: 1,
      keyConcurrency: 1,
    })!;
    expect(first.id).toBe(firstRun.run.id);
    expect(
      db.claimNextExternalCapabilityRun('quota-worker', 60_000, {
        globalConcurrency: 2,
        capabilityConcurrency: 1,
        keyConcurrency: 1,
      }),
    ).toBeUndefined();
    expect(
      db.completeExternalCapabilityRun(
        first.id,
        first.lease_owner,
        first.lease_token,
        { status: 'cancelled' },
      ),
    ).toBe(true);

    const second = db.claimNextExternalCapabilityRun('quota-worker', 60_000, {
      globalConcurrency: 2,
      capabilityConcurrency: 1,
      keyConcurrency: 1,
    })!;
    expect(second.id).toBe(secondRun.run.id);
    expect(
      db.completeExternalCapabilityRun(
        second.id,
        second.lease_owner,
        second.lease_token,
        { status: 'cancelled' },
      ),
    ).toBe(true);
  });

  test('terminalizes an unpublished START when workspace execution becomes invalid', () => {
    const created = createRun();
    const claim = db.claimNextExternalCapabilityRun('worker-a', 60_000)!;
    expect(claim.id).toBe(created.run.id);
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);

    const workspace = db.getRegisteredGroup(CAPABILITY_WORKSPACE_JID)!;
    db.setRegisteredGroup(CAPABILITY_WORKSPACE_JID, {
      ...workspace,
      executionMode: 'host',
    });
    const rolledBack =
      db.rollbackExternalCapabilityRunExecutionStartBeforePublication(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      );
    db.setRegisteredGroup(CAPABILITY_WORKSPACE_JID, workspace);
    expect(
      db.setExternalCapabilityStatus('quote-document-process', 'active'),
    ).toBe(true);

    expect(rolledBack).toBe(true);
    expect(db.getExternalCapabilityRunById(claim.id)).toMatchObject({
      status: 'failed',
      started_at: null,
      error_code: 'CAPABILITY_CONFIGURATION_INVALID',
      lease_owner: null,
      lease_expires_at: null,
      lease_token: claim.lease_token + 1,
    });
    expect(
      db.completeExternalCapabilityRun(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        { status: 'failed', error: { code: 'STALE', message: 'stale' } },
      ),
    ).toBe(false);
  });

  test('allows a started execution to settle after its key is revoked', () => {
    const key = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'started execution revocation test',
    });
    const created = createRun(key.key.id);
    const claim = db.claimNextExternalCapabilityRun('worker-a', 60_000)!;
    expect(claim.id).toBe(created.run.id);
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);

    expect(
      db.revokeExternalCapabilityKey('quote-document-process', key.key.id),
    ).toBe(true);
    expect(
      db.completeExternalCapabilityRun(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        { status: 'succeeded', result: { format: 'xlsx' } },
      ),
    ).toBe(true);
  });

  test('reserves Provider exposure and records each usage event exactly once', () => {
    const key = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'provider cost settlement',
    });
    const created = createRun(key.key.id);
    const claim = db.claimNextExternalCapabilityRun('cost-worker', 60_000)!;
    expect(claim.id).toBe(created.run.id);
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        {
          reserveUsd: 2,
          globalUsdPerDay: 10,
          capabilityUsdPerDay: 10,
          keyUsdPerDay: 5,
        },
      ),
    ).toBe(true);
    expect(
      db.getExternalCapabilityCostReservationForTest(claim.id),
    ).toMatchObject({
      state: 'active',
      reserved_microusd: 2_000_000,
      actual_microusd: 0,
      lease_token: claim.lease_token,
    });

    const usage = {
      eventId: `usage-${claim.id}-0`,
      providerCostUsd: 0.125,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 40,
      reasoningTokens: 50,
    };
    expect(
      db.recordExternalCapabilityRunUsage(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        usage,
      ),
    ).toBe(true);
    expect(
      db.recordExternalCapabilityRunUsage(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        usage,
      ),
    ).toBe(false);
    expect(
      db.writeExternalCapabilityRunUsage(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        usage,
      ),
    ).toBe('duplicate');
    expect(
      db.writeExternalCapabilityRunUsage(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        { ...usage, providerCostUsd: usage.providerCostUsd + 1 },
      ),
    ).toBe('conflict');
    expect(
      db.getExternalCapabilityCostReservationForTest(claim.id),
    ).toMatchObject({
      state: 'active',
      actual_microusd: 125_000,
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
      reasoning_tokens: 50,
    });

    expect(
      db.completeExternalCapabilityRun(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        {
          status: 'failed',
          error: { code: 'FAILED', message: 'failed' },
          providerCostDisposition: 'settled',
        },
      ),
    ).toBe(true);
    expect(
      db.getExternalCapabilityCostReservationForTest(claim.id),
    ).toMatchObject({
      state: 'settled',
      reserved_microusd: 2_000_000,
      actual_microusd: 125_000,
    });
    expect(
      db.recordExternalCapabilityRunUsage(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        { ...usage, eventId: `${usage.eventId}-late` },
      ),
    ).toBe(false);
  });

  test('fences usage and terminal settlement after the lease expires', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-09T00:00:00.000Z'));
      const key = db.createExternalCapabilityKey({
        capabilitySlug: 'quote-document-process',
        label: 'expired settlement fence',
      });
      const created = createRun(key.key.id);
      const claim = db.claimNextExternalCapabilityRun(
        'expired-settlement-worker',
        1_000,
      )!;
      expect(claim.id).toBe(created.run.id);
      expect(
        db.markExternalCapabilityRunExecutionStarted(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          {
            reserveUsd: 0,
            globalUsdPerDay: 10,
            capabilityUsdPerDay: 10,
            keyUsdPerDay: 5,
          },
        ),
      ).toBe(true);

      vi.advanceTimersByTime(1_001);
      expect(
        db.writeExternalCapabilityRunUsage(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          {
            eventId: `usage-${claim.id}-expired`,
            providerCostUsd: 0.125,
            inputTokens: 10,
            outputTokens: 20,
            cacheReadInputTokens: 30,
            cacheCreationInputTokens: 40,
            reasoningTokens: 50,
          },
        ),
      ).toBe('fenced');
      expect(
        db.completeExternalCapabilityRun(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          { status: 'cancelled', providerCostDisposition: 'settled' },
        ),
      ).toBe(false);
      expect(
        db.getExternalCapabilityCostReservationForTest(claim.id),
      ).toMatchObject({ state: 'active', actual_microusd: 0 });
      expect(db.failExpiredStartedExternalCapabilityRuns()).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('keeps a conservative cost hold when terminal usage is incomplete', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
      const key = db.createExternalCapabilityKey({
        capabilitySlug: 'quote-document-process',
        label: 'provider cost incomplete usage',
      });
      const created = createRun(key.key.id);
      const claim = db.claimNextExternalCapabilityRun('cost-worker', 60_000)!;
      expect(claim.id).toBe(created.run.id);
      expect(
        db.markExternalCapabilityRunExecutionStarted(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          {
            reserveUsd: 2,
            globalUsdPerDay: 10,
            capabilityUsdPerDay: 10,
            keyUsdPerDay: 5,
          },
        ),
      ).toBe(true);

      expect(
        db.completeExternalCapabilityRun(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          {
            status: 'failed',
            error: {
              code: 'USAGE_ACCOUNTING_INCOMPLETE',
              message: 'usage unavailable',
            },
          },
        ),
      ).toBe(true);
      expect(
        db.getExternalCapabilityCostReservationForTest(claim.id),
      ).toMatchObject({
        state: 'uncertain',
        reserved_microusd: 2_000_000,
        actual_microusd: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('prevents concurrent START reservations from overcommitting a key budget', () => {
    const key = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'provider cost quota',
    });
    const firstRun = createRun(key.key.id);
    const first = db.claimNextExternalCapabilityRun('cost-worker-a', 60_000)!;
    expect(first.id).toBe(firstRun.run.id);
    const limits = {
      reserveUsd: 2,
      globalUsdPerDay: 100,
      capabilityUsdPerDay: 100,
      keyUsdPerDay: 3,
    };
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        first.id,
        first.lease_owner,
        first.lease_token,
        limits,
      ),
    ).toBe(true);

    const secondRun = createRun(key.key.id);
    const second = db.claimNextExternalCapabilityRun('cost-worker-b', 60_000)!;
    expect(second.id).toBe(secondRun.run.id);
    const deniedStart = db.authorizeExternalCapabilityRunExecutionStart(
      second.id,
      second.lease_owner,
      second.lease_token,
      limits,
    );
    expect(deniedStart.outcome).toBe('quota_exceeded');
    if (deniedStart.outcome === 'quota_exceeded') {
      expect(new Date(deniedStart.retryAt).getTime()).toBeGreaterThan(
        Date.now() + 23 * 60 * 60 * 1_000,
      );
    }
    expect(second.started_at).toBeNull();
    expect(
      db.getExternalCapabilityCostReservationForTest(second.id),
    ).toBeUndefined();

    expect(
      db.completeExternalCapabilityRun(
        second.id,
        second.lease_owner,
        second.lease_token,
        { status: 'cancelled' },
      ),
    ).toBe(true);
    expect(
      db.completeExternalCapabilityRun(
        first.id,
        first.lease_owner,
        first.lease_token,
        { status: 'cancelled', providerCostDisposition: 'settled' },
      ),
    ).toBe(true);
  });

  test('wakes cost-blocked retry work when a reservation settles below its hold', () => {
    vi.useFakeTimers();
    try {
      const now = new Date('2026-10-09T12:00:00.000Z');
      vi.setSystemTime(now);
      const key = db.createExternalCapabilityKey({
        capabilitySlug: 'quote-document-process',
        label: 'provider cost retry wake',
      });
      const limits = {
        reserveUsd: 2,
        globalUsdPerDay: 100,
        capabilityUsdPerDay: 100,
        keyUsdPerDay: 3,
      };
      const firstRun = createRun(key.key.id);
      const first = db.claimNextExternalCapabilityRun('cost-wake-a', 60_000)!;
      expect(first.id).toBe(firstRun.run.id);
      expect(
        db.markExternalCapabilityRunExecutionStarted(
          first.id,
          first.lease_owner,
          first.lease_token,
          limits,
        ),
      ).toBe(true);

      const secondRun = createRun(key.key.id);
      const second = db.claimNextExternalCapabilityRun('cost-wake-b', 60_000)!;
      expect(second.id).toBe(secondRun.run.id);
      const denied = db.authorizeExternalCapabilityRunExecutionStart(
        second.id,
        second.lease_owner,
        second.lease_token,
        limits,
      );
      expect(denied.outcome).toBe('quota_exceeded');
      const distantRetry = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
      expect(
        db.releaseExternalCapabilityRunForRetry(
          second.id,
          second.lease_owner,
          second.lease_token,
          distantRetry.toISOString(),
          {
            code: 'PROVIDER_COST_QUOTA_EXCEEDED',
            message: 'Provider cost quota is temporarily exhausted.',
          },
          { countsAsAttempt: false },
        ),
      ).toBe(true);
      expect(
        new Date(
          db.getExternalCapabilityRunById(second.id)!.available_at,
        ).getTime(),
      ).toBe(distantRetry.getTime());

      expect(
        db.completeExternalCapabilityRun(
          first.id,
          first.lease_owner,
          first.lease_token,
          { status: 'cancelled', providerCostDisposition: 'settled' },
        ),
      ).toBe(true);
      expect(
        new Date(
          db.getExternalCapabilityRunById(second.id)!.available_at,
        ).getTime(),
      ).toBe(now.getTime());
      const awakened = db.claimNextExternalCapabilityRun(
        'cost-wake-c',
        60_000,
      )!;
      expect(awakened.id).toBe(second.id);
      expect(
        db.completeExternalCapabilityRun(
          awakened.id,
          awakened.lease_owner,
          awakened.lease_token,
          { status: 'cancelled' },
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('enforces global and capability Provider-cost budgets independently', () => {
    const startPair = (
      label: string,
      limits: {
        reserveUsd: number;
        globalUsdPerDay: number;
        capabilityUsdPerDay: number;
        keyUsdPerDay: number;
      },
    ) => {
      const firstKey = db.createExternalCapabilityKey({
        capabilitySlug: 'quote-document-process',
        label: `${label} first`,
      });
      const secondKey = db.createExternalCapabilityKey({
        capabilitySlug: 'quote-document-process',
        label: `${label} second`,
      });
      const firstRun = createRun(firstKey.key.id);
      const first = db.claimNextExternalCapabilityRun(`${label}-a`, 60_000)!;
      expect(first.id).toBe(firstRun.run.id);
      expect(
        db.markExternalCapabilityRunExecutionStarted(
          first.id,
          first.lease_owner,
          first.lease_token,
          limits,
        ),
      ).toBe(true);

      const secondRun = createRun(secondKey.key.id);
      const second = db.claimNextExternalCapabilityRun(`${label}-b`, 60_000)!;
      expect(second.id).toBe(secondRun.run.id);
      expect(
        db.markExternalCapabilityRunExecutionStarted(
          second.id,
          second.lease_owner,
          second.lease_token,
          limits,
        ),
      ).toBe(false);
      expect(
        db.getExternalCapabilityCostReservationForTest(second.id),
      ).toBeUndefined();

      expect(
        db.completeExternalCapabilityRun(
          second.id,
          second.lease_owner,
          second.lease_token,
          { status: 'cancelled' },
        ),
      ).toBe(true);
      expect(
        db.completeExternalCapabilityRun(
          first.id,
          first.lease_owner,
          first.lease_token,
          { status: 'cancelled', providerCostDisposition: 'settled' },
        ),
      ).toBe(true);
    };

    startPair('global-cost-quota', {
      reserveUsd: 2,
      globalUsdPerDay: 3,
      capabilityUsdPerDay: 100,
      keyUsdPerDay: 100,
    });
    startPair('capability-cost-quota', {
      reserveUsd: 2,
      globalUsdPerDay: 100,
      capabilityUsdPerDay: 3,
      keyUsdPerDay: 100,
    });
  });

  test('uses actual cost above the reservation when enforcing later budgets', () => {
    const key = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'actual provider cost exposure',
    });
    const firstRun = createRun(key.key.id);
    const first = db.claimNextExternalCapabilityRun('actual-cost-a', 60_000)!;
    expect(first.id).toBe(firstRun.run.id);
    const limits = {
      reserveUsd: 1,
      globalUsdPerDay: 1_000,
      capabilityUsdPerDay: 1_000,
      keyUsdPerDay: 3.5,
    };
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        first.id,
        first.lease_owner,
        first.lease_token,
        limits,
      ),
    ).toBe(true);
    expect(
      db.recordExternalCapabilityRunUsage(
        first.id,
        first.lease_owner,
        first.lease_token,
        {
          eventId: `actual-cost-${first.id}`,
          providerCostUsd: 3,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningTokens: 0,
        },
      ),
    ).toBe(true);
    expect(
      db.completeExternalCapabilityRun(
        first.id,
        first.lease_owner,
        first.lease_token,
        { status: 'failed', error: { code: 'FAILED', message: 'failed' } },
      ),
    ).toBe(true);

    const secondRun = createRun(key.key.id);
    const second = db.claimNextExternalCapabilityRun('actual-cost-b', 60_000)!;
    expect(second.id).toBe(secondRun.run.id);
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        second.id,
        second.lease_owner,
        second.lease_token,
        limits,
      ),
    ).toBe(false);
    expect(
      db.completeExternalCapabilityRun(
        second.id,
        second.lease_owner,
        second.lease_token,
        { status: 'cancelled' },
      ),
    ).toBe(true);
  });

  test('releases an unpublished START reservation for a later execution', () => {
    const key = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'provider cost rollback release',
    });
    const limits = {
      reserveUsd: 2,
      globalUsdPerDay: 1_000,
      capabilityUsdPerDay: 1_000,
      keyUsdPerDay: 2,
    };
    const firstRun = createRun(key.key.id);
    const first = db.claimNextExternalCapabilityRun('rollback-cost-a', 60_000)!;
    expect(first.id).toBe(firstRun.run.id);
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        first.id,
        first.lease_owner,
        first.lease_token,
        limits,
      ),
    ).toBe(true);
    expect(
      db.rollbackExternalCapabilityRunExecutionStartBeforePublication(
        first.id,
        first.lease_owner,
        first.lease_token,
      ),
    ).toBe(true);
    expect(
      db.getExternalCapabilityCostReservationForTest(first.id),
    ).toMatchObject({ state: 'released', actual_microusd: 0 });

    const secondRun = createRun(key.key.id);
    const second = db.claimNextExternalCapabilityRun(
      'rollback-cost-b',
      60_000,
    )!;
    expect(second.id).toBe(secondRun.run.id);
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        second.id,
        second.lease_owner,
        second.lease_token,
        limits,
      ),
    ).toBe(true);
    for (const claim of [first, second]) {
      expect(
        db.completeExternalCapabilityRun(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          { status: 'cancelled' },
        ),
      ).toBe(true);
    }
  });

  test('releases proven-unpublished caller cancellation but keeps operator cancellation uncertain', () => {
    const startRun = (label: string) => {
      const key = db.createExternalCapabilityKey({
        capabilitySlug: 'quote-document-process',
        label,
      });
      const created = createRun(key.key.id);
      const claim = db.claimNextExternalCapabilityRun(
        `${label}-worker`,
        60_000,
      )!;
      expect(claim.id).toBe(created.run.id);
      expect(
        db.markExternalCapabilityRunExecutionStarted(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          {
            reserveUsd: 2,
            globalUsdPerDay: 1_000,
            capabilityUsdPerDay: 1_000,
            keyUsdPerDay: 10,
          },
        ),
      ).toBe(true);
      return { key, claim };
    };

    const caller = startRun('caller cost cancellation');
    expect(
      db.cancelExternalCapabilityRun(
        caller.claim.capability_slug,
        caller.key.key.id,
        caller.claim.id,
      )?.cancelled,
    ).toBe(true);
    expect(
      db.getExternalCapabilityCostReservationForTest(caller.claim.id),
    ).toMatchObject({ state: 'uncertain' });
    const publishStart = vi.fn();
    expect(
      db.publishExternalCapabilityRunExecutionStart(
        caller.claim.id,
        caller.claim.lease_owner,
        caller.claim.lease_token,
        publishStart,
      ),
    ).toBe(false);
    expect(publishStart).not.toHaveBeenCalled();
    expect(
      db.rollbackExternalCapabilityRunExecutionStartBeforePublication(
        caller.claim.id,
        caller.claim.lease_owner,
        caller.claim.lease_token,
      ),
    ).toBe(true);
    expect(
      db.getExternalCapabilityCostReservationForTest(caller.claim.id),
    ).toMatchObject({ state: 'released', actual_microusd: 0 });
    expect(
      db.completeExternalCapabilityRun(
        caller.claim.id,
        caller.claim.lease_owner,
        caller.claim.lease_token,
        { status: 'cancelled' },
      ),
    ).toBe(false);

    const operator = startRun('operator cost cancellation');
    expect(
      db.cancelExternalCapabilityRunByOperator(
        operator.claim.capability_slug,
        operator.claim.id,
      )?.cancelled,
    ).toBe(true);
    expect(
      db.getExternalCapabilityCostReservationForTest(operator.claim.id),
    ).toMatchObject({ state: 'uncertain' });
  });

  test('anchors settled rolling cost to settlement instead of reservation time', () => {
    vi.useFakeTimers();
    try {
      const reservedAt = new Date('2026-10-08T12:00:00.000Z');
      const settledAt = new Date('2026-10-09T11:00:00.000Z');
      const key = db.createExternalCapabilityKey({
        capabilitySlug: 'quote-document-process',
        label: 'settled provider cost timing',
      });
      vi.setSystemTime(reservedAt);
      const firstRun = createRun(key.key.id);
      const first = db.claimNextExternalCapabilityRun(
        'settled-cost-timing-a',
        24 * 60 * 60 * 1_000,
      )!;
      expect(first.id).toBe(firstRun.run.id);
      const limits = {
        reserveUsd: 2,
        globalUsdPerDay: 1_000,
        capabilityUsdPerDay: 1_000,
        keyUsdPerDay: 3,
      };
      expect(
        db.markExternalCapabilityRunExecutionStarted(
          first.id,
          first.lease_owner,
          first.lease_token,
          limits,
        ),
      ).toBe(true);
      expect(
        db.recordExternalCapabilityRunUsage(
          first.id,
          first.lease_owner,
          first.lease_token,
          {
            eventId: `settled-cost-${first.id}`,
            providerCostUsd: 2,
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            reasoningTokens: 0,
          },
        ),
      ).toBe(true);

      vi.setSystemTime(settledAt);
      expect(
        db.completeExternalCapabilityRun(
          first.id,
          first.lease_owner,
          first.lease_token,
          {
            status: 'failed',
            error: { code: 'FAILED', message: 'failed' },
            providerCostDisposition: 'settled',
          },
        ),
      ).toBe(true);

      const secondRun = createRun(key.key.id);
      const second = db.claimNextExternalCapabilityRun(
        'settled-cost-timing-b',
        60_000,
      )!;
      expect(second.id).toBe(secondRun.run.id);
      expect(
        db.authorizeExternalCapabilityRunExecutionStart(
          second.id,
          second.lease_owner,
          second.lease_token,
          limits,
        ),
      ).toEqual({
        outcome: 'quota_exceeded',
        retryAt: new Date(
          settledAt.getTime() + 24 * 60 * 60 * 1_000 + 1_000,
        ).toISOString(),
      });
      expect(
        db.completeExternalCapabilityRun(
          second.id,
          second.lease_owner,
          second.lease_token,
          { status: 'cancelled' },
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('waits until enough chronological exposure expires before retrying START', () => {
    vi.useFakeTimers();
    try {
      const now = new Date('2026-10-09T12:00:00.000Z');
      const key = db.createExternalCapabilityKey({
        capabilitySlug: 'quote-document-process',
        label: 'provider cost retry timing',
      });
      const permissiveLimits = {
        globalUsdPerDay: 1_000,
        capabilityUsdPerDay: 1_000,
        keyUsdPerDay: 1_000,
      };
      const addExposure = (
        createdAt: Date,
        reserveUsd: number,
        label: string,
      ) => {
        vi.setSystemTime(createdAt);
        const created = createRun(key.key.id);
        const claim = db.claimNextExternalCapabilityRun(
          `cost-retry-${label}`,
          60_000,
        )!;
        expect(claim.id).toBe(created.run.id);
        expect(
          db.markExternalCapabilityRunExecutionStarted(
            claim.id,
            claim.lease_owner,
            claim.lease_token,
            { reserveUsd, ...permissiveLimits },
          ),
        ).toBe(true);
        expect(
          db.completeExternalCapabilityRun(
            claim.id,
            claim.lease_owner,
            claim.lease_token,
            {
              status: 'failed',
              error: { code: 'FAILED', message: 'failed' },
            },
          ),
        ).toBe(true);
      };

      const firstExposureAt = new Date(now.getTime() - 23 * 60 * 60 * 1_000);
      const secondExposureAt = new Date(now.getTime() - 22 * 60 * 60 * 1_000);
      const thirdExposureAt = new Date(now.getTime() - 21 * 60 * 60 * 1_000);
      addExposure(firstExposureAt, 2, 'first');
      addExposure(secondExposureAt, 4, 'second');
      addExposure(thirdExposureAt, 4, 'third');

      vi.setSystemTime(now);
      const created = createRun(key.key.id);
      const claim = db.claimNextExternalCapabilityRun(
        'cost-retry-candidate',
        60_000,
      )!;
      expect(claim.id).toBe(created.run.id);
      const denied = db.authorizeExternalCapabilityRunExecutionStart(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        {
          reserveUsd: 4,
          globalUsdPerDay: 1_000,
          capabilityUsdPerDay: 1_000,
          keyUsdPerDay: 10,
        },
      );

      expect(denied).toEqual({
        outcome: 'quota_exceeded',
        retryAt: new Date(
          secondExposureAt.getTime() + 24 * 60 * 60 * 1_000 + 1_000,
        ).toISOString(),
      });
      expect(
        db.completeExternalCapabilityRun(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          { status: 'cancelled' },
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('retains a conservative cost hold when a started lease expires', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-09T01:00:00.000Z'));
      const key = db.createExternalCapabilityKey({
        capabilitySlug: 'quote-document-process',
        label: 'provider cost crash hold',
      });
      const created = createRun(key.key.id);
      const claim = db.claimNextExternalCapabilityRun('cost-worker', 1_000)!;
      expect(claim.id).toBe(created.run.id);
      expect(
        db.markExternalCapabilityRunExecutionStarted(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          {
            reserveUsd: 2,
            globalUsdPerDay: 1_000,
            capabilityUsdPerDay: 1_000,
            keyUsdPerDay: 1_000,
          },
        ),
      ).toBe(true);
      vi.setSystemTime(new Date('2026-10-09T01:00:02.000Z'));
      expect(db.failExpiredStartedExternalCapabilityRuns()).toBe(1);
      expect(db.getExternalCapabilityRunById(claim.id)).toMatchObject({
        status: 'failed',
        error_code: 'PROCESSING_INTERRUPTED',
      });
      expect(
        db.getExternalCapabilityCostReservationForTest(claim.id),
      ).toMatchObject({
        state: 'uncertain',
        reserved_microusd: 2_000_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not reap an excluded run but still rejects its expired lease', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-09T01:10:00.000Z'));
      const first = createRun();
      const firstClaim = db.claimNextExternalCapabilityRun('worker-a', 1_000)!;
      expect(firstClaim.id).toBe(first.run.id);
      expect(
        db.markExternalCapabilityRunExecutionStarted(
          firstClaim.id,
          firstClaim.lease_owner,
          firstClaim.lease_token,
          {
            reserveUsd: 1,
            globalUsdPerDay: 1_000,
            capabilityUsdPerDay: 1_000,
            keyUsdPerDay: 1_000,
          },
        ),
      ).toBe(true);

      const second = createRun();
      const secondClaim = db.claimNextExternalCapabilityRun('worker-b', 1_000)!;
      expect(secondClaim.id).toBe(second.run.id);
      expect(
        db.markExternalCapabilityRunExecutionStarted(
          secondClaim.id,
          secondClaim.lease_owner,
          secondClaim.lease_token,
          {
            reserveUsd: 1,
            globalUsdPerDay: 1_000,
            capabilityUsdPerDay: 1_000,
            keyUsdPerDay: 1_000,
          },
        ),
      ).toBe(true);

      vi.setSystemTime(new Date('2026-10-09T01:10:02.000Z'));
      expect(db.failExpiredStartedExternalCapabilityRuns([firstClaim.id])).toBe(
        1,
      );
      expect(db.getExternalCapabilityRunById(firstClaim.id)).toMatchObject({
        status: 'running',
      });
      expect(db.getExternalCapabilityRunById(secondClaim.id)).toMatchObject({
        status: 'failed',
        error_code: 'PROCESSING_INTERRUPTED',
      });
      expect(
        db.renewExternalCapabilityRunLease(
          firstClaim.id,
          firstClaim.lease_owner,
          firstClaim.lease_token,
          60_000,
        ),
      ).toBe(false);
      expect(
        db.fenceExternalCapabilityContainerLease({
          runId: firstClaim.id,
          attempt: firstClaim.attempt,
          leaseToken: firstClaim.lease_token,
        }),
      ).toBe('fenced');
    } finally {
      vi.useRealTimers();
    }
  });

  test('fences capabilities and keys when the workspace owner is disabled', () => {
    const created = createRun();
    const claim = db.claimNextExternalCapabilityRun(
      'owner-fence-worker',
      60_000,
    )!;
    expect(claim.id).toBe(created.run.id);

    const started = createRun();
    const startedClaim = db.claimNextExternalCapabilityRun(
      'owner-started-worker',
      60_000,
    )!;
    expect(startedClaim.id).toBe(started.run.id);
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        startedClaim.id,
        startedClaim.lease_owner,
        startedClaim.lease_token,
      ),
    ).toBe(true);

    db.updateUserFields('external-run-owner', { status: 'disabled' });

    expect(
      db.getExternalCapabilityBySlug('quote-document-process')?.status,
    ).toBe('paused');
    expect(
      db
        .getExternalCapabilityKeys('quote-document-process')
        .every((key) => key.status === 'revoked'),
    ).toBe(true);
    expect(db.getExternalCapabilityRunById(claim.id)).toMatchObject({
      status: 'cancelled',
      error_code: 'OWNER_INACTIVE',
      lease_owner: null,
    });
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(false);

    expect(db.getExternalCapabilityRunById(startedClaim.id)).toMatchObject({
      status: 'running',
      lease_token: startedClaim.lease_token,
    });
    expect(
      db.rollbackExternalCapabilityRunExecutionStartBeforePublication(
        startedClaim.id,
        startedClaim.lease_owner,
        startedClaim.lease_token,
      ),
    ).toBe(true);
    expect(db.getExternalCapabilityRunById(startedClaim.id)).toMatchObject({
      status: 'cancelled',
      started_at: null,
      error_code: 'OWNER_INACTIVE',
      lease_owner: null,
      lease_expires_at: null,
      lease_token: startedClaim.lease_token + 1,
    });
    expect(
      db.releaseExternalCapabilityRunForRetry(
        startedClaim.id,
        startedClaim.lease_owner,
        startedClaim.lease_token,
        new Date().toISOString(),
        { code: 'STALE', message: 'stale worker' },
      ),
    ).toBe(false);
    expect(
      db.completeExternalCapabilityRun(
        startedClaim.id,
        startedClaim.lease_owner,
        startedClaim.lease_token,
        { status: 'failed', error: { code: 'STALE', message: 'stale' } },
      ),
    ).toBe(false);
  });

  test('makes retirement irreversible and fences an unpublished START', () => {
    db.updateUserFields('external-run-owner', { status: 'active' });
    expect(
      db.setExternalCapabilityStatus('quote-document-process', 'active'),
    ).toBe(true);
    const key = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'retirement rollback race',
    });
    const created = createRun(key.key.id);
    const claim = db.claimNextExternalCapabilityRun('worker-a', 60_000)!;
    expect(claim.id).toBe(created.run.id);
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);

    expect(
      db.setExternalCapabilityStatus('quote-document-process', 'retired'),
    ).toBe(true);
    expect(
      db.rollbackExternalCapabilityRunExecutionStartBeforePublication(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);
    expect(db.getExternalCapabilityRunById(claim.id)).toMatchObject({
      status: 'cancelled',
      started_at: null,
      error_code: 'CAPABILITY_UNAVAILABLE',
      lease_owner: null,
      lease_expires_at: null,
      lease_token: claim.lease_token + 1,
    });
    expect(
      db.releaseExternalCapabilityRunForRetry(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        new Date().toISOString(),
        { code: 'STALE', message: 'stale worker' },
      ),
    ).toBe(false);
    expect(
      db.setExternalCapabilityStatus('quote-document-process', 'active'),
    ).toBe(false);
    expect(() =>
      db.createExternalCapabilityKey({
        capabilitySlug: 'quote-document-process',
        label: 'must not be created',
      }),
    ).toThrow(/not accepting new keys/);
  });
});
