import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../src/schema-version.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v82-retention-'));
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
  INSERT INTO router_state VALUES ('schema_version', '81');

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
    input_bytes INTEGER NOT NULL DEFAULT 0 CHECK (input_bytes >= 0),
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
    input_bytes, status, available_at, completed_at, created_at, updated_at
  ) VALUES (?, 'quote-document-process', 'legacy-key', ?, ?, 7, ?, ?, ?, ?, ?)
`);
const completedAt = '2026-10-07T12:00:00.000Z';
insert.run(
  'legacy-retention-tombstone',
  'legacy-tombstone-task',
  JSON.stringify({
    retentionTombstone: true,
    retainedInputBytes: 7,
    cleanedAt: '2026-10-08T13:00:00.000Z',
  }),
  'succeeded',
  completedAt,
  completedAt,
  completedAt,
  '2026-10-08T13:00:00.000Z',
);
insert.run(
  'legacy-retention-due',
  'legacy-due-task',
  JSON.stringify({ artifacts: [{ byteLength: 7 }] }),
  'failed',
  completedAt,
  completedAt,
  completedAt,
  completedAt,
);
insert.run(
  'legacy-retention-active',
  'legacy-active-task',
  JSON.stringify({ artifacts: [{ byteLength: 7 }] }),
  'running',
  completedAt,
  null,
  completedAt,
  completedAt,
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

describe('schema v82 external retention index', () => {
  test('backfills tombstone state and indexes only unsanitized terminal runs', () => {
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
          `SELECT id, retention_cleaned_at FROM external_capability_runs
           WHERE id LIKE 'legacy-retention-%' ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { id: 'legacy-retention-active', retention_cleaned_at: null },
      { id: 'legacy-retention-due', retention_cleaned_at: null },
      {
        id: 'legacy-retention-tombstone',
        retention_cleaned_at: '2026-10-08T13:00:00.000Z',
      },
    ]);
    expect(
      migrated
        .prepare("SELECT value FROM router_state WHERE key = 'schema_version'")
        .pluck()
        .get(),
    ).toBe(String(CURRENT_SCHEMA_VERSION));

    const plan = migrated
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM external_capability_runs
         INDEXED BY idx_external_capability_runs_retention_due
         WHERE retention_cleaned_at IS NULL
           AND status IN ('succeeded', 'failed', 'cancelled')
           AND completed_at IS NOT NULL AND completed_at < ?
           AND lease_owner IS NULL AND lease_expires_at IS NULL
         ORDER BY completed_at, id
         LIMIT ?`,
      )
      .all('2026-10-08T12:00:00.000Z', 50) as Array<{ detail: string }>;
    expect(
      plan.some((row) =>
        row.detail.includes('idx_external_capability_runs_retention_due'),
      ),
    ).toBe(true);
    expect(
      plan.some((row) => row.detail.includes('SCAN external_capability_runs')),
    ).toBe(false);
    migrated.close();
  });
});
