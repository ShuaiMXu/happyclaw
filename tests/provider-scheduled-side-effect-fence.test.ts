import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-side-effect-'));
vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/runtime-config.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/runtime-config.js')
  >('../src/runtime-config.js');
  return {
    ...actual,
    getEnabledProviders: () => [
      {
        id: 'provider-a',
        enabled: true,
        weight: 1,
        anthropicModel: 'primary-model',
      },
    ],
    getSystemSettings: () => ({
      ...actual.getSystemSettings(),
      fallbackModel: '',
    }),
  };
});

const db = await import('../src/db.js');
const { runAgentWithModelFallback } =
  await import('../src/container-runner.js');
type AgentRunner = import('../src/container-runner.js').AgentRunner;
type ContainerOutput = import('../src/container-runner.js').ContainerOutput;

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'groups'), { recursive: true });
  db.initDatabase();
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function createRun(label: string) {
  const taskId = `task-${label}`;
  db.createTask({
    id: taskId,
    group_folder: 'scheduled-side-effect',
    chat_jid: 'web:scheduled-side-effect',
    prompt: 'perform side effect',
    schedule_type: 'cron',
    schedule_value: '0 * * * *',
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: 'container',
    script_command: null,
    next_run: new Date(Date.now() + 60_000).toISOString(),
    status: 'active',
    created_at: new Date().toISOString(),
    notify_channels: ['qq'],
  });
  return db.createTaskRun({
    task: db.getTaskById(taskId)!,
    triggerType: 'manual',
  }).run;
}

describe('scheduled provider replay side-effect fence', () => {
  test.each([
    ['message-success', 1, 0],
    ['image-uncertain', 0, 1],
  ])(
    '%s receipt prevents replay of the whole isolated prompt',
    async (label, succeeded, uncertain) => {
      const run = createRun(label);
      db.recordTaskRunNotificationReceipt(run.id, {
        status: uncertain ? 'uncertain' : 'success',
        summary: {
          attempted: 1,
          succeeded,
          failed: uncertain ? 1 : 0,
          failed_channels: uncertain ? ['qq'] : [],
          ...(uncertain ? { uncertain: 1, uncertain_channels: ['qq'] } : {}),
        },
        error: uncertain ? 'provider acceptance unknown' : null,
      });
      const onProcess = vi.fn();
      const runFn = vi.fn(
        async (
          _group: unknown,
          _input: unknown,
          reportProcess: (
            proc: never,
            identifier: string,
            providerId: string | null,
          ) => void,
        ): Promise<ContainerOutput> => {
          reportProcess({} as never, 'attempt-1', 'provider-a');
          return {
            status: 'success',
            result: null,
            providerFailure: true,
            providerFailureClass: 'transient',
            providerFailureTerminal: false,
          };
        },
      );
      const output = await runAgentWithModelFallback(
        runFn as unknown as AgentRunner,
        {
          jid: 'web:scheduled-side-effect',
          name: 'scheduled-side-effect',
          folder: 'scheduled-side-effect',
        } as never,
        {
          prompt: 'must execute once',
          groupFolder: 'scheduled-side-effect',
          chatJid: 'web:scheduled-side-effect',
          isMain: false,
          isScheduledTask: true,
          taskRunId: run.id,
        },
        onProcess,
      );

      expect(runFn).toHaveBeenCalledOnce();
      expect(onProcess).toHaveBeenCalledOnce();
      expect(output).toMatchObject({
        status: 'success',
        providerFailure: false,
        inputTurnCompleted: true,
      });
    },
  );
});
