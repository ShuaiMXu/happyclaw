import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../src/schema-version.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v85-fence-lease-'));
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

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v85 external deletion fence leases', () => {
  test('adds lease metadata and recovers an unowned non-quarantined v84 fence', () => {
    db.initDatabase();
    db.closeDatabase();

    const legacy = new Database(databasePath);
    legacy.exec(`
      ALTER TABLE external_capability_workspace_deletion_fences DROP COLUMN owner_id;
      ALTER TABLE external_capability_workspace_deletion_fences DROP COLUMN heartbeat_at;
      ALTER TABLE external_capability_workspace_deletion_fences DROP COLUMN expires_at;
      UPDATE external_capabilities SET status = 'paused' WHERE slug = '${CAPABILITY}';
      INSERT INTO external_capability_workspace_deletion_fences (
        capability_slug, operation_id, previous_status, fenced_status,
        quarantined, created_at
      ) VALUES (
        '${CAPABILITY}', 'legacy-v84-deletion', 'active', 'paused', 0,
        '2026-10-01T00:00:00.000Z'
      );
      UPDATE router_state SET value = '84' WHERE key = 'schema_version';
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
    const fenceColumns = migrated
      .prepare(
        'PRAGMA table_info(external_capability_workspace_deletion_fences)',
      )
      .all() as Array<{ name: string }>;
    expect(fenceColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['owner_id', 'heartbeat_at', 'expires_at']),
    );
    expect(
      migrated
        .prepare(
          'SELECT COUNT(*) FROM external_capability_workspace_deletion_fences',
        )
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      migrated
        .prepare('SELECT status FROM external_capabilities WHERE slug = ?')
        .pluck()
        .get(CAPABILITY),
    ).toBe('active');
    expect(
      migrated
        .prepare("SELECT value FROM router_state WHERE key = 'schema_version'")
        .pluck()
        .get(),
    ).toBe(String(CURRENT_SCHEMA_VERSION));
    migrated.close();
  });
});
