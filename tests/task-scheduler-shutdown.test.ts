import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-scheduler-shutdown-'));
const store = path.join(root, 'db');
const groups = path.join(root, 'groups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(path.join(groups, 'workspace'), { recursive: true });

vi.mock(import('../src/config.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  DATA_DIR: root,
  STORE_DIR: store,
  GROUPS_DIR: groups,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { startSchedulerLoop, notifyTaskSchedulerChanged, stopSchedulerLoop } =
  await import('../src/task-scheduler.js');
const { getActiveScriptCount, runScript } =
  await import('../src/script-runner.js');

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-19T00:00:00.000Z'));
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('task scheduler shutdown boundary', () => {
  test('does not materialize or re-arm a past-due task during shutdown', async () => {
    const createdAt = new Date().toISOString();
    db.createTask({
      id: 'past-due-at-shutdown',
      group_folder: 'workspace',
      chat_jid: 'web:workspace',
      prompt: 'status',
      schedule_type: 'cron',
      schedule_value: '* * * * *',
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: 'container',
      script_command: null,
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: createdAt,
      notify_channels: null,
    });

    await startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { isShuttingDown: () => true },
      onProcess: vi.fn(),
      sendMessage: vi.fn(),
      assistantName: 'HappyClaw',
    } as never);

    expect(db.getTaskRunsForTask('past-due-at-shutdown', 10)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    notifyTaskSchedulerChanged();
    expect(vi.getTimerCount()).toBe(0);
    vi.runOnlyPendingTimers();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('actively terminates detached scripts instead of only timing out the drain', async () => {
    const pending = runScript('sleep 10', 'workspace');
    expect(getActiveScriptCount()).toBe(1);

    await stopSchedulerLoop({ drainMs: 1_000 });
    const result = await pending;

    expect(result).toMatchObject({
      aborted: true,
      timedOut: false,
      exitCode: null,
    });
    expect(getActiveScriptCount()).toBe(0);
  });
});
