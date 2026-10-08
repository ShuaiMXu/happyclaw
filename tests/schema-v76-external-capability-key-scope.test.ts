import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v76-external-'));
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
  INSERT INTO router_state VALUES ('schema_version', '75');

  CREATE TABLE external_capability_runs (
    id TEXT PRIMARY KEY,
    capability_slug TEXT NOT NULL,
    idempotency_key TEXT,
    external_task_id TEXT NOT NULL,
    tenant_ref TEXT,
    account_ref TEXT,
    callback_context TEXT,
    input_manifest TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attempt INTEGER NOT NULL DEFAULT 0,
    available_at TEXT NOT NULL,
    lease_owner TEXT,
    lease_token INTEGER NOT NULL DEFAULT 0,
    lease_expires_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    result TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_external_capability_runs_idempotency
    ON external_capability_runs(capability_slug, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  CREATE UNIQUE INDEX idx_external_capability_runs_external_task
    ON external_capability_runs(capability_slug, external_task_id);
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

describe('schema v76 external capability credential scope', () => {
  test('adds key_id before replacing global uniqueness with credential-scoped indexes', () => {
    process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = 'true';
    try {
      db.initDatabase();
    } finally {
      delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
    }

    const migrated = new Database(databasePath);
    const columns = migrated
      .prepare('PRAGMA table_info(external_capability_runs)')
      .all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === 'key_id')).toBe(true);

    const indexes = migrated
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'index'
           AND name IN (
             'idx_external_capability_runs_idempotency',
             'idx_external_capability_runs_external_task'
           )
         ORDER BY name`,
      )
      .all() as Array<{ name: string; sql: string }>;
    expect(indexes).toHaveLength(2);
    for (const index of indexes) {
      expect(index.sql).toContain('capability_slug, key_id');
      expect(index.sql).toContain('WHERE key_id IS NOT NULL');
    }

    const insert = migrated.prepare(`
      INSERT INTO external_capability_runs (
        id, capability_slug, key_id, idempotency_key, external_task_id,
        input_manifest, status, attempt, available_at, lease_token,
        created_at, updated_at
      ) VALUES (?, 'quote-document-process', ?, 'shared-idempotency',
        'shared-task', '{}', 'queued', 0, ?, 0, ?, ?)
    `);
    const now = new Date().toISOString();
    insert.run('run-key-a', 'key-a', now, now, now);
    expect(() => insert.run('run-key-b', 'key-b', now, now, now)).not.toThrow();
    expect(() =>
      insert.run('run-key-a-duplicate', 'key-a', now, now, now),
    ).toThrow(/UNIQUE constraint failed/);

    migrated.close();
  });
});
