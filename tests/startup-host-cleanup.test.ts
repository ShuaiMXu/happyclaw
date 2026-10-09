import { describe, expect, test, vi } from 'vitest';

import {
  buildOwnedHostRunnerPattern,
  cleanupOwnedHostRunnerProcessGroups,
} from '../src/startup-host-cleanup.js';
import { hostRunnerOwnershipArgument } from '../src/instance-ownership.js';

function result(stdout: string): { stdout: string; stderr: string } {
  return { stdout, stderr: '' };
}

describe('owned Host runner startup cleanup', () => {
  test('kills only a verified detached process group by negative PGID', async () => {
    const marker = hostRunnerOwnershipArgument();
    const execFile = vi.fn(async (file: string, args: string[]) => {
      if (file === 'pgrep') return result('4101\n');
      if (args[1] === 'pgid=') return result('4101\n');
      if (args[1] === 'args=') {
        return result(`node /app/agent-runner/dist/index.js ${marker}\n`);
      }
      throw new Error('unexpected command');
    });
    const killedGroups: number[] = [];

    await expect(
      cleanupOwnedHostRunnerProcessGroups({
        execFile,
        kill: (target) => killedGroups.push(target),
        currentPid: 9999,
      } as any),
    ).resolves.toEqual([4101]);
    expect(killedGroups).toEqual([-4101]);
    expect(execFile).toHaveBeenCalledWith(
      'pgrep',
      ['-f', buildOwnedHostRunnerPattern()],
      { timeout: 5_000 },
    );
  });

  test('skips a matching child that is not its process-group leader', async () => {
    const marker = hostRunnerOwnershipArgument();
    const execFile = vi.fn(async (file: string, args: string[]) => {
      if (file === 'pgrep') return result('4102\n');
      if (args[1] === 'pgid=') return result('4000\n');
      return result(`node runner.js ${marker}\n`);
    });
    const kill = vi.fn();

    await expect(
      cleanupOwnedHostRunnerProcessGroups({
        execFile,
        kill,
        currentPid: 9999,
      } as any),
    ).resolves.toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  test('rechecks the exact ownership argument before signalling', async () => {
    const execFile = vi.fn(async (file: string, args: string[]) => {
      if (file === 'pgrep') return result('4103\n');
      if (args[1] === 'pgid=') return result('4103\n');
      return result('node runner.js --happyclaw-installation=foreign\n');
    });
    const kill = vi.fn();

    await expect(
      cleanupOwnedHostRunnerProcessGroups({
        execFile,
        kill,
        currentPid: 9999,
      } as any),
    ).resolves.toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  test('treats pgrep exit code 1 as no owned runners', async () => {
    const error = Object.assign(new Error('no matches'), { code: 1 });
    const execFile = vi.fn(async () => {
      throw error;
    });

    await expect(
      cleanupOwnedHostRunnerProcessGroups({
        execFile,
        kill: vi.fn(),
        currentPid: 9999,
      } as any),
    ).resolves.toEqual([]);
  });
});
