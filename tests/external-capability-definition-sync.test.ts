import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

import {
  QUOTE_DOCUMENT_CAPABILITY_SLUG,
  QUOTE_DOCUMENT_CAPABILITY_TARGET,
} from '../src/external-capability-definitions.js';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'external-definition-sync-'),
);
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
const configured = await import('../src/external-capabilities.js');

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('external capability definition synchronization', () => {
  test('pauses an active capability while atomically restoring server-owned routing', () => {
    db.initDatabase();
    const now = new Date().toISOString();
    db.createUser({
      id: 'definition-sync-owner',
      username: 'definition-sync-owner',
      password_hash: 'hash',
      display_name: 'Definition sync owner',
      role: 'member',
      status: 'active',
      created_at: now,
      updated_at: now,
      must_change_password: false,
    });
    db.setRegisteredGroup(QUOTE_DOCUMENT_CAPABILITY_TARGET.workspaceJid, {
      name: 'Definition sync workspace',
      folder: QUOTE_DOCUMENT_CAPABILITY_TARGET.workspaceFolder,
      added_at: now,
      executionMode: 'container',
      created_by: 'definition-sync-owner',
    });
    expect(
      db.setExternalCapabilityStatus(QUOTE_DOCUMENT_CAPABILITY_SLUG, 'active'),
    ).toBe(true);
    db.closeDatabase();

    const drifted = new Database(databasePath);
    drifted
      .prepare(
        `UPDATE external_capabilities
         SET workspace_jid = ?, workspace_folder = ?, max_files_per_run = 99
         WHERE slug = ?`,
      )
      .run(
        'web:drifted-workspace',
        'drifted-folder',
        QUOTE_DOCUMENT_CAPABILITY_SLUG,
      );
    drifted.close();

    db.initDatabase();
    expect(
      db.getExternalCapabilityBySlug(QUOTE_DOCUMENT_CAPABILITY_SLUG),
    ).toMatchObject({
      workspace_jid: QUOTE_DOCUMENT_CAPABILITY_TARGET.workspaceJid,
      workspace_folder: QUOTE_DOCUMENT_CAPABILITY_TARGET.workspaceFolder,
      execution_mode: QUOTE_DOCUMENT_CAPABILITY_TARGET.executionMode,
      max_files_per_run: 10,
      status: 'paused',
    });
    expect(
      configured.getConfiguredExternalCapability(
        QUOTE_DOCUMENT_CAPABILITY_SLUG,
      ),
    ).toMatchObject({
      workspace_jid: QUOTE_DOCUMENT_CAPABILITY_TARGET.workspaceJid,
      workspace_folder: QUOTE_DOCUMENT_CAPABILITY_TARGET.workspaceFolder,
      execution_mode: QUOTE_DOCUMENT_CAPABILITY_TARGET.executionMode,
      status: 'paused',
    });
  });

  test('pauses a capability and preserves accepted work when its workspace switches to host mode', () => {
    expect(
      db.setExternalCapabilityStatus(QUOTE_DOCUMENT_CAPABILITY_SLUG, 'active'),
    ).toBe(true);
    const createdKey = db.createExternalCapabilityKey({
      capabilitySlug: QUOTE_DOCUMENT_CAPABILITY_SLUG,
      label: 'workspace mode transition',
    });
    const created = db.createExternalCapabilityRun({
      capabilitySlug: QUOTE_DOCUMENT_CAPABILITY_SLUG,
      keyId: createdKey.key.id,
      externalTaskId: 'workspace-mode-transition',
      inputManifest: { version: 1 },
    });
    const firstClaim = db.claimNextExternalCapabilityRun(
      'workspace-mode-worker',
      60_000,
    );
    expect(firstClaim?.id).toBe(created.run.id);

    const group = db.getRegisteredGroup(
      QUOTE_DOCUMENT_CAPABILITY_TARGET.workspaceJid,
    )!;
    db.setRegisteredGroup(QUOTE_DOCUMENT_CAPABILITY_TARGET.workspaceJid, {
      ...group,
      executionMode: 'host',
    });

    expect(
      db.getExternalCapabilityBySlug(QUOTE_DOCUMENT_CAPABILITY_SLUG)?.status,
    ).toBe('paused');
    expect(db.getExternalCapabilityRunById(created.run.id)).toMatchObject({
      status: 'retry_wait',
      attempt: 0,
      lease_owner: null,
      error_code: 'CAPABILITY_UNAVAILABLE',
    });

    db.setRegisteredGroup(QUOTE_DOCUMENT_CAPABILITY_TARGET.workspaceJid, {
      ...group,
      executionMode: 'container',
    });
    expect(
      db.setExternalCapabilityStatus(QUOTE_DOCUMENT_CAPABILITY_SLUG, 'active'),
    ).toBe(true);
    expect(
      db.claimNextExternalCapabilityRun('workspace-mode-worker-2', 60_000)?.id,
    ).toBe(created.run.id);
    expect(
      db.cancelExternalCapabilityRun(
        QUOTE_DOCUMENT_CAPABILITY_SLUG,
        createdKey.key.id,
        created.run.id,
      )?.cancelled,
    ).toBe(true);
  });

  test('bulk Host-only migration pauses the target capability without losing queued work', () => {
    const now = new Date().toISOString();
    db.createUser({
      id: 'definition-sync-admin',
      username: 'definition-sync-admin',
      password_hash: 'hash',
      display_name: 'Definition sync admin',
      role: 'admin',
      status: 'active',
      created_at: now,
      updated_at: now,
      must_change_password: false,
    });
    const group = db.getRegisteredGroup(
      QUOTE_DOCUMENT_CAPABILITY_TARGET.workspaceJid,
    )!;
    db.setRegisteredGroup(QUOTE_DOCUMENT_CAPABILITY_TARGET.workspaceJid, {
      ...group,
      executionMode: 'container',
      created_by: 'definition-sync-admin',
    });
    expect(
      db.setExternalCapabilityStatus(QUOTE_DOCUMENT_CAPABILITY_SLUG, 'active'),
    ).toBe(true);
    const createdKey = db.createExternalCapabilityKey({
      capabilitySlug: QUOTE_DOCUMENT_CAPABILITY_SLUG,
      label: 'bulk mode transition',
    });
    const created = db.createExternalCapabilityRun({
      capabilitySlug: QUOTE_DOCUMENT_CAPABILITY_SLUG,
      keyId: createdKey.key.id,
      externalTaskId: 'bulk-workspace-mode-transition',
      inputManifest: { version: 1 },
    });

    expect(db.forceActiveAdminRuntimesToHost().affectedGroups).toEqual([
      expect.objectContaining({
        jid: QUOTE_DOCUMENT_CAPABILITY_TARGET.workspaceJid,
      }),
    ]);
    expect(
      db.getExternalCapabilityBySlug(QUOTE_DOCUMENT_CAPABILITY_SLUG)?.status,
    ).toBe('paused');
    expect(db.getExternalCapabilityRunById(created.run.id)?.status).toBe(
      'queued',
    );
    expect(db.claimNextExternalCapabilityRun('bulk-mode-worker', 60_000)).toBe(
      undefined,
    );
  });
});
