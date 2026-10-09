import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'external-intake-store-'));
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

beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'external-intake-owner',
    username: 'external-intake-owner',
    password_hash: 'hash',
    display_name: 'External intake owner',
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
  db.setRegisteredGroup(WORKSPACE_JID, {
    name: 'External intake workspace',
    folder: 'flow-munrwfg2-u6u8',
    added_at: now,
    executionMode: 'container',
    created_by: 'external-intake-owner',
  });
  db.setExternalCapabilityStatus(CAPABILITY, 'active');
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function createKey(label: string): string {
  return db.createExternalCapabilityKey({ capabilitySlug: CAPABILITY, label })
    .key.id;
}

function limits(
  overrides: Partial<db.ExternalCapabilityIntakeLimits> = {},
): db.ExternalCapabilityIntakeLimits {
  return {
    globalIntakeLimit: 10,
    capabilityIntakeLimit: 10,
    keyIntakeLimit: 10,
    globalIntakeBytes: 10_000,
    capabilityIntakeBytes: 10_000,
    keyIntakeBytes: 10_000,
    keyIntakeAttemptsPerMinute: 100,
    keyIngressBytesPerDay: 100_000,
    intakeReservationTtlMs: 60_000,
    ...overrides,
  };
}

function reserve(input: {
  keyId: string;
  bytes: number;
  limits?: Partial<db.ExternalCapabilityIntakeLimits>;
  now?: string;
}) {
  return db.reserveExternalCapabilityIntake({
    capabilitySlug: CAPABILITY,
    keyId: input.keyId,
    reservedRawBytes: input.bytes,
    limits: limits(input.limits),
    now: input.now,
  });
}

