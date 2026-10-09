import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-fs-cleanup-'));
const dataDir = path.join(root, 'data');
const storeDir = path.join(dataDir, 'db');
const dbPath = path.join(storeDir, 'messages.db');
const groupsDir = path.join(dataDir, 'groups');
fs.mkdirSync(storeDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'HappyClaw',
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
  MAX_FILE_SIZE: 50 * 1024 * 1024,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const cleanup = await import('../src/workspace-filesystem-cleanup.js');
const fileManager = await import('../src/file-manager.js');

function artifactPaths(folder: string): string[] {
  return [
    path.join(groupsDir, folder),
    path.join(dataDir, 'sessions', folder),
    path.join(dataDir, 'ipc', folder),
    path.join(dataDir, 'env', folder),
    path.join(dataDir, 'memory', folder),
    path.join(dataDir, 'extra', folder),
    path.join(groupsDir, `${folder}.rebuild-backup-test`),
    path.join(dataDir, 'sessions', `${folder}.rebuild-backup-test`),
    path.join(dataDir, 'ipc', `${folder}.rebuild-backup-test`),
    path.join(dataDir, 'memory', `${folder}.rebuild-backup-test`),
    path.join(dataDir, 'config', 'container-env', `${folder}.json`),
    path.join(dataDir, 'config', 'container-env', `${folder}.json.tmp`),
  ];
}

function createArtifacts(folder: string): void {
  for (const target of artifactPaths(folder).slice(0, -2)) {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'artifact'), 'must be removed');
  }
  for (const envConfig of artifactPaths(folder).slice(-2)) {
    fs.mkdirSync(path.dirname(envConfig), { recursive: true });
    fs.writeFileSync(envConfig, '{"secret":"value"}\n');
  }
}

function createWorkspace(jid: string, folder: string): void {
  db.setRegisteredGroup(jid, {
    name: folder,
    folder,
    added_at: new Date().toISOString(),
    executionMode: 'container',
  });
}

beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  db.initDatabase();
});

