import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'schema-v72-image-prompt-presets-'),
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

// A pre-v72 database: no image_prompt_presets table at all. This is a purely
// additive CREATE TABLE IF NOT EXISTS, so the migration only needs to prove
// the table shows up and the CRUD accessors work afterwards.
const legacy = new Database(databasePath);
legacy.exec(`
  CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO router_state VALUES ('schema_version', '71');
`);
legacy.close();

const db = await import('../src/db.js');

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v72 Image Studio prompt presets migration', () => {
  test('creates the presets table and the CRUD accessors round-trip', () => {
    db.initDatabase();

    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );

    const probe = new Database(databasePath, { readonly: true });
    const tables = probe
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='image_prompt_presets'",
      )
      .all();
    expect(tables).toHaveLength(1);
    probe.close();

    // Platform-wide list starts empty.
    expect(db.getActiveImagePromptPresets()).toEqual([]);
    expect(db.getAllImagePromptPresets()).toEqual([]);

    const now = new Date().toISOString();
    const created = db.createImagePromptPreset({
      id: 'preset-1',
      label: '写实照片风',
      prompt: '照片级写实风格，自然光，35mm 街拍构图',
      sort_order: 0,
      is_active: true,
      created_at: now,
      updated_at: now,
    });
    expect(created.id).toBe('preset-1');
    expect(db.getImagePromptPreset('preset-1')?.label).toBe('写实照片风');
    expect(db.getActiveImagePromptPresets()).toHaveLength(1);

    const updated = db.updateImagePromptPreset('preset-1', {
      is_active: false,
      sort_order: 5,
    });
    expect(updated?.is_active).toBe(false);
    expect(updated?.sort_order).toBe(5);
    // Inactive presets drop out of the active-only list...
    expect(db.getActiveImagePromptPresets()).toEqual([]);
    // ...but remain visible to the admin management list.
    expect(db.getAllImagePromptPresets()).toHaveLength(1);

    expect(db.deleteImagePromptPreset('preset-1')).toBe(true);
    expect(db.getImagePromptPreset('preset-1')).toBeUndefined();
    expect(db.deleteImagePromptPreset('preset-1')).toBe(false);
  });
});
