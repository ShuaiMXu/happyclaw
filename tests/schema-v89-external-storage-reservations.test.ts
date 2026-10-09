import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../src/schema-version.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v89-storage-'));
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

describe('schema v89 external Vault reservations', () => {
  test('adds durable storage reservation state and indexes', () => {
    db.initDatabase();
    db.closeDatabase();

    const legacy = new Database(databasePath);
    legacy.exec(`
      DROP TABLE external_capability_storage_reservations;
      UPDATE router_state SET value = '88' WHERE key = 'schema_version';
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
    const columns = migrated
      .prepare('PRAGMA table_info(external_capability_storage_reservations)')
      .all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    expect(columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'reservation_key',
          type: 'TEXT',
          notnull: 0,
          pk: 1,
        }),
        expect.objectContaining({
          name: 'state',
          type: 'TEXT',
          notnull: 1,
          dflt_value: "'reserved'",
        }),
        expect.objectContaining({
          name: 'reserved_bytes',
          type: 'INTEGER',
          notnull: 1,
        }),
        expect.objectContaining({
          name: 'occupied_bytes',
          type: 'INTEGER',
          notnull: 1,
          dflt_value: '0',
        }),
        expect.objectContaining({
          name: 'released_at',
          type: 'TEXT',
          notnull: 0,
        }),
      ]),
    );
    const indexes = migrated
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index'
           AND tbl_name = 'external_capability_storage_reservations'`,
      )
      .pluck()
      .all();
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_external_capability_storage_object',
        'idx_external_capability_storage_state',
        'idx_external_capability_storage_reconcile',
        'idx_external_capability_storage_released_gc',
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
