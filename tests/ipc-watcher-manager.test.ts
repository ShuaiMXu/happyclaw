import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  DEFAULT_IPC_WATCHER_FALLBACK_MS,
  IpcWatcherManager,
} from '../src/ipc-watcher-manager.js';

const temporaryRoots: string[] = [];

function temporaryIpcRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-ipc-watch-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('IpcWatcherManager runtime namespaces', () => {
  test('keeps the default recovery scan below the Runner IPC deadline', () => {
    expect(DEFAULT_IPC_WATCHER_FALLBACK_MS).toBe(2000);
  });

  test.each([
    {
      name: 'conversation agent tasks',
      namespace: { agentId: 'agent-1' },
      relativeDir: path.join('agents', 'agent-1', 'tasks'),
    },
    {
      name: 'isolated task messages',
      namespace: { taskRunId: 'run-1' },
      relativeDir: path.join('tasks-run', 'run-1', 'messages'),
    },
  ])('processes $name without waiting for the full scan', async (fixture) => {
    const ipcBaseDir = temporaryIpcRoot();
    const processGroup = vi.fn(async () => {});
    const processFull = vi.fn(async () => {});
    const manager = new IpcWatcherManager({
      ipcBaseDir,
      isShuttingDown: () => false,
      debounceMs: 5,
      // Do not start fallback: this test proves leaf fs.watch delivery.
      fallbackMs: 60_000,
    });
    manager.bind(processGroup, processFull);
    manager.watchRuntime('workspace', fixture.namespace);
    // Ignore the intentional registration-race drain. The next call must come
    // from the nested leaf watcher because fallback is not running.
    await vi.waitFor(() => expect(processGroup).toHaveBeenCalled());
    processGroup.mockClear();

    const requestDir = path.join(ipcBaseDir, 'workspace', fixture.relativeDir);
    fs.writeFileSync(path.join(requestDir, 'request.json'), '{}');

    await vi.waitFor(() => {
      expect(processGroup).toHaveBeenCalledWith('workspace');
    });
    expect(processFull).not.toHaveBeenCalled();
    manager.closeAll();
  });

  test('reference counts one namespace and closes it only after the final release', async () => {
    const ipcBaseDir = temporaryIpcRoot();
    const processGroup = vi.fn(async () => {});
    const manager = new IpcWatcherManager({
      ipcBaseDir,
      isShuttingDown: () => false,
      debounceMs: 5,
    });
    manager.bind(processGroup, async () => {});
    const namespace = { agentId: 'agent-refcount' };
    manager.watchRuntime('workspace', namespace);
    manager.watchRuntime('workspace', namespace);
    expect(manager.activeRuntimeCount).toBe(1);
    await vi.waitFor(() => expect(processGroup).toHaveBeenCalled());
    processGroup.mockClear();

    manager.unwatchRuntime('workspace', namespace);
    const requestDir = path.join(
      ipcBaseDir,
      'workspace',
      'agents',
      'agent-refcount',
      'tasks',
    );
    fs.writeFileSync(path.join(requestDir, 'first.json'), '{}');
    await vi.waitFor(() => expect(processGroup).toHaveBeenCalledTimes(1));

    manager.unwatchRuntime('workspace', namespace);
    expect(manager.activeRuntimeCount).toBe(0);
    fs.writeFileSync(path.join(requestDir, 'after-release.json'), '{}');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(processGroup).toHaveBeenCalledTimes(1);
    manager.closeAll();
  });

  test('immediately drains a request that won the watcher-registration race', async () => {
    const ipcBaseDir = temporaryIpcRoot();
    const requestDir = path.join(
      ipcBaseDir,
      'workspace',
      'agents',
      'agent-race',
      'tasks',
    );
    fs.mkdirSync(requestDir, { recursive: true });
    fs.writeFileSync(path.join(requestDir, 'already-present.json'), '{}');
    const processGroup = vi.fn(async () => {});
    const manager = new IpcWatcherManager({
      ipcBaseDir,
      isShuttingDown: () => false,
      debounceMs: 5,
    });
    manager.bind(processGroup, async () => {});

    manager.watchRuntime('workspace', { agentId: 'agent-race' });

    await vi.waitFor(() =>
      expect(processGroup).toHaveBeenCalledWith('workspace'),
    );
    manager.closeAll();
  });

  test('falls back within the Runner context deadline when fs.watch is unavailable', async () => {
    const ipcBaseDir = temporaryIpcRoot();
    const watch = vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw new Error('watch unavailable');
    });
    const processGroup = vi.fn(async () => {});
    const processFull = vi.fn(async () => {});
    const manager = new IpcWatcherManager({
      ipcBaseDir,
      isShuttingDown: () => false,
      debounceMs: 5,
      fallbackMs: 20,
    });
    manager.bind(processGroup, processFull);
    manager.watchRuntime('workspace', { agentId: 'agent-fallback' });
    await vi.waitFor(() => expect(processGroup).toHaveBeenCalled());
    processGroup.mockClear();

    const requestDir = path.join(
      ipcBaseDir,
      'workspace',
      'agents',
      'agent-fallback',
      'tasks',
    );
    fs.writeFileSync(path.join(requestDir, 'request.json'), '{}');
    manager.startFallback();

    await vi.waitFor(() => expect(processFull).toHaveBeenCalled());
    expect(processGroup).not.toHaveBeenCalled();
    manager.closeAll();
    watch.mockRestore();
  });
});
