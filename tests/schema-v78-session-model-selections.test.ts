import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'schema-v78-session-model-'),
);
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');
const backupDir = path.join(root, 'backups');
const databasePath = path.join(storeDir, 'messages.db');
for (const dir of [storeDir, groupsDir, dataDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

function tableNames(conn: Database.Database): string[] {
  return (
    conn
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

/** Build a current database, then rewind it to a v77 shape on disk. */
beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  db.closeDatabase();

  const legacy = new Database(databasePath);
  legacy.exec('DROP TABLE IF EXISTS session_model_selections');
  legacy
    .prepare(
      "UPDATE router_state SET value = '77' WHERE key = 'schema_version'",
    )
    .run();
  legacy.close();
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v78 session model selections', () => {
  test('backs up the v77 database, creates the table and stamps v78', () => {
    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = backupDir;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe('78');
    const backups = fs.readdirSync(backupDir);
    expect(
      backups.some((name) => name.startsWith('messages-v77-to-v78-')),
    ).toBe(true);

    const backup = new Database(path.join(backupDir, backups[0]), {
      readonly: true,
    });
    expect(tableNames(backup)).not.toContain('session_model_selections');
    backup.close();

    const conn = new Database(databasePath, { readonly: true });
    try {
      expect(tableNames(conn)).toContain('session_model_selections');
      const plan = (
        conn
          .prepare(
            `EXPLAIN QUERY PLAN DELETE FROM session_model_selections
              WHERE model_config_id = ?`,
          )
          .all('provider-a') as Array<{ detail: string }>
      )
        .map((row) => row.detail)
        .join(' | ');
      expect(plan).toContain('idx_session_model_selections_model');
    } finally {
      conn.close();
    }

    db.setSessionModelSelection('main', null, 'provider-a', 'user-1');
    expect(db.getSessionModelSelection('main', null)).toBe('provider-a');
  });

  test('re-running the current schema is a no-op and newer schemas are refused', () => {
    db.closeDatabase();
    const before = fs.readdirSync(backupDir).length;
    db.initDatabase();
    expect(fs.readdirSync(backupDir)).toHaveLength(before);
    expect(db.getSessionModelSelection('main', null)).toBe('provider-a');
    db.closeDatabase();

    const conn = new Database(databasePath);
    conn
      .prepare(
        "UPDATE router_state SET value = '79' WHERE key = 'schema_version'",
      )
      .run();
    conn.close();
    expect(() => db.initDatabase()).toThrow('refusing downgrade');
  });
});
