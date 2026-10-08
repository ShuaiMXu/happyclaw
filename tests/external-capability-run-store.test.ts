import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'external-run-store-'));
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

let defaultKeyId = '';
beforeAll(() => {
  db.initDatabase();
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

  test('fences expired leases even before a replacement worker claims them', () => {
    const created = createRun();
    const first = db.claimNextExternalCapabilityRun('worker-a', -1_000)!;
    expect(first.id).toBe(created.run.id);
    expect(
      db.renewExternalCapabilityRunLease(
        first.id,
        first.lease_owner,
        first.lease_token,
        60_000,
      ),
    ).toBe(false);
    expect(
      db.completeExternalCapabilityRun(
        first.id,
        first.lease_owner,
        first.lease_token,
        {
          status: 'succeeded',
          result: { schemaVersion: '1', status: 'completed' },
        },
      ),
    ).toBe(false);
    const recovered = db.claimNextExternalCapabilityRun('worker-b', 60_000)!;
    expect(recovered.id).toBe(first.id);
    expect(
      db.completeExternalCapabilityRun(
        recovered.id,
        recovered.lease_owner,
        recovered.lease_token,
        { status: 'cancelled' },
      ),
    ).toBe(true);

    const secondCreated = createRun();
    const stale = db.claimNextExternalCapabilityRun('worker-a', -1_000)!;
    expect(stale.id).toBe(secondCreated.run.id);
    const replacement = db.claimNextExternalCapabilityRun('worker-b', 60_000)!;
    expect(replacement.id).toBe(stale.id);
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

    const firstDaily = db.createExternalCapabilityRun({
      capabilitySlug: 'quote-document-process',
      keyId: key.key.id,
      externalTaskId: `daily_input_first_${sequence++}`,
      inputManifest: manifest(6),
      admissionLimits: limits,
    }).run;
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

  test('makes retirement irreversible and rejects new keys', () => {
    expect(
      db.setExternalCapabilityStatus('quote-document-process', 'retired'),
    ).toBe(true);
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
