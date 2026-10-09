import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../src/schema-version.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v86-cost-'));
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

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v86 external Provider-cost backfill', () => {
  test('preserves pre-ledger START exposure and includes it in later admission', () => {
    db.initDatabase();
    const definition = db.getExternalCapabilityBySlug(
      'quote-document-process',
    )!;
    const now = new Date().toISOString();
    db.createUser({
      id: 'cost-backfill-owner',
      username: 'cost-backfill-owner',
      password_hash: 'hash',
      display_name: 'Cost backfill owner',
      role: 'member',
      status: 'active',
      created_at: now,
      updated_at: now,
      must_change_password: false,
    });
    db.setRegisteredGroup(definition.workspace_jid, {
      name: 'Cost backfill workspace',
      folder: definition.workspace_folder,
      added_at: now,
      executionMode: 'container',
      created_by: 'cost-backfill-owner',
    });
    expect(
      db.setExternalCapabilityStatus('quote-document-process', 'active'),
    ).toBe(true);
    const key = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'pre-ledger cost exposure',
    }).key;
    const legacyRun = db.createExternalCapabilityRun({
      capabilitySlug: 'quote-document-process',
      keyId: key.id,
      externalTaskId: 'pre-ledger-task',
      idempotencyKey: 'pre-ledger-idempotency',
      inputManifest: { version: 1 },
    }).run;
    const legacyClaim = db.claimNextExternalCapabilityRun(
      'pre-ledger-worker',
      60_000,
    )!;
    expect(legacyClaim.id).toBe(legacyRun.id);
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        legacyClaim.id,
        legacyClaim.lease_owner,
        legacyClaim.lease_token,
      ),
    ).toBe(true);
    db.closeDatabase();

    const legacy = new Database(databasePath);
    legacy
      .prepare(
        'DELETE FROM external_capability_cost_reservations WHERE run_id = ?',
      )
      .run(legacyRun.id);
    legacy
      .prepare(
        `INSERT INTO external_capability_runs (
           id, capability_slug, key_id, idempotency_key, external_task_id,
           tenant_ref, account_ref, callback_context, input_manifest, input_bytes,
           status, attempt, available_at, lease_owner, lease_token,
           lease_expires_at, started_at, completed_at, retention_cleaned_at,
           container_cleanup_attempt, container_cleanup_lease_token,
           result, error_code, error_message, created_at, updated_at
         )
         SELECT 'ancient-terminal-run', capability_slug, key_id,
                'ancient-terminal-idempotency', 'ancient-terminal-task',
                tenant_ref, account_ref, callback_context, input_manifest,
                input_bytes, 'failed', attempt, available_at, NULL, lease_token,
                NULL, '2025-01-01T00:00:00.000Z',
                '2025-01-01T00:01:00.000Z', NULL, NULL, NULL, result,
                'LEGACY_FAILURE', NULL, '2025-01-01T00:00:00.000Z',
                '2025-01-01T00:01:00.000Z'
         FROM external_capability_runs WHERE id = ?`,
      )
      .run(legacyRun.id);
    legacy
      .prepare(
        "UPDATE router_state SET value = '85' WHERE key = 'schema_version'",
      )
      .run();
    legacy.close();

    process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = 'true';
    try {
      db.initDatabase();
    } finally {
      delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
    }
    db.closeDatabase();

    const migrated = new Database(databasePath, { readonly: true });
    expect(
      migrated
        .prepare(
          `SELECT state, reserved_microusd, actual_microusd, lease_token,
                  created_at, settled_at
           FROM external_capability_cost_reservations WHERE run_id = ?`,
        )
        .get(legacyRun.id),
    ).toEqual({
      state: 'uncertain',
      reserved_microusd: 2_000_000,
      actual_microusd: 0,
      lease_token: legacyClaim.lease_token,
      created_at: expect.any(String),
      settled_at: null,
    });
    expect(
      migrated
        .prepare(
          `SELECT 1 FROM external_capability_cost_reservations
           WHERE run_id = 'ancient-terminal-run'`,
        )
        .get(),
    ).toBeUndefined();
    expect(
      migrated
        .prepare("SELECT value FROM router_state WHERE key = 'schema_version'")
        .pluck()
        .get(),
    ).toBe(String(CURRENT_SCHEMA_VERSION));
    migrated.close();

    db.initDatabase();
    const laterRun = db.createExternalCapabilityRun({
      capabilitySlug: 'quote-document-process',
      keyId: key.id,
      externalTaskId: 'post-migration-task',
      idempotencyKey: 'post-migration-idempotency',
      inputManifest: { version: 1 },
    }).run;
    const laterClaim = db.claimNextExternalCapabilityRun(
      'post-migration-worker',
      60_000,
    )!;
    expect(laterClaim.id).toBe(laterRun.id);
    expect(
      db.authorizeExternalCapabilityRunExecutionStart(
        laterClaim.id,
        laterClaim.lease_owner,
        laterClaim.lease_token,
        {
          reserveUsd: 2,
          globalUsdPerDay: 100,
          capabilityUsdPerDay: 100,
          keyUsdPerDay: 3,
        },
      ),
    ).toMatchObject({ outcome: 'quota_exceeded' });
  });
});
