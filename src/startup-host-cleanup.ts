import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  getInstallationId,
  hostRunnerOwnershipArgument,
} from './instance-ownership.js';

const execFileAsync = promisify(execFile);

export type HostCleanupDependencies = {
  execFile: typeof execFileAsync;
  kill: (target: number, signal: NodeJS.Signals) => void;
  currentPid: number;
};

const defaultDependencies: HostCleanupDependencies = {
  execFile: execFileAsync,
  kill: (target, signal) => {
    process.kill(target, signal);
  },
  currentPid: process.pid,
};

export function buildOwnedHostRunnerPattern(
  installationId = getInstallationId(),
): string {
  return `--happyclaw-installation=${installationId}([[:space:]]|$)`;
}

function parseSinglePositiveInteger(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export async function cleanupOwnedHostRunnerProcessGroups(
  dependencies: HostCleanupDependencies = defaultDependencies,
): Promise<number[]> {
  const marker = hostRunnerOwnershipArgument();
  let stdout: string;
  try {
    const result = await dependencies.execFile(
      'pgrep',
      ['-f', buildOwnedHostRunnerPattern()],
      { timeout: 5_000 },
    );
    stdout =
      typeof result.stdout === 'string' ? result.stdout : String(result.stdout);
  } catch (error) {
    if ((error as NodeJS.ErrnoException & { code?: number }).code === 1) {
      return [];
    }
    throw error;
  }

  const killed: number[] = [];
  const pids = stdout
    .split(/\r?\n/)
    .map(parseSinglePositiveInteger)
    .filter(
      (pid): pid is number => pid !== null && pid !== dependencies.currentPid,
    );
  for (const pid of pids) {
    try {
      const [pgidResult, argsResult] = await Promise.all([
        dependencies.execFile('ps', ['-o', 'pgid=', '-p', String(pid)], {
          timeout: 5_000,
        }),
        dependencies.execFile('ps', ['-o', 'args=', '-p', String(pid)], {
          timeout: 5_000,
        }),
      ]);
      const pgid = parseSinglePositiveInteger(String(pgidResult.stdout));
      const args = String(argsResult.stdout).trim();
      const markerIndex = args.indexOf(marker);
      const markerEnd = markerIndex + marker.length;
      const markerIsExactArgument =
        markerIndex >= 0 &&
        (markerIndex === 0 || /\s/.test(args[markerIndex - 1] ?? '')) &&
        (markerEnd === args.length || /\s/.test(args[markerEnd] ?? ''));
      if (pgid !== pid || !markerIsExactArgument) continue;
      dependencies.kill(-pgid, 'SIGKILL');
      killed.push(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue;
      throw error;
    }
  }
  return killed;
}