describe('external capability intake reservations', () => {
  test('atomically rejects excess active requests without appending rejected rows', () => {
    const keyId = createKey('global request limit');
    const first = reserve({
      keyId,
      bytes: 10,
      limits: { globalIntakeLimit: 1 },
    });
    expect(first.admitted).toBe(true);
    if (!first.admitted) throw new Error('Expected intake admission');

    const rejected = reserve({
      keyId,
      bytes: 10,
      limits: { globalIntakeLimit: 1 },
    });
    expect(rejected).toEqual({
      admitted: false,
      reason: 'quota',
      quotaScope: 'global_requests',
    });
    expect(
      db.getExternalCapabilityIntakeReservationsForTest(keyId),
    ).toHaveLength(1);

    expect(
      db.finishExternalCapabilityIntake({
        id: first.reservation.id,
        leaseToken: first.reservation.lease_token,
        outcome: 'invalid',
        observedRawBytes: 7,
      }),
    ).toBe(true);
    expect(
      reserve({
        keyId,
        bytes: 10,
        limits: { globalIntakeLimit: 1 },
      }).admitted,
    ).toBe(true);
  });

  test('coalesces repeated rate-limit rejects into a bounded key window', () => {
    const keyId = createKey('bounded rate rejects');
    const now = '2026-10-09T04:00:00.000Z';
    const first = reserve({
      keyId,
      bytes: 0,
      now,
      limits: { keyIntakeAttemptsPerMinute: 1 },
    });
    expect(first.admitted).toBe(true);
    if (!first.admitted) throw new Error('Expected intake admission');

    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(
        reserve({
          keyId,
          bytes: 0,
          now,
          limits: { keyIntakeAttemptsPerMinute: 1 },
        }),
      ).toEqual({
        admitted: false,
        reason: 'quota',
        quotaScope: 'attempt_rate',
      });
    }

    expect(
      db.getExternalCapabilityIntakeReservationsForTest(keyId),
    ).toHaveLength(1);
    expect(
      reserve({
        keyId,
        bytes: 0,
        now: '2026-10-09T04:01:00.000Z',
        limits: { keyIntakeAttemptsPerMinute: 1 },
      }).admitted,
    ).toBe(true);
  });

  test('enforces active byte reservations independently by key', () => {
    const keyId = createKey('key byte limit');
    const first = reserve({
      keyId,
      bytes: 10,
      limits: { keyIntakeBytes: 15 },
    });
    expect(first.admitted).toBe(true);
    if (!first.admitted) throw new Error('Expected intake admission');
    const rejected = reserve({
      keyId,
      bytes: 6,
      limits: { keyIntakeBytes: 15 },
    });
    expect(rejected).toEqual({
      admitted: false,
      reason: 'quota',
      quotaScope: 'key_bytes',
    });
    expect(
      db.finishExternalCapabilityIntake({
        id: first.reservation.id,
        leaseToken: first.reservation.lease_token,
        outcome: 'aborted',
        observedRawBytes: 4,
      }),
    ).toBe(true);
  });

  test('settles reserved ingress bytes to the observed body size', () => {
    const keyId = createKey('settled ingress bytes');
    const now = '2026-10-09T05:00:00.000Z';
    const first = reserve({
      keyId,
      bytes: 10,
      now,
      limits: { keyIngressBytesPerDay: 10 },
    });
    expect(first.admitted).toBe(true);
    if (!first.admitted) throw new Error('Expected intake admission');
    expect(
      db.finishExternalCapabilityIntake({
        id: first.reservation.id,
        leaseToken: first.reservation.lease_token,
        outcome: 'invalid',
        observedRawBytes: 4,
      }),
    ).toBe(true);

    expect(
      reserve({
        keyId,
        bytes: 6,
        now: '2026-10-09T05:00:01.000Z',
        limits: { keyIngressBytesPerDay: 10 },
      }).admitted,
    ).toBe(true);
  });

  test('attributes completed ingress to the completion minute', () => {
    const keyId = createKey('completion-minute ingress');
    const first = reserve({
      keyId,
      bytes: 10,
      now: '2026-10-08T00:00:59.000Z',
      limits: { keyIngressBytesPerDay: 15 },
    });
    expect(first.admitted).toBe(true);
    if (!first.admitted) throw new Error('Expected intake admission');

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T00:01:01.000Z'));
    try {
      expect(
        db.finishExternalCapabilityIntake({
          id: first.reservation.id,
          leaseToken: first.reservation.lease_token,
          outcome: 'invalid',
          observedRawBytes: 10,
        }),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    expect(
      reserve({
        keyId,
        bytes: 6,
        now: '2026-10-09T00:01:00.000Z',
        limits: { keyIngressBytesPerDay: 15 },
      }),
    ).toEqual({
      admitted: false,
      reason: 'quota',
      quotaScope: 'ingress_volume',
    });
  });

  test('keeps ingress usage rolling across UTC midnight', () => {
    const keyId = createKey('rolling midnight ingress');
    const first = reserve({
      keyId,
      bytes: 10,
      now: '2026-10-08T23:59:59.000Z',
      limits: { keyIngressBytesPerDay: 15 },
    });
    expect(first.admitted).toBe(true);

    expect(
      reserve({
        keyId,
        bytes: 6,
        now: '2026-10-09T00:00:01.000Z',
        limits: { keyIngressBytesPerDay: 15 },
      }),
    ).toEqual({
      admitted: false,
      reason: 'quota',
      quotaScope: 'ingress_volume',
    });
  });

  test('expires abandoned reservations conservatively into rolling ingress usage', () => {
    const keyId = createKey('expired reservation');
    const startedAt = '2026-10-09T00:00:00.000Z';
    const first = reserve({
      keyId,
      bytes: 10,
      now: startedAt,
      limits: { intakeReservationTtlMs: 1_000 },
    });
    expect(first.admitted).toBe(true);
    if (!first.admitted) throw new Error('Expected intake admission');

    const rejected = reserve({
      keyId,
      bytes: 6,
      now: '2026-10-09T00:00:02.000Z',
      limits: {
        intakeReservationTtlMs: 1_000,
        keyIngressBytesPerDay: 15,
      },
    });
    expect(rejected).toEqual({
      admitted: false,
      reason: 'quota',
      quotaScope: 'ingress_volume',
    });
    expect(
      db.getExternalCapabilityIntakeReservationForTest(first.reservation.id),
    ).toMatchObject({
      state: 'finished',
      outcome: 'expired',
      observed_raw_bytes: 10,
    });
  });

  test('settles accepted and duplicate attempts in the run admission transaction', () => {
    const keyId = createKey('atomic run settlement');
    const manifest = {
      version: 1,
      requestFingerprint: 'a'.repeat(64),
      artifacts: [{ byteLength: 3 }],
    };
    const first = reserve({ keyId, bytes: 100 });
    expect(first.admitted).toBe(true);
    if (!first.admitted) throw new Error('Expected intake admission');
    const created = db.createExternalCapabilityRun({
      capabilitySlug: CAPABILITY,
      keyId,
      externalTaskId: 'atomic-intake-task',
      idempotencyKey: 'atomic-intake-key',
      inputManifest: manifest,
      intakeReservation: {
        id: first.reservation.id,
        leaseToken: first.reservation.lease_token,
        observedRawBytes: 87,
      },
    });
    expect(created.created).toBe(true);
    expect(
      db.getExternalCapabilityIntakeReservationForTest(first.reservation.id),
    ).toMatchObject({
      state: 'finished',
      outcome: 'accepted',
      observed_raw_bytes: 87,
      accepted_input_bytes: 3,
      run_id: created.run.id,
    });

    const retry = reserve({ keyId, bytes: 100 });
    expect(retry.admitted).toBe(true);
    if (!retry.admitted) throw new Error('Expected retry intake admission');
    const duplicate = db.createExternalCapabilityRun({
      capabilitySlug: CAPABILITY,
      keyId,
      externalTaskId: 'atomic-intake-task',
      idempotencyKey: 'atomic-intake-key',
      inputManifest: manifest,
      intakeReservation: {
        id: retry.reservation.id,
        leaseToken: retry.reservation.lease_token,
        observedRawBytes: 89,
      },
    });
    expect(duplicate).toMatchObject({
      created: false,
      reason: 'duplicate',
      run: { id: created.run.id },
    });
    expect(
      db.getExternalCapabilityIntakeReservationForTest(retry.reservation.id),
    ).toMatchObject({
      state: 'finished',
      outcome: 'duplicate',
      observed_raw_bytes: 89,
      accepted_input_bytes: 0,
      run_id: created.run.id,
    });

    expect(
      db.cancelExternalCapabilityRun(CAPABILITY, keyId, created.run.id),
    ).toMatchObject({ cancelled: true });
  });

  test('keeps status, cancellation and download rate windows independent', () => {
    const keyId = createKey('api rate lanes');
    const now = '2026-10-09T01:00:00.000Z';
    expect(
      db.consumeExternalCapabilityApiRateLimit({
        keyId,
        operation: 'status',
        limit: 2,
        now,
      }),
    ).toBe(true);
    expect(
      db.consumeExternalCapabilityApiRateLimit({
        keyId,
        operation: 'status',
        limit: 2,
        now,
      }),
    ).toBe(true);
    expect(
      db.consumeExternalCapabilityApiRateLimit({
        keyId,
        operation: 'status',
        limit: 2,
        now,
      }),
    ).toBe(false);
    expect(
      db.consumeExternalCapabilityApiRateLimit({
        keyId,
        operation: 'cancel',
        limit: 1,
        now,
      }),
    ).toBe(true);
    expect(
      db.consumeExternalCapabilityApiRateLimit({
        keyId,
        operation: 'download',
        limit: 1,
        now,
      }),
    ).toBe(true);
    expect(
      db.consumeExternalCapabilityApiRateLimit({
        keyId,
        operation: 'status',
        limit: 2,
        now: '2026-10-09T01:01:00.000Z',
      }),
    ).toBe(true);
  });

  test('isolates API rate windows by credential and validates inputs', () => {
    const firstKeyId = createKey('api rate key one');
    const secondKeyId = createKey('api rate key two');
    const now = '2026-10-09T02:00:00.000Z';
    expect(
      db.consumeExternalCapabilityApiRateLimit({
        keyId: firstKeyId,
        operation: 'download',
        limit: 1,
        windowMs: 1_000,
        now,
      }),
    ).toBe(true);
    expect(
      db.consumeExternalCapabilityApiRateLimit({
        keyId: firstKeyId,
        operation: 'download',
        limit: 1,
        windowMs: 1_000,
        now,
      }),
    ).toBe(false);
    expect(
      db.consumeExternalCapabilityApiRateLimit({
        keyId: secondKeyId,
        operation: 'download',
        limit: 1,
        windowMs: 1_000,
        now,
      }),
    ).toBe(true);
    expect(
      db.consumeExternalCapabilityApiRateLimit({
        keyId: firstKeyId,
        operation: 'download',
        limit: 1,
        windowMs: 1_000,
        now: '2026-10-09T02:00:01.000Z',
      }),
    ).toBe(true);
    expect(() =>
      db.consumeExternalCapabilityApiRateLimit({
        keyId: firstKeyId,
        operation: 'status',
        limit: 0,
        now,
      }),
    ).toThrow('Invalid external capability API rate limit');
    expect(() =>
      db.consumeExternalCapabilityApiRateLimit({
        keyId: firstKeyId,
        operation: 'status',
        limit: 1,
        now: 'not-a-date',
      }),
    ).toThrow('Invalid rate time');
  });

  test('renews active intake ownership across a long validation pipeline', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-09T03:00:00.000Z'));
      const keyId = createKey('renew intake');
      const admitted = reserve({
        keyId,
        bytes: 10,
        limits: { intakeReservationTtlMs: 1_000 },
      });
      expect(admitted.admitted).toBe(true);
      if (!admitted.admitted) throw new Error('Expected intake admission');

      vi.setSystemTime(new Date('2026-10-09T03:00:00.900Z'));
      expect(
        db.renewExternalCapabilityIntake(
          admitted.reservation.id,
          admitted.reservation.lease_token,
          1_000,
        ),
      ).toBe(true);
      expect(
        db.renewExternalCapabilityIntake(
          admitted.reservation.id,
          admitted.reservation.lease_token + 1,
          1_000,
        ),
      ).toBe(false);

      vi.setSystemTime(new Date('2026-10-09T03:00:01.500Z'));
      expect(
        db.finishExternalCapabilityIntake({
          id: admitted.reservation.id,
          leaseToken: admitted.reservation.lease_token,
          outcome: 'invalid',
          observedRawBytes: 5,
        }),
      ).toBe(true);
      expect(
        db.renewExternalCapabilityIntake(
          admitted.reservation.id,
          admitted.reservation.lease_token,
          1_000,
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not resurrect an expired intake lease', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-09T03:30:00.000Z'));
      const keyId = createKey('expired intake renewal');
      const admitted = reserve({
        keyId,
        bytes: 10,
        limits: { intakeReservationTtlMs: 1_000 },
      });
      expect(admitted.admitted).toBe(true);
      if (!admitted.admitted) throw new Error('Expected intake admission');

      vi.setSystemTime(new Date('2026-10-09T03:30:01.001Z'));
      expect(
        db.renewExternalCapabilityIntake(
          admitted.reservation.id,
          admitted.reservation.lease_token,
          1_000,
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('finalization is token-fenced and idempotent', () => {
    const keyId = createKey('finish fencing');
    const admitted = reserve({ keyId, bytes: 10 });
    expect(admitted.admitted).toBe(true);
    if (!admitted.admitted) throw new Error('Expected intake admission');
    expect(
      db.finishExternalCapabilityIntake({
        id: admitted.reservation.id,
        leaseToken: admitted.reservation.lease_token + 1,
        outcome: 'invalid',
        observedRawBytes: 5,
      }),
    ).toBe(false);
    const finish = {
      id: admitted.reservation.id,
      leaseToken: admitted.reservation.lease_token,
      outcome: 'invalid' as const,
      observedRawBytes: 5,
    };
    expect(db.finishExternalCapabilityIntake(finish)).toBe(true);
    expect(db.finishExternalCapabilityIntake(finish)).toBe(true);
    expect(
      db.getExternalCapabilityIntakeReservationForTest(admitted.reservation.id),
    ).toMatchObject({ outcome: 'invalid', observed_raw_bytes: 5 });
  });
});
