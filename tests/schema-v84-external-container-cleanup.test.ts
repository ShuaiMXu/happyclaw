import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../src/schema-version.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v84-cleanup-'));
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

describe('schema v84 external container cleanup fencing', () => {
  test('adds durable run cleanup identity and deletion quarantine state', () => {
    db.initDatabase();
    db.closeDatabase();

    const legacy = new Database(databasePath);
    legacy.exec(`
      ALTER TABLE external_capability_runs DROP COLUMN container_cleanup_attempt;
      ALTER TABLE external_capability_runs DROP COLUMN container_cleanup_lease_token;
      ALTER TABLE external_capability_workspace_deletion_fences DROP COLUMN quarantined;
      UPDATE router_state SET value = '83' WHERE key = 'schema_version';
    `);
    legacy.close();

    process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = 'true';
    try {
      db.initDatabase();
    } finally {
      delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
    }
    db.closeDatabase();

    const migrated = new Database(databasePath, { readonly: true });
    const runColumns = migrated
      .prepare('PRAGMA table_info(external_capability_runs)')
      .all() as Array<{ name: string }>;
    expect(runColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'container_cleanup_attempt',
        'container_cleanup_lease_token',
      ]),
    );
    const fenceColumns = migrated
      .prepare(
        'PRAGMA table_info(external_capability_workspace_deletion_fences)',
      )
      .all() as Array<{ name: string; dflt_value: string | null }>;
    expect(fenceColumns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'quarantined', dflt_value: '0' }),
      ]),
    );
    expect(
      migrated
        .prepare("SELECT value FROM router_state WHERE key = 'schema_version'")
        .pluck()
        .get(),
    ).toBe(String(CURRENT_SCHEMA_VERSION));
    migrated.close();
  });
});
