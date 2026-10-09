import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v93-cleanup-'));
const storeDir = path.join(root, 'store');
const dbPath = path.join(storeDir, 'messages.db');
fs.mkdirSync(storeDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

afterAll(() => {
  delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  try {
    db.closeDatabase();
  } catch {
    // Already closed by the test.
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v93 workspace filesystem cleanup outbox', () => {
  test('migrates v92 databases with a folder-keyed durable tombstone table', () => {
    process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
    db.initDatabase();
    db.closeDatabase();

    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP TABLE workspace_filesystem_cleanup_outbox;
      UPDATE router_state SET value = '92' WHERE key = 'schema_version';
    `);
    legacy.close();

    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    db.closeDatabase();

    const migrated = new Database(dbPath, { readonly: true });
    const columns = migrated
      .prepare('PRAGMA table_info(workspace_filesystem_cleanup_outbox)')
      .all() as Array<{ name: string; pk: number; notnull: number }>;
    expect(columns.map((column) => column.name)).toEqual([
      'folder',
      'revision',
      'claim_owner',
      'claim_token',
      'created_at',
      'updated_at',
      'attempts',
      'last_error',
    ]);
    expect(columns.find((column) => column.name === 'folder')).toMatchObject({
      pk: 1,
      notnull: 0,
    });
    migrated.close();
  });
});
