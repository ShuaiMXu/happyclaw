import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'schema-v71-workspace-image-generation-'),
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

// A pre-v71 database: workspace_agent_profiles exists without the image
// generation columns. ALTER TABLE ADD COLUMN preserves existing rows by
// construction, so this test only needs to assert the columns arrive and the
// accessors are safe to call.
const legacy = new Database(databasePath);
legacy.exec(`
  CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO router_state VALUES ('schema_version', '70');
  CREATE TABLE workspace_agent_profiles (
    group_folder TEXT PRIMARY KEY,
    agent_profile_id TEXT NOT NULL,
    interaction_mode TEXT NOT NULL DEFAULT 'assistant'
      CHECK (interaction_mode IN ('assistant', 'proactive')),
    locked_model_config_id TEXT,
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

describe('schema v71 Workspace image generation migration', () => {
  test('adds the switch and model columns on upgrade, defaulting to off', () => {
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
      columns.some((column) => column.name === 'image_generation_enabled'),
    ).toBe(true);
    expect(
      columns.some((column) => column.name === 'image_generation_model'),
    ).toBe(true);
    probe.close();

    // Unknown workspaces report the safe default.
    expect(db.getWorkspaceImageGenerationConfig('never-existed')).toEqual({
      enabled: false,
      model: null,
    });

    // The setter round-trips through a real binding (reconcile pass removes
    // bindings whose workspace row is missing, so create one properly).
    db.assignWorkspaceAgentProfile('imaging-workspace', 'profile-1');
    expect(db.getWorkspaceImageGenerationConfig('imaging-workspace')).toEqual({
      enabled: false,
      model: null,
    });

    expect(
      db.setWorkspaceImageGenerationConfig(
        'imaging-workspace',
        true,
        'gpt-image-2',
      ),
    ).toBe(true);
    expect(db.getWorkspaceImageGenerationConfig('imaging-workspace')).toEqual({
      enabled: true,
      model: 'gpt-image-2',
    });
    expect(
      db.getWorkspaceAgentProfileBinding('imaging-workspace')
        ?.image_generation_enabled,
    ).toBe(true);

    // Turning it off keeps the last model choice for a faster re-enable.
    db.setWorkspaceImageGenerationConfig(
      'imaging-workspace',
      false,
      'gpt-image-2',
    );
    expect(db.getWorkspaceImageGenerationConfig('imaging-workspace')).toEqual({
      enabled: false,
      model: 'gpt-image-2',
    });

    // A missing binding cannot store the flag.
    expect(
      db.setWorkspaceImageGenerationConfig('missing-workspace', true, null),
    ).toBe(false);
  });
});
