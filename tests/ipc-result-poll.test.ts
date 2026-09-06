import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  fetchWorkspaceMemorySnapshot,
  pollIpcResult,
} from '../container/agent-runner/src/mcp-tools.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-ipc-result-'));
  tempDirs.push(dir);
  return dir;
}

describe('pollIpcResult', () => {
  test('performs a final read for a result that lands during the deadline sleep', async () => {
    vi.useFakeTimers();
    const requests = tempDir();
    const results = tempDir();
    const requestId = 'deadline-result';
    const pending = pollIpcResult(
      requests,
      { requestId, type: 'workspace_memory', action: 'snapshot' },
      'workspace_memory_result',
      100,
      results,
    );
    setTimeout(() => {
      fs.writeFileSync(
        path.join(results, `workspace_memory_result_${requestId}.json`),
        JSON.stringify({ success: true }),
      );
    }, 99);

    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual({ success: true });
  });

  test('logs correlated Memory timeout details while failing open', async () => {
    const workspaceIpc = tempDir();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await fetchWorkspaceMemorySnapshot(
      {
        chatJid: 'web:main',
        groupFolder: 'main',
        isHome: true,
        isAdminHome: true,
        agentBuilderEnabled: false,
        ownerProfileEnabled: false,
        workspaceIpc,
        workspaceGroup: tempDir(),
      },
      'query',
      { timeoutMs: 1 },
    );
    expect(result).toBeNull();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Workspace memory snapshot unavailable:'),
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining('requestId='));
  });
});
