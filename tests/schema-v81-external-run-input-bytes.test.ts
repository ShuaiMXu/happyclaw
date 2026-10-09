import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../src/schema-version.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v81-run-bytes-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');
const databasePath = path.join(storeDir, 'messages.db');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const legacy = new Database(databasePath);
legacy.exec(`
  CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO router_state VALUES ('schema_version', '80');

  CREATE TABLE external_capability_runs (
    id TEXT PRIMARY KEY,
    capability_slug TEXT NOT NULL,
    key_id TEXT,
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
`);
const insert = legacy.prepare(`
  INSERT INTO external_capability_runs (
    id, capability_slug, key_id, external_task_id, input_manifest,
    status, available_at, created_at, updated_at
  ) VALUES (?, 'quote-document-process', 'legacy-key', ?, ?, 'succeeded', ?, ?, ?)
`);
const createdAt = '2026-10-08T12:00:00.000Z';
insert.run(
  'legacy-valid',
  'legacy-valid-task',
  JSON.stringify({ artifacts: [{ byteLength: 3 }, { byteLength: 4 }] }),
  createdAt,
  createdAt,
  createdAt,
);
insert.run(
  'legacy-tombstone',
  'legacy-tombstone-task',
  JSON.stringify({ retentionTombstone: true, retainedInputBytes: 9 }),
  createdAt,
  createdAt,
  createdAt,
);
insert.run(
  'legacy-malformed',
  'legacy-malformed-task',
  '{not-json',
  createdAt,
  createdAt,
  createdAt,
);
insert.run(
  'legacy-invalid-structure',
  'legacy-invalid-structure-task',
  JSON.stringify({ artifacts: [{ byteLength: '7' }] }),
  createdAt,
  createdAt,
  createdAt,
);
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

describe('schema v81 external run input-byte accounting', () => {
  test('backfills bytes and uses one covering rolling-window scan', () => {
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
          `SELECT id, input_bytes FROM external_capability_runs
           WHERE id LIKE 'legacy-%' ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: 'legacy-invalid-structure',
        input_bytes: Number.MAX_SAFE_INTEGER,
      },
      { id: 'legacy-malformed', input_bytes: Number.MAX_SAFE_INTEGER },
      { id: 'legacy-tombstone', input_bytes: 9 },
      { id: 'legacy-valid', input_bytes: 7 },
    ]);
    expect(
      migrated
        .prepare("SELECT value FROM router_state WHERE key = 'schema_version'")
        .pluck()
        .get(),
    ).toBe(String(CURRENT_SCHEMA_VERSION));

    const plan = migrated
      .prepare(
        `EXPLAIN QUERY PLAN SELECT
           SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS minute_count,
           COUNT(*) AS day_count,
           TOTAL(input_bytes) AS input_bytes
         FROM external_capability_runs
         WHERE capability_slug = ? AND key_id = ? AND created_at >= ?`,
      )
      .all(
        '2026-10-08T11:59:00.000Z',
        'quote-document-process',
        'legacy-key',
        '2026-10-07T12:00:00.000Z',
      ) as Array<{ detail: string }>;
    expect(
      plan.some(
        (row) =>
          row.detail.includes('USING COVERING INDEX') &&
          row.detail.includes('idx_external_capability_runs_key_created'),
      ),
    ).toBe(true);
    expect(
      plan.some((row) => row.detail.includes('SCAN external_capability_runs')),
    ).toBe(false);
    migrated.close();

    const preRepair = new Database(databasePath);
    preRepair
      .prepare(
        `UPDATE external_capability_runs
         SET input_manifest = ?, input_bytes = 0 WHERE id = 'legacy-valid'`,
      )
      .run(JSON.stringify({ artifacts: [{ byteLength: '7' }] }));
    preRepair
      .prepare(
        "UPDATE router_state SET value = '86' WHERE key = 'schema_version'",
      )
      .run();
    preRepair.close();

    process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = 'true';
    try {
      db.initDatabase();
    } finally {
      delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
    }
    db.closeDatabase();
    const repaired = new Database(databasePath, { readonly: true });
    expect(
      repaired
        .prepare(
          `SELECT input_bytes FROM external_capability_runs
           WHERE id = 'legacy-valid'`,
        )
        .get(),
    ).toEqual({ input_bytes: Number.MAX_SAFE_INTEGER });
    repaired.close();
  });
});
