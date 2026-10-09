import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../src/schema-version.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v79-intake-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');
const databasePath = path.join(storeDir, 'messages.db');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

const CAPABILITY = 'quote-document-process';
const WORKSPACE_JID = 'web:6241df8f-b015-472e-9083-6c4ec31eedc1';

function limits(): db.ExternalCapabilityIntakeLimits {
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
  };
}

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v79 external intake windows', () => {
  test('backfills bounded windows and preserves legacy NULL container mode', () => {
    db.initDatabase();
    const now = new Date().toISOString();
    db.createUser({
      id: 'schema-v79-owner',
      username: 'schema-v79-owner',
      password_hash: 'hash',
      display_name: 'Schema v79 owner',
      role: 'member',
      status: 'active',
      created_at: now,
      updated_at: now,
      must_change_password: false,
    });
    db.setRegisteredGroup(WORKSPACE_JID, {
      name: 'Schema v79 workspace',
      folder: 'flow-munrwfg2-u6u8',
      added_at: now,
      executionMode: 'container',
      created_by: 'schema-v79-owner',
    });
    db.setExternalCapabilityStatus(CAPABILITY, 'active');
    const keyId = db.createExternalCapabilityKey({
      capabilitySlug: CAPABILITY,
      label: 'schema-v79-key',
    }).key.id;

    const finished = db.reserveExternalCapabilityIntake({
      capabilitySlug: CAPABILITY,
      keyId,
      reservedRawBytes: 10,
      limits: limits(),
    });
    expect(finished.admitted).toBe(true);
    if (!finished.admitted) throw new Error('Expected intake admission');
    expect(
      db.finishExternalCapabilityIntake({
        id: finished.reservation.id,
        leaseToken: finished.reservation.lease_token,
        outcome: 'invalid',
        observedRawBytes: 7,
      }),
    ).toBe(true);

    const active = db.reserveExternalCapabilityIntake({
      capabilitySlug: CAPABILITY,
      keyId,
      reservedRawBytes: 20,
      limits: limits(),
    });
    expect(active.admitted).toBe(true);
    db.closeDatabase();

    const legacy = new Database(databasePath);
    legacy.exec(`
      DROP TABLE external_capability_intake_ingress_windows;
      DROP TABLE external_capability_intake_rate_windows;
      UPDATE registered_groups SET execution_mode = NULL WHERE jid = '${WORKSPACE_JID}';
      UPDATE router_state SET value = '78' WHERE key = 'schema_version';
    `);
    legacy.close();

    process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = 'true';
    try {
      db.initDatabase();
    } finally {
      delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
    }

    const migrated = new Database(databasePath);
    expect(
      migrated
        .prepare(
          `SELECT request_count FROM external_capability_intake_rate_windows
           WHERE key_id = ?`,
        )
        .get(keyId),
    ).toEqual({ request_count: 2 });
    expect(
      migrated
        .prepare(
          `SELECT byte_count FROM external_capability_intake_ingress_windows
           WHERE key_id = ?`,
        )
        .get(keyId),
    ).toEqual({ byte_count: 27 });
    expect(
      migrated
        .prepare("SELECT value FROM router_state WHERE key = 'schema_version'")
        .pluck()
        .get(),
    ).toBe(String(CURRENT_SCHEMA_VERSION));
    migrated.close();

    expect(
      db.reserveExternalCapabilityIntake({
        capabilitySlug: CAPABILITY,
        keyId,
        reservedRawBytes: 0,
        limits: limits(),
        expectedWorkspace: {
          jid: WORKSPACE_JID,
          folder: 'flow-munrwfg2-u6u8',
          executionMode: 'container',
        },
      }).admitted,
    ).toBe(true);
  });
});