afterAll(() => {
  vi.restoreAllMocks();
  db.closeDatabase();
  delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('durable workspace filesystem cleanup', () => {
  test('persists the tombstone before the crash window and restores NORMAL mode', () => {
    const jid = 'web:cleanup-crash-window';
    const folder = 'cleanup-crash-window';
    createWorkspace(jid, folder);
    createArtifacts(folder);

    expect(db.getDatabaseSynchronousModeForTest()).toBe(1);
    db.deleteGroupData(jid, folder);
    expect(db.getDatabaseSynchronousModeForTest()).toBe(1);

    expect(db.getRegisteredGroup(jid)).toBeUndefined();
    expect(db.hasWorkspaceFilesystemCleanupTombstone(folder)).toBe(true);
    expect(artifactPaths(folder).every((target) => fs.existsSync(target))).toBe(
      true,
    );

    const probe = db.listWorkspaceFilesystemCleanupOutbox();
    expect(probe).toContainEqual(
      expect.objectContaining({ folder, attempts: 0, last_error: null }),
    );

    const result = cleanup.cleanupWorkspaceFilesystem(folder);
    expect(result).toEqual({ status: 'cleaned', folder });
    expect(
      artifactPaths(folder).every((target) => !fs.existsSync(target)),
    ).toBe(true);
    expect(db.hasWorkspaceFilesystemCleanupTombstone(folder)).toBe(false);
    expect(cleanup.cleanupWorkspaceFilesystem(folder)).toEqual({
      status: 'cleaned',
      folder,
    });
  });

  test('releases the SQLite writer lock before recursive filesystem removal', () => {
    const jid = 'web:cleanup-writer-lock';
    const folder = 'cleanup-writer-lock';
    createWorkspace(jid, folder);
    createArtifacts(folder);
    db.deleteGroupData(jid, folder);

    const originalRm = fs.rmSync;
    let writerCompleted = false;
    const rm = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (!writerCompleted) {
        expect(() =>
          createWorkspace('web:reuse-during-cleanup', folder),
        ).toThrow(db.WorkspaceFolderCleanupPendingError);
        const probe = new Database(dbPath);
        probe.pragma('busy_timeout = 100');
        probe
          .prepare(
            `INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)`,
          )
          .run('workspace_cleanup_writer_probe', 'completed');
        probe.close();
        writerCompleted = true;
      }
      return originalRm(target, options);
    });

    expect(cleanup.cleanupWorkspaceFilesystem(folder)).toEqual({
      status: 'cleaned',
      folder,
    });
    rm.mockRestore();
    expect(writerCompleted).toBe(true);
    expect(db.getRouterState('workspace_cleanup_writer_probe')).toBe(
      'completed',
    );
  });

  test('replays cleanup after a crash between physical deletion and acknowledgement', () => {
    const jid = 'web:cleanup-post-delete-crash';
    const folder = 'cleanup-post-delete-crash';
    createWorkspace(jid, folder);
    createArtifacts(folder);
    db.deleteGroupData(jid, folder);

    const abandoned = db.claimWorkspaceFilesystemCleanup(folder);
    expect(abandoned.status).toBe('claimed');
    fileManager.removeFlowArtifacts(folder);
    expect(db.hasWorkspaceFilesystemCleanupTombstone(folder)).toBe(true);
    expect(cleanup.cleanupWorkspaceFilesystem(folder)).toMatchObject({
      status: 'pending',
      folder,
    });

    expect(db.recoverWorkspaceFilesystemCleanupClaimsOnStartup()).toBe(1);
    expect(cleanup.cleanupWorkspaceFilesystem(folder)).toEqual({
      status: 'cleaned',
      folder,
    });
    expect(db.hasWorkspaceFilesystemCleanupTombstone(folder)).toBe(false);
  });

  test('never supersedes a cleanup claim while physical deletion is in flight', () => {
    const jid = 'web:cleanup-claim-cas';
    const folder = 'cleanup-claim-cas';
    createWorkspace(jid, folder);
    createArtifacts(folder);
    db.deleteGroupData(jid, folder);

    const first = db.claimWorkspaceFilesystemCleanup(folder);
    const second = db.claimWorkspaceFilesystemCleanup(folder);
    expect(first.status).toBe('claimed');
    expect(second).toMatchObject({
      status: 'pending',
      folder,
      error: 'Workspace cleanup is already claimed',
    });
    if (first.status !== 'claimed') return;

    fileManager.removeFlowArtifacts(folder);
    expect(db.completeWorkspaceFilesystemCleanup(first.claim)).toEqual({
      status: 'cleaned',
      folder,
    });
    expect(db.hasWorkspaceFilesystemCleanupTombstone(folder)).toBe(false);
  });

  test('blocks deletion while a non-Web registration still shares the folder', () => {
    const folder = 'cleanup-rollback';
    const primaryJid = 'web:cleanup-rollback-primary';
    const aliasJid = 'qq:cleanup-rollback-alias';
    createWorkspace(primaryJid, folder);
    createWorkspace(aliasJid, folder);
    createArtifacts(folder);

    let failure: unknown;
    try {
      db.deleteGroupData(primaryJid, folder);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(db.SharedWorkspaceFolderDeletionError);
    expect(
      (failure as InstanceType<typeof db.SharedWorkspaceFolderDeletionError>)
        .survivingWorkspaceJids,
    ).toEqual([aliasJid]);
    expect(db.getDatabaseSynchronousModeForTest()).toBe(1);
    expect(db.getRegisteredGroup(primaryJid)).toBeDefined();
    expect(db.getRegisteredGroup(aliasJid)).toBeDefined();
    expect(db.hasWorkspaceFilesystemCleanupTombstone(folder)).toBe(false);
    expect(artifactPaths(folder).every((target) => fs.existsSync(target))).toBe(
      true,
    );

    db.deleteImGroupRecord(aliasJid);
    db.deleteGroupData(primaryJid, folder);
    cleanup.cleanupWorkspaceFilesystem(folder);
  });

  test('permits deletion when a shared registration is rerouted atomically', () => {
    const sourceFolder = 'cleanup-reroute-source';
    const destinationFolder = 'cleanup-reroute-destination';
    const primaryJid = 'web:cleanup-reroute-primary';
    const aliasJid = 'qq:cleanup-reroute-alias';
    createWorkspace(primaryJid, sourceFolder);
    createWorkspace(aliasJid, sourceFolder);
    createWorkspace('web:cleanup-reroute-destination', destinationFolder);
    createArtifacts(sourceFolder);

    const alias = db.getRegisteredGroup(aliasJid)!;
    const channelUpdates = vi.fn(() => [
      {
        jid: aliasJid,
        group: {
          ...alias,
          folder: destinationFolder,
          target_main_jid: undefined,
          target_agent_id: undefined,
          binding_mode: 'single_context' as const,
        },
      },
    ]);

    db.deleteGroupData(primaryJid, sourceFolder, { channelUpdates });

    expect(channelUpdates).toHaveBeenCalledTimes(1);
    expect(db.getRegisteredGroup(primaryJid)).toBeUndefined();
    expect(db.getRegisteredGroup(aliasJid)).toMatchObject({
      folder: destinationFolder,
      binding_mode: 'single_context',
    });
    expect(db.getJidsByFolder(sourceFolder)).toEqual([]);
    expect(db.getJidsByFolder(destinationFolder)).toContain(aliasJid);
    expect(db.hasWorkspaceFilesystemCleanupTombstone(sourceFolder)).toBe(true);
    expect(
      artifactPaths(sourceFolder).every((target) => fs.existsSync(target)),
    ).toBe(true);

    expect(cleanup.cleanupWorkspaceFilesystem(sourceFolder)).toEqual({
      status: 'cleaned',
      folder: sourceFolder,
    });
    expect(
      artifactPaths(sourceFolder).every((target) => !fs.existsSync(target)),
    ).toBe(true);
    expect(db.getRegisteredGroup(aliasJid)?.folder).toBe(destinationFolder);

    db.deleteImGroupRecord(aliasJid);
    db.deleteGroupData('web:cleanup-reroute-destination', destinationFolder);
    cleanup.cleanupWorkspaceFilesystem(destinationFolder);
  });

  test('retains cleanup debt after an env unlink failure and clears it on retry', () => {
    const jid = 'web:cleanup-retry';
    const folder = 'cleanup-retry';
    createWorkspace(jid, folder);
    createArtifacts(folder);
    db.deleteGroupData(jid, folder);

    const envConfig = artifactPaths(folder).at(-1)!;
    const originalUnlink = fs.unlinkSync;
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
      if (String(target) === envConfig) {
        const error = new Error(
          'injected env unlink failure',
        ) as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return originalUnlink(target);
    });

    const first = cleanup.cleanupWorkspaceFilesystem(folder);
    expect(first.status).toBe('pending');
    expect(fs.existsSync(envConfig)).toBe(true);
    expect(db.listWorkspaceFilesystemCleanupOutbox()).toContainEqual(
      expect.objectContaining({ folder, attempts: 1 }),
    );

    unlink.mockRestore();
    expect(cleanup.cleanupWorkspaceFilesystem(folder)).toEqual({
      status: 'cleaned',
      folder,
    });
    expect(fs.existsSync(envConfig)).toBe(false);
    expect(db.hasWorkspaceFilesystemCleanupTombstone(folder)).toBe(false);
  });

  test('startup sweep retries all pending tombstones', () => {
    const folders = ['cleanup-startup-a', 'cleanup-startup-b'];
    for (const folder of folders) {
      const jid = `web:${folder}`;
      createWorkspace(jid, folder);
      createArtifacts(folder);
      db.deleteGroupData(jid, folder);
    }

    expect(cleanup.sweepPendingWorkspaceFilesystemCleanups()).toEqual({
      cleaned: 2,
      pending: 0,
      blocked: 0,
    });
    for (const folder of folders) {
      expect(db.hasWorkspaceFilesystemCleanupTombstone(folder)).toBe(false);
      expect(
        artifactPaths(folder).every((target) => !fs.existsSync(target)),
      ).toBe(true);
    }
  });

  test('rejects folder reuse while preserving ordinary shared-folder aliases', () => {
    const jid = 'web:cleanup-reuse';
    const folder = 'cleanup-reuse';
    createWorkspace(jid, folder);
    createArtifacts(folder);
    db.deleteGroupData(jid, folder);

    expect(() =>
      createWorkspace('web:cleanup-reuse-replacement', folder),
    ).toThrow(db.WorkspaceFolderCleanupPendingError);
    expect(() =>
      db.setRegisteredGroup('qq:cleanup-reuse', {
        name: 'channel reuse',
        folder,
        added_at: new Date().toISOString(),
        executionMode: 'container',
      }),
    ).toThrow(db.WorkspaceFolderCleanupPendingError);

    cleanup.cleanupWorkspaceFilesystem(folder);
    createWorkspace('web:cleanup-shared-primary', 'cleanup-shared');
    createWorkspace('web:cleanup-shared-alias', 'cleanup-shared');
    db.setRegisteredGroup('qq:cleanup-shared', {
      name: 'shared channel',
      folder: 'cleanup-shared',
      added_at: new Date().toISOString(),
      executionMode: 'container',
    });
    expect(db.deleteRegisteredGroup('web:cleanup-shared-alias')).toEqual([]);
    expect(db.hasWorkspaceFilesystemCleanupTombstone('cleanup-shared')).toBe(
      false,
    );
    db.deleteImGroupRecord('qq:cleanup-shared');
    db.deleteGroupData('web:cleanup-shared-primary', 'cleanup-shared');
    cleanup.cleanupWorkspaceFilesystem('cleanup-shared');
  });

  test('sweeper rechecks surviving folder references under the writer lock', () => {
    const jid = 'web:cleanup-survivor';
    const folder = 'cleanup-survivor';
    createWorkspace(jid, folder);
    createArtifacts(folder);
    db.deleteGroupData(jid, folder);

    // Simulate a legacy or concurrent publisher that bypassed the application
    // tombstone check before the cleanup claim acquired SQLite's writer lock.
    const probe = new Database(dbPath);
    probe
      .prepare(
        `INSERT INTO registered_groups (jid, name, folder, added_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        'qq:cleanup-survivor',
        'surviving channel',
        folder,
        new Date().toISOString(),
      );
    probe.close();

    expect(cleanup.cleanupWorkspaceFilesystem(folder)).toEqual({
      status: 'blocked',
      folder,
      survivingJids: ['qq:cleanup-survivor'],
    });
    expect(fs.existsSync(path.join(groupsDir, folder))).toBe(true);
    expect(db.hasWorkspaceFilesystemCleanupTombstone(folder)).toBe(true);

    db.deleteImGroupRecord('qq:cleanup-survivor');
    expect(cleanup.cleanupWorkspaceFilesystem(folder)).toEqual({
      status: 'cleaned',
      folder,
    });
  });
});
