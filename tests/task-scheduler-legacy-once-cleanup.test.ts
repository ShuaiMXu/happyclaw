import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-once-cleanup-'));
const store = path.join(root, 'db');
const groupsRoot = path.join(root, 'groups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groupsRoot, { recursive: true });

vi.mock(import('../src/config.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  DATA_DIR: root,
  STORE_DIR: store,
  GROUPS_DIR: groupsRoot,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { cleanupLegacyOnceTaskWorkspace } =
  await import('../src/task-scheduler.js');

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function seedLegacyOnceTask(id: string) {
  const jid = `web:${id}`;
  const folder = `task-${id}`;
  const now = new Date().toISOString();
  db.setRegisteredGroup(jid, {
    name: id,
    folder,
    added_at: now,
  } as any);
  db.createTask({
    id,
    group_folder: folder,
    chat_jid: jid,
    prompt: 'legacy once task',
    schedule_type: 'once',
    schedule_value: now,
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: 'container',
    script_command: null,
    workspace_jid: jid,
    workspace_folder: folder,
    next_run: now,
    status: 'active',
    created_at: now,
    notify_channels: null,
  });
  db.updateTaskAfterRun(id, null, 'done');
  fs.mkdirSync(path.join(groupsRoot, folder), { recursive: true });
  fs.writeFileSync(path.join(groupsRoot, folder, 'sentinel.txt'), 'remove me');
  return { jid, folder, task: db.getTaskById(id)! };
}

function cleanupDeps(jid: string) {
  const groups: Record<string, any> = {
    [jid]: db.getRegisteredGroup(jid),
  };
  const pauseToken = { id: 1 };
  const queue = {
    listDescendantJids: vi.fn(() => []),
    pauseGroupsForMutation: vi.fn(() => pauseToken),
    stopGroup: vi.fn(async () => {}),
    discardGroupsAfterMutation: vi.fn(),
    resumeGroupsAfterMutation: vi.fn(),
  };
  return {
    groups,
    queue,
    deps: {
      registeredGroups: () => groups,
      queue,
    } as any,
    pauseToken,
  };
}

describe('legacy once-task workspace cleanup', () => {
  test('deletes only after queue teardown and consumes the mutation gate', async () => {
    const seeded = seedLegacyOnceTask('cleanup-success');
    const { deps, groups, queue, pauseToken } = cleanupDeps(seeded.jid);

    await expect(
      cleanupLegacyOnceTaskWorkspace(seeded.task, deps),
    ).resolves.toBe('cleaned');

    expect(queue.pauseGroupsForMutation).toHaveBeenCalledWith([seeded.jid]);
    expect(queue.stopGroup).toHaveBeenCalledWith(seeded.jid, {
      force: true,
      preserveQueuedWork: true,
    });
    expect(queue.discardGroupsAfterMutation).toHaveBeenCalledWith(pauseToken);
    expect(queue.resumeGroupsAfterMutation).not.toHaveBeenCalled();
    expect(db.getRegisteredGroup(seeded.jid)).toBeUndefined();
    expect(db.getTaskById(seeded.task.id)).toBeUndefined();
    expect(groups[seeded.jid]).toBeUndefined();
    expect(fs.existsSync(path.join(groupsRoot, seeded.folder))).toBe(false);
  });

  test('skips a stale timer after the completed task is edited and reactivated', async () => {
    const seeded = seedLegacyOnceTask('cleanup-reactivated');
    const { deps, queue } = cleanupDeps(seeded.jid);
    db.updateTask(seeded.task.id, {
      schedule_value: new Date(Date.now() + 60_000).toISOString(),
      next_run: new Date(Date.now() + 60_000).toISOString(),
      status: 'active',
    });

    await expect(
      cleanupLegacyOnceTaskWorkspace(seeded.task, deps),
    ).resolves.toBe('skipped');

    expect(queue.pauseGroupsForMutation).not.toHaveBeenCalled();
    expect(db.getRegisteredGroup(seeded.jid)).toBeDefined();
    expect(db.getTaskById(seeded.task.id)).toMatchObject({ status: 'active' });
    expect(fs.existsSync(path.join(groupsRoot, seeded.folder))).toBe(true);
  });

  test('restores queued work when runner teardown fails before deletion', async () => {
    const seeded = seedLegacyOnceTask('cleanup-stop-failure');
    const { deps, queue, pauseToken } = cleanupDeps(seeded.jid);
    queue.stopGroup.mockRejectedValueOnce(new Error('runner remains active'));

    await expect(
      cleanupLegacyOnceTaskWorkspace(seeded.task, deps),
    ).rejects.toThrow('runner remains active');

    expect(queue.resumeGroupsAfterMutation).toHaveBeenCalledWith(pauseToken);
    expect(queue.discardGroupsAfterMutation).not.toHaveBeenCalled();
    expect(db.getRegisteredGroup(seeded.jid)).toBeDefined();
    expect(db.getTaskById(seeded.task.id)).toBeDefined();
  });
});
