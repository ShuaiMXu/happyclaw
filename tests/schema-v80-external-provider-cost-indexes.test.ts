import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../src/schema-version.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v80-cost-indexes-'));
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

const EXPOSURE_SQL = `
  SELECT created_at, SUM(
    CASE
      WHEN state IN ('active', 'uncertain')
        THEN MAX(reserved_microusd, actual_microusd)
      WHEN state = 'settled' THEN actual_microusd
      ELSE 0
    END
  ) AS exposure
  FROM external_capability_cost_reservations
  WHERE state IN ('active', 'settled', 'uncertain')
    AND created_at >= ?`;

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function explain(
  probe: Database.Database,
  scopeSql = '',
  scopeValue?: string,
): string[] {
  const statement = probe.prepare(
    `EXPLAIN QUERY PLAN ${EXPOSURE_SQL} ${scopeSql}
     GROUP BY created_at
     HAVING exposure > 0`,
  );
  const rows = (
    scopeValue === undefined
      ? statement.all('2026-10-08T00:00:00.000Z')
      : statement.all('2026-10-08T00:00:00.000Z', scopeValue)
  ) as Array<{ detail: string }>;
  return rows.map((row) => row.detail);
}

describe('schema v80 external Provider cost indexes', () => {
  test('replaces the state-first index and indexes all rolling exposure scopes', () => {
    db.initDatabase();
    db.closeDatabase();

    const legacy = new Database(databasePath);
    legacy.exec(`
      DROP INDEX idx_external_capability_cost_created;
      DROP INDEX idx_external_capability_cost_capability_created;
      DROP INDEX idx_external_capability_cost_key_created;
      CREATE INDEX idx_external_capability_cost_scope
        ON external_capability_cost_reservations(
          state, created_at, capability_slug, key_id
        );
      UPDATE router_state SET value = '79' WHERE key = 'schema_version';
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
    const indexes = migrated
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index'
           AND name LIKE 'idx_external_capability_cost_%'
         ORDER BY name`,
      )
      .pluck()
      .all() as string[];
    expect(indexes).toEqual([
      'idx_external_capability_cost_capability_created',
      'idx_external_capability_cost_capability_settled',
      'idx_external_capability_cost_created',
      'idx_external_capability_cost_key_created',
      'idx_external_capability_cost_key_settled',
      'idx_external_capability_cost_settled',
    ]);
    expect(
      migrated
        .prepare("SELECT value FROM router_state WHERE key = 'schema_version'")
        .pluck()
        .get(),
    ).toBe(String(CURRENT_SCHEMA_VERSION));

    const plans = [
      {
        details: explain(migrated),
        index: 'idx_external_capability_cost_created',
      },
      {
        details: explain(
          migrated,
          'AND capability_slug = ?',
          'quote-document-process',
        ),
        index: 'idx_external_capability_cost_capability_created',
      },
      {
        details: explain(migrated, 'AND key_id = ?', 'key-test'),
        index: 'idx_external_capability_cost_key_created',
      },
    ];
    for (const plan of plans) {
      expect(plan.details.some((detail) => detail.includes(plan.index))).toBe(
        true,
      );
      expect(
        plan.details.some((detail) =>
          detail.includes('SCAN external_capability_cost_reservations'),
        ),
      ).toBe(false);
    }
    migrated.close();
  });
});
