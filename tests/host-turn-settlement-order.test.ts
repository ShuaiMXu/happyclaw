import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const source = fs.readFileSync(
  path.join(process.cwd(), 'src/index.ts'),
  'utf8',
);

describe('Host turn settlement ordering', () => {
  test('main warm IPC receipts commit only after output persistence callback resolves', () => {
    const start = source.indexOf('// Wrap onOutput to track session ID');
    const end = source.indexOf('interface SendMessageOutcome');
    const wrapper = source.slice(start, end);
    const callbackAt = wrapper.indexOf('await onOutput?.(output);');
    const receiptAt = wrapper.indexOf('queue.acknowledgeIpcDeliveries(');

    expect(callbackAt).toBeGreaterThanOrEqual(0);
    expect(receiptAt).toBeGreaterThan(callbackAt);
  });

  test('conversation-agent warm IPC receipts commit only after its handler resolves', () => {
    const start = source.indexOf(
      'const wrappedOnOutput = async (output: ContainerOutput): Promise<void>',
    );
    const end = source.indexOf(
      'ipcWatcherManager?.watchRuntime(effectiveGroup.folder, { agentId })',
      start,
    );
    const wrapper = source.slice(start, end);

    expect(
      wrapper.indexOf('await handleAgentOutput(output);'),
    ).toBeGreaterThanOrEqual(0);
    expect(wrapper.indexOf('queue.acknowledgeIpcDeliveries(')).toBeGreaterThan(
      wrapper.indexOf('await handleAgentOutput(output);'),
    );
  });

  test('main callback failures escape instead of leaving an early healthy marker', () => {
    const start = source.indexOf('output = await runAgent(');
    const end = source.indexOf('imagesForAgent,', start);
    const callback = source.slice(start, end);

    expect(callback).toContain("'onOutput callback failed'");
    expect(callback).toContain('throw err;');
    expect(callback).not.toContain('healthyCompletedInputTurns.add');
  });

  test('initializes IPC watching before scheduler and recovery can spawn runners', () => {
    const watcher = source.lastIndexOf('startIpcWatcher();');
    const scheduler = source.lastIndexOf('startSchedulerLoop(schedulerDeps);');
    const pendingRecovery = source.lastIndexOf('recoverPendingMessages();');
    const conversationRecovery = source.lastIndexOf(
      'recoverConversationAgents();',
    );

    expect(watcher).toBeGreaterThanOrEqual(0);
    expect(watcher).toBeLessThan(scheduler);
    expect(watcher).toBeLessThan(pendingRecovery);
    expect(watcher).toBeLessThan(conversationRecovery);
    expect(pendingRecovery).toBeLessThan(scheduler);
    expect(conversationRecovery).toBeLessThan(scheduler);
  });
});
