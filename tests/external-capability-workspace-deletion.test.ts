import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'external-workspace-delete-'),
);
const storeDir = path.join(root, 'store');
const dataDir = path.join(root, 'data');
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

const CAPABILITY = 'quote-document-process';
const WORKSPACE_JID = 'web:6241df8f-b015-472e-9083-6c4ec31eedc1';
const WORKSPACE_FOLDER = 'flow-munrwfg2-u6u8';
let keyId = '';
let sequence = 0;

beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'workspace-delete-owner',
    username: 'workspace-delete-owner',
    password_hash: 'hash',
    display_name: 'Workspace delete owner',
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
  db.setRegisteredGroup(WORKSPACE_JID, {
    name: 'External workspace deletion target',
    folder: WORKSPACE_FOLDER,
    added_at: now,
    executionMode: 'container',
    created_by: 'workspace-delete-owner',
  });
  db.setExternalCapabilityStatus(CAPABILITY, 'active');
  keyId = db.createExternalCapabilityKey({
    capabilitySlug: CAPABILITY,
    label: 'workspace deletion key',
  }).key.id;
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function createRun() {
  sequence += 1;
  return db.createExternalCapabilityRun({
    capabilitySlug: CAPABILITY,
    keyId,
    externalTaskId: `workspace-delete-task-${sequence}`,
    idempotencyKey: `workspace-delete-idempotency-${sequence}`,
    inputManifest: { version: 1 },
  }).run;
}

