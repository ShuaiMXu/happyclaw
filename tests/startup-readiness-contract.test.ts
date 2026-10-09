import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const source = fs.readFileSync(
  path.join(process.cwd(), 'src', 'index.ts'),
  'utf8',
);

function position(marker: string): number {
  const index = source.indexOf(marker);
  expect(index, `missing startup marker: ${marker}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe('startup readiness ordering contract', () => {
  test('publishes readiness only after every durable recovery loop is started', () => {
    const webStart = position('startWebServer(webRuntimeDeps)');
    const ready = position('webRuntimeDeps.startupReady = true');

    expect(position('startupReady: false')).toBeLessThan(webStart);
    expect(webStart).toBeLessThan(ready);
    for (const marker of [
      'await reconcileChannelReliabilityOnStartup(imManager)',
      'recoverStartupTypedIpcDeliveries()',
      'await startExternalCapabilityWorker(',
      'recoverPendingMessages()',
      'recoverConversationAgents()',
      'startSchedulerLoop(schedulerDeps)',
      'streamingBuffer.start()',
      'startMessageLoop()',
    ]) {
      expect(position(marker), marker).toBeLessThan(ready);
    }
  });

  test('sweeps workspace cleanup debt after container reconciliation and before admission', () => {
    const dockerCleanup = position('await ensureDockerRunning()');
    const externalReconciliation = position(
      'await startExternalCapabilityWorker(',
    );
    const workspaceSweep = position(
      'sweepPendingWorkspaceFilesystemCleanups()',
    );
    const admission = position(
      'queue.setContainerAdmissionReady(dockerAdmissionReady)',
    );

    expect(dockerCleanup).toBeLessThan(workspaceSweep);
    expect(externalReconciliation).toBeLessThan(workspaceSweep);
    expect(workspaceSweep).toBeLessThan(admission);
  });

  test('withdraws readiness before shutdown begins draining work', () => {
    const shutdownReady = position('webRuntimeDeps.startupReady = false');
    const pauseInbound = position('imManager.pauseInbound()');
    const schedulerStop = position('stopSchedulerLoop().catch');

    expect(shutdownReady).toBeLessThan(pauseInbound);
    expect(shutdownReady).toBeLessThan(schedulerStop);
  });
});
