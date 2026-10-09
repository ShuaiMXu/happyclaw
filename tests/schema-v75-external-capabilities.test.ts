import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v75-external-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');
const databasePath = path.join(storeDir, 'messages.db');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const legacy = new Database(databasePath);
legacy.exec(`
  CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO router_state VALUES ('schema_version', '74');
`);
legacy.close();

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

describe('schema v75 external capability foundation', () => {
  test('creates the durable quote capability contract without an active key or invocation', () => {
    process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = 'true';
    try {
      db.initDatabase();
    } finally {
      delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
    }

    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(db.getExternalCapabilities()).toEqual([
      expect.objectContaining({
        slug: 'quote-document-process',
        execution_mode: 'container',
        status: 'draft',
        input_schema_version: 1,
        max_file_bytes: 20 * 1024 * 1024,
        max_files_per_run: 10,
        max_total_bytes: 50 * 1024 * 1024,
      }),
    ]);
    expect(
      db.getExternalCapabilityBySlug('missing-capability'),
    ).toBeUndefined();

    const definition = db.getExternalCapabilityBySlug(
      'quote-document-process',
    )!;
    const now = new Date().toISOString();
    db.createUser({
      id: 'contract-drift-owner',
      username: 'contract-drift-owner',
      password_hash: 'hash',
      display_name: 'Contract drift owner',
      role: 'member',
      status: 'active',
      created_at: now,
      updated_at: now,
      must_change_password: false,
    });
    db.setRegisteredGroup(definition.workspace_jid, {
      name: 'Configured external target',
      folder: definition.workspace_folder,
      added_at: now,
      executionMode: 'container',
      created_by: 'contract-drift-owner',
    });
    expect(
      db.setExternalCapabilityStatus('quote-document-process', 'active'),
    ).toBe(true);

    const drifted = new Database(databasePath);
    drifted
      .prepare(
        `UPDATE external_capabilities
         SET workspace_jid = ?, workspace_folder = ?, status = 'active'
         WHERE slug = ?`,
      )
      .run(
        'web:previous-external-target',
        'previous-external-target',
        'quote-document-process',
      );
    drifted.close();

    db.setRegisteredGroup('web:previous-external-target', {
      name: 'Previous external target',
      folder: 'previous-external-target',
      added_at: now,
      executionMode: 'container',
      created_by: 'contract-drift-owner',
    });

    const key = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'contract drift test',
    }).key;
    const run = db.createExternalCapabilityRun({
      capabilitySlug: 'quote-document-process',
      keyId: key.id,
      externalTaskId: 'contract-drift-task',
      idempotencyKey: 'contract-drift-key',
      inputManifest: { version: 1 },
    }).run;
    const claim = db.claimNextExternalCapabilityRun(
      'contract-drift-worker',
      60_000,
    )!;
    expect(claim.id).toBe(run.id);
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);

    db.closeDatabase();
    db.initDatabase();
    expect(
      db.getExternalCapabilityBySlug('quote-document-process'),
    ).toMatchObject({
      workspace_jid: 'web:previous-external-target',
      workspace_folder: 'previous-external-target',
      status: 'paused',
    });
    expect(
      db.setExternalCapabilityStatus('quote-document-process', 'active'),
    ).toBe(false);
    expect(
      db.cancelExternalCapabilityRun('quote-document-process', key.id, run.id)
        ?.cancelled,
    ).toBe(true);

    expect(db.reconcileDeferredExternalCapabilityDefinitions()).toEqual([
      'quote-document-process',
    ]);
    expect(
      db.getExternalCapabilityBySlug('quote-document-process'),
    ).toMatchObject({
      workspace_jid: definition.workspace_jid,
      workspace_folder: definition.workspace_folder,
      status: 'paused',
    });
    expect(
      db.setExternalCapabilityStatus('quote-document-process', 'active'),
    ).toBe(true);
  });
});