describe('external capability workspace deletion fencing', () => {
  test('does not confuse removal of a shared-folder IM chat with workspace deletion', () => {
    const jid = 'qq:shared-folder-channel';
    db.setRegisteredGroup(jid, {
      name: 'Shared folder channel',
      folder: WORKSPACE_FOLDER,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: 'workspace-delete-owner',
    });
    const queued = createRun();

    expect(db.deleteRegisteredGroup(jid)).toEqual([]);
    expect(db.getRegisteredGroup(jid)).toBeUndefined();
    expect(db.getExternalCapabilityBySlug(CAPABILITY)?.status).toBe('active');
    expect(db.getExternalCapabilityRunById(queued.id)?.status).toBe('queued');
    expect(
      db.cancelExternalCapabilityRun(CAPABILITY, keyId, queued.id)?.cancelled,
    ).toBe(true);
  });

  test('does not retire a capability when a secondary web alias is deleted', () => {
    const jid = 'web:secondary-workspace-alias';
    db.setRegisteredGroup(jid, {
      name: 'Secondary workspace alias',
      folder: WORKSPACE_FOLDER,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: 'workspace-delete-owner',
    });
    const queued = createRun();

    expect(
      db.getSurvivingExternalCapabilityCanonicalWorkspace(
        jid,
        WORKSPACE_FOLDER,
      ),
    ).toBe(WORKSPACE_JID);
    expect(db.deleteRegisteredGroup(jid)).toEqual([]);
    expect(db.getRegisteredGroup(jid)).toBeUndefined();
    expect(db.getRegisteredGroup(WORKSPACE_JID)).toBeDefined();
    expect(db.getExternalCapabilityBySlug(CAPABILITY)?.status).toBe('active');
    expect(db.getExternalCapabilityRunById(queued.id)?.status).toBe('queued');
    expect(
      db.cancelExternalCapabilityRun(CAPABILITY, keyId, queued.id)?.cancelled,
    ).toBe(true);
  });

  test('pauses admission while running executions are stopped for deletion', () => {
    const run = createRun();
    const claim = db.claimNextExternalCapabilityRun(
      'workspace-delete-fence-worker',
      60_000,
    )!;
    expect(claim.id).toBe(run.id);

    const fence = db.beginExternalCapabilityWorkspaceDeletion(
      WORKSPACE_JID,
      WORKSPACE_FOLDER,
    );
    expect(fence.activeCapabilitySlugs).toEqual([CAPABILITY]);
    expect(fence.runningRunIds).toEqual([run.id]);
    expect(db.getExternalCapabilityBySlug(CAPABILITY)?.status).toBe('paused');
    expect(() => createRun()).toThrow(db.ExternalCapabilityAdmissionError);

    db.restoreExternalCapabilityWorkspaceDeletion(fence);
    expect(db.getExternalCapabilityBySlug(CAPABILITY)?.status).toBe('active');
    expect(
      db.cancelExternalCapabilityRun(CAPABILITY, keyId, run.id)?.cancelled,
    ).toBe(true);
  });

  test('blocks lifecycle changes and restores only the owning deletion operation', () => {
    const fence = db.beginExternalCapabilityWorkspaceDeletion(
      WORKSPACE_JID,
      WORKSPACE_FOLDER,
    );
    expect(fence.operationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(fence.capabilitySlugs).toEqual([CAPABILITY]);
    expect(db.setExternalCapabilityStatus(CAPABILITY, 'active')).toBe(false);
    expect(() =>
      db.beginExternalCapabilityWorkspaceDeletion(
        WORKSPACE_JID,
        WORKSPACE_FOLDER,
      ),
    ).toThrow('owned by another live process');

    expect(
      db.restoreExternalCapabilityWorkspaceDeletion({
        ...fence,
        ownerId: crypto.randomUUID(),
      }),
    ).toBe(false);
    expect(db.getExternalCapabilityBySlug(CAPABILITY)?.status).toBe('paused');
    expect(db.setExternalCapabilityStatus(CAPABILITY, 'active')).toBe(false);

    db.restoreExternalCapabilityWorkspaceDeletion(fence);
    expect(db.getExternalCapabilityBySlug(CAPABILITY)?.status).toBe('active');
    expect(db.setExternalCapabilityStatus(CAPABILITY, 'active')).toBe(true);
  });

  test('renews live ownership and recovers only after lease expiry', () => {
    const fence = db.beginExternalCapabilityWorkspaceDeletion(
      WORKSPACE_JID,
      WORKSPACE_FOLDER,
    );
    const renewedAt = new Date(Date.now() + 10_000);
    expect(db.renewExternalCapabilityWorkspaceDeletion(fence, renewedAt)).toBe(
      true,
    );
    expect(
      db.recoverExpiredExternalCapabilityWorkspaceDeletions(
        new Date(
          renewedAt.getTime() +
            db.EXTERNAL_CAPABILITY_WORKSPACE_DELETION_LEASE_MS -
            1,
        ),
      ),
    ).toBe(0);
    expect(db.getExternalCapabilityBySlug(CAPABILITY)?.status).toBe('paused');

    expect(
      db.recoverExpiredExternalCapabilityWorkspaceDeletions(
        new Date(
          renewedAt.getTime() +
            db.EXTERNAL_CAPABILITY_WORKSPACE_DELETION_LEASE_MS,
        ),
      ),
    ).toBe(1);
    expect(db.getExternalCapabilityBySlug(CAPABILITY)?.status).toBe('active');
    expect(db.restoreExternalCapabilityWorkspaceDeletion(fence)).toBe(false);
  });

  test('retains quarantine across recovery and lets an explicit retry adopt it', () => {
    const fence = db.beginExternalCapabilityWorkspaceDeletion(
      WORKSPACE_JID,
      WORKSPACE_FOLDER,
    );
    expect(db.quarantineExternalCapabilityWorkspaceDeletion(fence)).toBe(true);
    expect(
      db.recoverExpiredExternalCapabilityWorkspaceDeletions(
        new Date(Date.now() + 24 * 60 * 60 * 1_000),
      ),
    ).toBe(0);
    expect(db.getExternalCapabilityBySlug(CAPABILITY)?.status).toBe('paused');

    const adopted = db.beginExternalCapabilityWorkspaceDeletion(
      WORKSPACE_JID,
      WORKSPACE_FOLDER,
    );
    expect(adopted.operationId).toBe(fence.operationId);
    expect(adopted.ownerId).not.toBe(fence.ownerId);
    expect(adopted.initiallyQuarantined).toBe(true);
    expect(db.restoreExternalCapabilityWorkspaceDeletion(fence)).toBe(false);
    expect(db.restoreExternalCapabilityWorkspaceDeletion(adopted)).toBe(true);
    expect(db.getExternalCapabilityBySlug(CAPABILITY)?.status).toBe('active');
  });

  test('denies a late Docker create after cancellation and keeps cleanup debt', () => {
    const run = createRun();
    const claim = db.claimNextExternalCapabilityRun(
      'workspace-delete-create-cancel-worker',
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
      db.cancelExternalCapabilityRun(CAPABILITY, keyId, run.id)?.cancelled,
    ).toBe(true);
    const fence = db.beginExternalCapabilityWorkspaceDeletion(
      WORKSPACE_JID,
      WORKSPACE_FOLDER,
    );
    expect(fence.runningRunIds).toContain(run.id);
    expect(
      db.terminalizeExternalCapabilityRunForWorkspaceDeletion(
        run.id,
        fence.operationId,
        fence.ownerId,
      ),
    ).toBe(false);
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
    expect(db.getExternalCapabilityRunById(run.id)).toMatchObject({
      status: 'cancelled',
      container_cleanup_attempt: claim.attempt,
      container_cleanup_lease_token: claim.lease_token,
      container_create_pending_until: null,
    });
    expect(
      db.clearExternalCapabilityRunContainerCleanupAfterVerifiedAbsence(
        run.id,
        claim.attempt,
        claim.lease_token,
      ),
    ).toBe(true);
    expect(
      db.terminalizeExternalCapabilityRunForWorkspaceDeletion(
        run.id,
        fence.operationId,
        fence.ownerId,
      ),
    ).toBe(true);
    expect(db.restoreExternalCapabilityWorkspaceDeletion(fence)).toBe(true);
  });

  test('includes terminal runs whose physical container cleanup remains durable', () => {
    const run = createRun();
    const claim = db.claimNextExternalCapabilityRun(
      'workspace-delete-marked-worker',
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
      db.finishExternalCapabilityRunContainerCreation(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        claim.attempt,
        pendingUntil!,
        60_000,
      ),
    ).toBe(true);
    expect(
      db.clearExternalCapabilityRunContainerCleanupAfterVerifiedAbsence(
        run.id,
        claim.attempt,
        claim.lease_token,
      ),
    ).toBe(false);
    expect(
      db.cancelExternalCapabilityRun(CAPABILITY, keyId, run.id)?.cancelled,
    ).toBe(true);

    const fence = db.beginExternalCapabilityWorkspaceDeletion(
      WORKSPACE_JID,
      WORKSPACE_FOLDER,
    );
    expect(fence.runningRunIds).toContain(run.id);
    expect(
      db.terminalizeExternalCapabilityRunForWorkspaceDeletion(
        run.id,
        fence.operationId,
        fence.ownerId,
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
      db.terminalizeExternalCapabilityRunForWorkspaceDeletion(
        run.id,
        fence.operationId,
        fence.ownerId,
      ),
    ).toBe(true);
    db.restoreExternalCapabilityWorkspaceDeletion(fence);
  });

  test('retires capability, terminalizes every active state, and returns running IDs', () => {
    const retryWait = createRun();
    const retryClaim = db.claimNextExternalCapabilityRun(
      'workspace-delete-retry-worker',
      60_000,
    )!;
    expect(retryClaim.id).toBe(retryWait.id);
    expect(
      db.releaseExternalCapabilityRunForRetry(
        retryClaim.id,
        retryClaim.lease_owner,
        retryClaim.lease_token,
        new Date(Date.now() + 60_000).toISOString(),
        { code: 'UPSTREAM_UNAVAILABLE', message: 'retry later' },
      ),
    ).toBe(true);

    const runningPreStart = createRun();
    const preStartClaim = db.claimNextExternalCapabilityRun(
      'workspace-delete-prestart-worker',
      60_000,
    )!;
    expect(preStartClaim.id).toBe(runningPreStart.id);

    const runningPostStart = createRun();
    const postStartClaim = db.claimNextExternalCapabilityRun(
      'workspace-delete-poststart-worker',
      60_000,
    )!;
    expect(postStartClaim.id).toBe(runningPostStart.id);
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        postStartClaim.id,
        postStartClaim.lease_owner,
        postStartClaim.lease_token,
      ),
    ).toBe(true);

    const queued = createRun();
    const reservation = db.reserveExternalCapabilityIntake({
      capabilitySlug: CAPABILITY,
      keyId,
      reservedRawBytes: 123,
      limits: {
        globalIntakeLimit: 10,
        capabilityIntakeLimit: 10,
        keyIntakeLimit: 10,
        globalIntakeBytes: 10_000,
        capabilityIntakeBytes: 10_000,
        keyIntakeBytes: 10_000,
        keyIntakeAttemptsPerMinute: 100,
        keyIngressBytesPerDay: 100_000,
        intakeReservationTtlMs: 60_000,
      },
    });
    expect(reservation.admitted).toBe(true);
    if (!reservation.admitted) throw new Error('Expected intake admission');

    const stoppedRunIds = db.deleteRegisteredGroup(WORKSPACE_JID);

    expect(stoppedRunIds).toEqual(
      expect.arrayContaining([runningPreStart.id, runningPostStart.id]),
    );
    expect(stoppedRunIds).toHaveLength(2);
    expect(db.getRegisteredGroup(WORKSPACE_JID)).toBeUndefined();
    expect(db.getExternalCapabilityBySlug(CAPABILITY)?.status).toBe('retired');

    for (const run of [retryWait, runningPreStart, runningPostStart, queued]) {
      expect(db.getExternalCapabilityRunById(run.id)).toMatchObject({
        status: 'cancelled',
        error_code: 'WORKSPACE_DELETED',
        error_message: 'The processing workspace was deleted.',
        lease_owner: null,
        lease_expires_at: null,
      });
    }
    expect(
      db.completeExternalCapabilityRun(
        preStartClaim.id,
        preStartClaim.lease_owner,
        preStartClaim.lease_token,
        { status: 'failed', error: { code: 'STALE', message: 'stale' } },
      ),
    ).toBe(false);
    expect(
      db.completeExternalCapabilityRun(
        postStartClaim.id,
        postStartClaim.lease_owner,
        postStartClaim.lease_token,
        { status: 'succeeded', result: { stale: true } },
      ),
    ).toBe(false);
    expect(
      db.getExternalCapabilityCostReservationForTest(postStartClaim.id),
    ).toMatchObject({
      state: 'uncertain',
      lease_token: postStartClaim.lease_token,
    });

    expect(
      db.getExternalCapabilityIntakeReservationForTest(
        reservation.reservation.id,
      ),
    ).toMatchObject({
      state: 'finished',
      outcome: 'unavailable',
      quota_scope: null,
      observed_raw_bytes: 123,
    });
  });
});
