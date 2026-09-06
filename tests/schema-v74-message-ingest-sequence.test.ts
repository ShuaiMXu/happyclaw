import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v74-ingest-'));
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
  INSERT INTO router_state VALUES ('schema_version', '73');
  CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT);
  CREATE TABLE messages (
    id TEXT,
    chat_jid TEXT,
    source_jid TEXT,
    sender TEXT,
    sender_name TEXT,
    content TEXT,
    timestamp TEXT,
    is_from_me INTEGER,
    attachments TEXT,
    token_usage TEXT,
    channel_context TEXT,
    turn_id TEXT,
    session_id TEXT,
    sdk_message_uuid TEXT,
    source_kind TEXT,
    finalization_reason TEXT,
    task_id TEXT,
    delivery_mode TEXT,
    delivery_status TEXT,
    delivery_run_id TEXT,
    delivery_priority INTEGER NOT NULL DEFAULT 0,
    delivery_updated_at TEXT,
    history_recovery_allowed INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (id, chat_jid)
  );
  INSERT INTO chats VALUES ('telegram:migrated', 'Migrated', '2026-08-31T00:00:00Z');
  INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me)
    VALUES ('z-first', 'telegram:migrated', 'u', 'U', 'first', '2026-08-31T00:00:00Z', 0);
  INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me)
    VALUES ('a-second', 'telegram:migrated', 'u', 'U', 'second', '2026-08-31T00:00:00Z', 0);
  INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me)
    VALUES ('late-third', 'telegram:migrated', 'u', 'U', 'third', '2020-01-01T00:00:00Z', 0);
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

describe('schema v74 message ingest sequence migration', () => {
  test('backfills rowid order without a snapshot when explicitly opted out', () => {
    process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = 'true';
    try {
      db.initDatabase();
    } finally {
      delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
    }
    expect(fs.existsSync(path.join(storeDir, 'migration-backups'))).toBe(false);
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );

    const all = db.getMessagesSince('telegram:migrated', {
      timestamp: '',
      id: '',
      sequence: 0,
    });
    expect(all.map((message) => message.id)).toEqual([
      'z-first',
      'a-second',
      'late-third',
    ]);
    expect(all.map((message) => message.ingest_sequence)).toEqual([1, 2, 3]);

    const upgraded = db.resolveMessageCursorSequence(
      {
        timestamp: '2026-08-31T00:00:00Z',
        id: 'a-second',
      },
      'telegram:migrated',
    );
    expect(upgraded.sequence).toBe(2);
    expect(
      db
        .getMessagesSince('telegram:migrated', upgraded)
        .map((message) => message.id),
    ).toEqual(['late-third']);
  });
});
