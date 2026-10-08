import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v75-external-'));
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
  INSERT INTO router_state VALUES ('schema_version', '74');
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

describe('schema v75 external capability foundation', () => {
  test('creates the durable quote capability contract without an active key or invocation', () => {
    process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = 'true';
    try {
      db.initDatabase();
    } finally {
      delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
    }

    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(db.getExternalCapabilities()).toEqual([
      expect.objectContaining({
        slug: 'quote-document-process',
        execution_mode: 'container',
        status: 'draft',
        input_schema_version: 1,
        max_file_bytes: 20 * 1024 * 1024,
        max_files_per_run: 10,
        max_total_bytes: 50 * 1024 * 1024,
      }),
    ]);
    expect(
      db.getExternalCapabilityBySlug('missing-capability'),
    ).toBeUndefined();
  });
});
