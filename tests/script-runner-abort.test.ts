import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-runner-abort-'));
const groups = path.join(root, 'groups');
fs.mkdirSync(path.join(groups, 'workspace'), { recursive: true });

vi.mock('../src/config.js', () => ({ GROUPS_DIR: groups }));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({
    containerTimeout: 30_000,
  }),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('script run cancellation', () => {
  test('aborts only the selected process and never maps SIGKILL to exit 0', async () => {
    const { runScript } = await import('../src/script-runner.js');
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = runScript('sleep 10', 'workspace', {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort('cancelled'), 30);

    const result = await pending;
    expect(result).toMatchObject({
      aborted: true,
      timedOut: false,
      exitCode: null,
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test('terminates every detached script during graceful shutdown', async () => {
    const { getActiveScriptCount, runScript, terminateAllScripts } =
      await import('../src/script-runner.js');
    const first = runScript('sleep 10', 'workspace');
    const second = runScript('sleep 10', 'workspace');
    await vi.waitFor(() => expect(getActiveScriptCount()).toBe(2));

    const terminated = await terminateAllScripts();
    const results = await Promise.all([first, second]);

    expect(terminated).toBe(2);
    expect(results).toEqual([
      expect.objectContaining({ aborted: true, exitCode: null }),
      expect.objectContaining({ aborted: true, exitCode: null }),
    ]);
    expect(getActiveScriptCount()).toBe(0);
  });
});
