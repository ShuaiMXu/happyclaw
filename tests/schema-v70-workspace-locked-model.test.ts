import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'schema-v70-workspace-locked-model-'),
);
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const databasePath = path.join(storeDir, 'messages.db');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// A pre-v70 database: workspace_agent_profiles exists without the lock column.
// ALTER TABLE ADD COLUMN preserves existing rows by construction, so this test
// only needs to assert the column arrives and the accessor is safe to call.
const legacy = new Database(databasePath);
legacy.exec(`
  CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO router_state VALUES ('schema_version', '69');
  CREATE TABLE workspace_agent_profiles (
    group_folder TEXT PRIMARY KEY,
    agent_profile_id TEXT NOT NULL,
    interaction_mode TEXT NOT NULL DEFAULT 'assistant'
      CHECK (interaction_mode IN ('assistant', 'proactive')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
legacy.close();

const db = await import('../src/db.js');

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v70 Workspace locked model migration', () => {
  test('adds a nullable locked_model_config_id column on upgrade', () => {
    db.initDatabase();

    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );

    const probe = new Database(databasePath, { readonly: true });
    const columns = probe.pragma(
      'table_info(workspace_agent_profiles)',
    ) as Array<{
      name: string;
    }>;
    expect(
      columns.some((column) => column.name === 'locked_model_config_id'),
    ).toBe(true);
    probe.close();

    // The accessor is safe to call on upgraded databases and reports no lock.
    expect(db.getWorkspaceLockedModelConfigId('any-workspace')).toBeNull();
  });
});
