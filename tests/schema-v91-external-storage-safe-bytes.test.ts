import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../src/schema-version.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v91-storage-'));
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

function replaceStorageTableWithV90(probe: Database.Database): void {
  probe.exec(`
    DROP INDEX IF EXISTS idx_external_capability_storage_object;
    DROP INDEX IF EXISTS idx_external_capability_storage_state;
    DROP INDEX IF EXISTS idx_external_capability_storage_reconcile;
    DROP INDEX IF EXISTS idx_external_capability_storage_released_gc;
    ALTER TABLE external_capability_storage_reservations
      RENAME TO external_capability_storage_reservations_v91;
    CREATE TABLE external_capability_storage_reservations (
      reservation_key TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('input', 'runtime', 'output')),
      object_key TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'reserved'
        CHECK (state IN ('reserved', 'occupied', 'quarantined', 'released')),
      reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
      occupied_bytes INTEGER NOT NULL DEFAULT 0 CHECK (occupied_bytes >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      released_at TEXT
    );
    INSERT INTO external_capability_storage_reservations
      SELECT * FROM external_capability_storage_reservations_v91;
    DROP TABLE external_capability_storage_reservations_v91;
    CREATE UNIQUE INDEX idx_external_capability_storage_object
      ON external_capability_storage_reservations(run_id, kind, object_key);
    CREATE INDEX idx_external_capability_storage_state
      ON external_capability_storage_reservations(state, run_id);
    CREATE INDEX idx_external_capability_storage_reconcile
      ON external_capability_storage_reservations(created_at, reservation_key)
      WHERE state != 'released';
    CREATE INDEX idx_external_capability_storage_released_gc
      ON external_capability_storage_reservations(released_at, reservation_key)
      WHERE state = 'released' AND released_at IS NOT NULL;
    UPDATE router_state SET value = '90' WHERE key = 'schema_version';
  `);
}

afterAll(() => {
  delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  try {
    db.closeDatabase();
  } catch {
    // A rejected migration closes its connection.
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v91 external storage byte bounds', () => {
  test('rebuilds the ledger with safe-integer checks and rejects oversized legacy rows', () => {
    process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
    db.initDatabase();
    db.closeDatabase();

    let probe = new Database(dbPath);
    replaceStorageTableWithV90(probe);
    probe
      .prepare(
        `INSERT INTO external_capability_storage_reservations (
         reservation_key, run_id, kind, object_key, state,
         reserved_bytes, occupied_bytes, created_at, updated_at, released_at
       ) VALUES (?, ?, 'input', ?, 'reserved', ?, ?, ?, ?, NULL)`,
      )
      .run(
        'safe-row',
        'safe-run',
        'safe-object',
        Number.MAX_SAFE_INTEGER,
        1,
        '2026-10-09T00:00:00.000Z',
        '2026-10-09T00:00:00.000Z',
      );
    probe.close();

    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(CURRENT_SCHEMA_VERSION),
    );
    db.closeDatabase();

    probe = new Database(dbPath);
    expect(() =>
      probe.exec(`
        INSERT INTO external_capability_storage_reservations (
          reservation_key, run_id, kind, object_key, state,
          reserved_bytes, occupied_bytes, created_at, updated_at, released_at
        ) VALUES (
          'oversized-new', 'oversized-new-run', 'input', 'oversized-new-object',
          'reserved', 9007199254740992, 0,
          '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z', NULL
        )
      `),
    ).toThrow(/CHECK constraint failed/);
    probe.exec(`
      INSERT INTO external_capability_storage_reservations (
        reservation_key, run_id, kind, object_key, state,
        reserved_bytes, occupied_bytes, created_at, updated_at, released_at
      ) VALUES (
        'aggregate-overflow', 'aggregate-overflow-run', 'input',
        'aggregate-overflow-object', 'reserved', 1, 0,
        '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z', NULL
      )
    `);
    probe.close();
    db.initDatabase();
    expect(() => db.getExternalCapabilityStorageUsageForTest()).toThrow(
      'External capability storage usage overflowed',
    );
    db.closeDatabase();
    probe = new Database(dbPath);
    probe.exec(
      "DELETE FROM external_capability_storage_reservations WHERE reservation_key = 'aggregate-overflow'",
    );

    replaceStorageTableWithV90(probe);
    probe.exec(`
      INSERT INTO external_capability_storage_reservations (
        reservation_key, run_id, kind, object_key, state,
        reserved_bytes, occupied_bytes, created_at, updated_at, released_at
      ) VALUES (
        'oversized-legacy', 'oversized-legacy-run', 'input',
        'oversized-legacy-object', 'reserved', 9007199254740992, 0,
        '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z', NULL
      )
    `);
    probe.close();

    expect(() => db.initDatabase()).toThrow(/CHECK constraint failed/);
  });
});
