import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'db-upgrade-safety-'));
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
const dbPath = path.join(store, 'messages.db');
const migrationBackups = path.join(tmp, 'migration-backups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock('../src/config.js', () => ({ STORE_DIR: store, GROUPS_DIR: groups }));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

afterAll(() => {
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  try {
    db.closeDatabase();
  } catch {
    // A failed migration deliberately closes its connection.
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function tableExists(probe: Database.Database, table: string): boolean {
  return Boolean(
    probe
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

describe('database upgrade safety gate', () => {
  test('backs up before destructive migration, preserves audit orphans, and aborts when backup fails', () => {
    db.initDatabase();
    db.closeDatabase();
    expect(fs.existsSync(migrationBackups)).toBe(false);

    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE group_members (
        group_folder TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        added_at TEXT NOT NULL,
        added_by TEXT,
        PRIMARY KEY (group_folder, user_id)
      );
      INSERT INTO group_members VALUES (
        'audit-workspace', 'legacy-member', 'member',
        '2026-07-16T00:00:00.000Z', 'operator'
      );
      INSERT INTO balance_transactions (
        user_id, type, amount_usd, balance_after, description,
        source, operator_type, created_at
      ) VALUES (
        'deleted-user', 'adjustment', 12.5, 12.5, 'retained audit evidence',
        'system_adjustment', 'system', '2026-07-16T00:00:00.000Z'
      );
      UPDATE router_state SET value = '39' WHERE key = 'schema_version';
    `);
    legacy.close();

    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = migrationBackups;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    db.closeDatabase();

    const backupNames = fs.readdirSync(migrationBackups);
    expect(backupNames).toHaveLength(1);
    const backup = new Database(path.join(migrationBackups, backupNames[0]), {
      readonly: true,
    });
    expect(
      (
        backup
          .prepare(
            "SELECT value FROM router_state WHERE key = 'schema_version'",
          )
          .get() as { value: string }
      ).value,
    ).toBe('39');
    expect(tableExists(backup, 'group_members')).toBe(true);
    expect(
      (
        backup
          .prepare(
            "SELECT COUNT(*) AS count FROM balance_transactions WHERE user_id = 'deleted-user'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    backup.close();

    const migrated = new Database(dbPath);
    expect(tableExists(migrated, 'group_members')).toBe(false);
    expect(
      (
        migrated
          .prepare(
            "SELECT COUNT(*) AS count FROM balance_transactions WHERE user_id = 'deleted-user'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    migrated.exec(`
      CREATE TABLE group_members (
        group_folder TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        added_at TEXT NOT NULL,
        added_by TEXT,
        PRIMARY KEY (group_folder, user_id)
      );
      INSERT INTO group_members VALUES (
        'must-survive', 'legacy-member', 'member',
        '2026-07-16T00:00:00.000Z', 'operator'
      );
      UPDATE router_state SET value = '50' WHERE key = 'schema_version';
    `);
    migrated.close();

    const invalidBackupDir = path.join(tmp, 'not-a-directory');
    fs.writeFileSync(invalidBackupDir, 'blocks mkdir');
    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = invalidBackupDir;
    expect(() => db.initDatabase()).toThrow(/pre-migration backup failed/);

    const afterFailure = new Database(dbPath, { readonly: true });
    expect(tableExists(afterFailure, 'group_members')).toBe(true);
    expect(
      (
        afterFailure
          .prepare(
            "SELECT value FROM router_state WHERE key = 'schema_version'",
          )
          .get() as { value: string }
      ).value,
    ).toBe('50');
    afterFailure.close();

    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = migrationBackups;
    const backupsBeforeCurrentOnlyRefusal = fs.readdirSync(migrationBackups);
    expect(() => db.initDatabase({ requireCurrentSchema: true })).toThrow(
      `Database must already be schema v${db.CURRENT_SCHEMA_VERSION}`,
    );
    expect(fs.readdirSync(migrationBackups)).toEqual(
      backupsBeforeCurrentOnlyRefusal,
    );
    const afterCurrentOnlyRefusal = new Database(dbPath, { readonly: true });
    expect(
      (
        afterCurrentOnlyRefusal
          .prepare(
            "SELECT value FROM router_state WHERE key = 'schema_version'",
          )
          .get() as { value: string }
      ).value,
    ).toBe('50');
    afterCurrentOnlyRefusal.close();

    db.initDatabase();
    db.closeDatabase();
    const backupCountAfterRetry = fs.readdirSync(migrationBackups).length;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    db.closeDatabase();
    expect(fs.readdirSync(migrationBackups)).toHaveLength(
      backupCountAfterRetry,
    );
  });

  test('backs up every legacy version and preserves all registered-group columns while removing the folder uniqueness constraint', () => {
    const legacy = new Database(dbPath);
    const columns = legacy
      .prepare('PRAGMA table_info(registered_groups)')
      .all() as {
      cid: number;
      name: string;
      type: string;
      notnull: 0 | 1;
      dflt_value: string | null;
      pk: number;
    }[];
    const quoteIdentifier = (identifier: string): string =>
      `"${identifier.replaceAll('"', '""')}"`;
    const orderedColumns = columns.sort((left, right) => left.cid - right.cid);
    const columnNames = orderedColumns.map((column) =>
      quoteIdentifier(column.name),
    );
    const definitions = orderedColumns.map((column) => {
      const parts = [quoteIdentifier(column.name)];
      if (column.type.trim()) parts.push(column.type);
      if (column.pk > 0) parts.push('PRIMARY KEY');
      if (column.notnull) parts.push('NOT NULL');
      if (column.name === 'folder') parts.push('UNIQUE');
      if (column.dflt_value !== null) {
        parts.push(`DEFAULT ${column.dflt_value}`);
      }
      return parts.join(' ');
    });
    legacy.exec(`
      CREATE TABLE registered_groups_legacy (${definitions.join(', ')});
      INSERT INTO registered_groups_legacy (${columnNames.join(', ')})
        SELECT ${columnNames.join(', ')} FROM registered_groups;
      DROP TABLE registered_groups;
      ALTER TABLE registered_groups_legacy RENAME TO registered_groups;
      INSERT INTO registered_groups (
        jid, name, folder, added_at, container_config, execution_mode,
        custom_cwd, init_source_path, init_git_url, created_by, is_home,
        avatar_url, selected_skills, target_agent_id, target_main_jid,
        reply_policy, require_mention, mcp_mode, selected_mcps,
        activation_mode, audience_mode, owner_claim_source,
        conversation_source, conversation_nav_mode, binding_mode,
        native_context_type, feishu_chat_mode, feishu_group_message_type,
        sender_allowlist, channel_account_id
      ) VALUES (
        'legacy:all-columns', 'Legacy', 'shared-folder',
        '2026-07-17T00:00:00.000Z', '{"memory":512}', 'host',
        '/srv/legacy', '/srv/source', 'https://example.invalid/repo.git',
        'legacy-owner', 0, 'https://example.invalid/avatar.png',
        '["skill-a"]', 'agent-1', 'web:target', 'mirror', 1,
        'custom', '["mcp-a"]', 'disabled', 'everyone', 'configured',
        'channel', 'vertical', 'native_context', 'thread', 'topic',
        'thread', '["sender-a"]', 'account-a'
      );
      UPDATE router_state SET value = '38' WHERE key = 'schema_version';
    `);
    legacy.close();

    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = migrationBackups;
    const backupCountBefore = fs.readdirSync(migrationBackups).length;
    db.initDatabase();
    const migrated = new Database(dbPath);
    expect(
      migrated
        .prepare(
          `SELECT selected_skills, target_agent_id, target_main_jid,
                  reply_policy, require_mention, mcp_mode, selected_mcps,
                  activation_mode, audience_mode, owner_claim_source,
                  conversation_source, conversation_nav_mode, binding_mode,
                  native_context_type, feishu_chat_mode,
                  feishu_group_message_type, sender_allowlist,
                  channel_account_id
           FROM registered_groups WHERE jid = 'legacy:all-columns'`,
        )
        .get(),
    ).toEqual({
      selected_skills: '["skill-a"]',
      target_agent_id: 'agent-1',
      target_main_jid: 'web:target',
      reply_policy: 'mirror',
      require_mention: 1,
      mcp_mode: 'custom',
      selected_mcps: '["mcp-a"]',
      activation_mode: 'disabled',
      audience_mode: 'everyone',
      owner_claim_source: 'configured',
      conversation_source: 'channel',
      conversation_nav_mode: 'vertical',
      binding_mode: 'native_context',
      native_context_type: 'thread',
      feishu_chat_mode: 'topic',
      feishu_group_message_type: 'thread',
      sender_allowlist: '["sender-a"]',
      channel_account_id: 'account-a',
    });
    expect(() =>
      migrated
        .prepare(
          `INSERT INTO registered_groups (jid, name, folder, added_at)
           VALUES ('legacy:second', 'Second', 'shared-folder',
                   '2026-07-17T00:00:01.000Z')`,
        )
        .run(),
    ).not.toThrow();
    migrated.close();
    db.closeDatabase();
    expect(fs.readdirSync(migrationBackups)).toHaveLength(
      backupCountBefore + 1,
    );

    const unversioned = new Database(dbPath);
    unversioned
      .prepare("DELETE FROM router_state WHERE key = 'schema_version'")
      .run();
    unversioned.close();
    const beforeUnversionedUpgrade = fs.readdirSync(migrationBackups).length;
    db.initDatabase();
    db.closeDatabase();
    expect(fs.readdirSync(migrationBackups)).toHaveLength(
      beforeUnversionedUpgrade + 1,
    );
  });
});

describe('schema version head', () => {
  test('pins the head version so a bump stays a reviewed decision', () => {
    // Deliberately a literal. The migration tests above compare against
    // CURRENT_SCHEMA_VERSION, which makes each of them tautological on its
    // own: initDatabase stores the very constant they assert on. This is the
    // one assertion that fails when the head moves, forcing whoever bumps it
    // to confirm the matching migration block — and a test covering it —
    // actually landed. Update the literal in the same commit as the migration.
    // v75: adds mount-specific interaction overrides and records the SDK
    // session's interaction contract without changing workspace defaults.
    // Migration and restart coverage: channel-mount-interaction-mode.test.ts.
    // v76: adds external capability definitions, scoped API keys, runs, files,
    // events, leases, quotas, retention metadata, and key-scoped idempotency.
    // v77: adds durable intake reservations and operation-specific API rate
    // windows for external capability admission.
    // v78: adds Provider-cost reservations and exactly-once external usage
    // events for rolling cost exposure and terminal settlement.
    // v79: bounds intake-attempt and rolling ingress accounting.
    // v80: adds indexed Provider-cost exposure scans.
    // v81: persists accepted input bytes for indexed rolling admission.
    // v82: adds indexed durable external-run retention cleanup state.
    // v83: adds operation-owned external workspace-deletion fences.
    // v84: persists physical-container cleanup ownership and deletion quarantine.
    // v85: leases deletion fences across live service processes.
    // v86: conservatively backfills Provider-cost exposure for legacy STARTed runs.
    // v87: repairs ingress completion windows and invalid zero-byte manifests.
    // v88: persists in-flight Docker-create deadlines outside SQLite locks.
    // v89: adds durable external Vault byte reservations and occupancy state.
    // v90: adds bounded reconciliation and released-reservation GC indexes.
    // v91: bounds Vault ledger bytes to JavaScript's exact integer range.
    // v92: indexes settled Provider exposure by settlement time.
    // v93: adds durable folder-keyed workspace filesystem cleanup tombstones.
    // Migration coverage: schema-v75-external-capabilities.test.ts,
    // schema-v76-external-capability-key-scope.test.ts,
    // schema-v80-external-provider-cost-indexes.test.ts,
    // schema-v81-external-run-input-bytes.test.ts,
    // schema-v82-external-retention-index.test.ts,
    // schema-v84-external-container-cleanup.test.ts,
    // schema-v85-external-deletion-fence-leases.test.ts,
    // schema-v86-external-cost-backfill.test.ts,
    // schema-v88-external-container-create-pending.test.ts,
    // schema-v89-external-storage-reservations.test.ts,
    // schema-v91-external-storage-safe-bytes.test.ts,
    // schema-v93-workspace-filesystem-cleanup.test.ts,
    // external-capability-intake-reservation.test.ts,
    // external-capability-storage-reservation.test.ts, and
    // external-capability-workspace-deletion.test.ts.
    expect(db.CURRENT_SCHEMA_VERSION).toBe(93);
  });
});
