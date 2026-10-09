import path from 'node:path';

import {
  EXTERNAL_CONTAINER_MARKER_LABEL,
  isExternalCapabilityContainerName,
} from './external-capability-container-verification.js';
import { DATA_DIR } from './config.js';
import {
  canonicalizeInstallationDataDir,
  getInstallationId,
  HAPPYCLAW_INSTALLATION_LABEL,
  HAPPYCLAW_MANAGED_LABEL,
  ownedDockerLabelFilters,
} from './instance-ownership.js';
import {
  clearOrdinaryContainerCreateFence,
  listOrdinaryContainerCreateFences,
} from './ordinary-container-create-fence.js';

export function buildStartupContainerListArgs(): string[] {
  return [
    'container',
    'ls',
    '--all',
    ...ownedDockerLabelFilters(),
    '--format',
    `{{.Names}}\t{{.Label "${EXTERNAL_CONTAINER_MARKER_LABEL}"}}\t{{.Label "${HAPPYCLAW_INSTALLATION_LABEL}"}}`,
  ];
}

export function buildLegacyStartupContainerListArgs(): string[] {
  return [
    'container',
    'ls',
    '--all',
    '--filter',
    'name=^/happyclaw-',
    '--format',
    '{{.Names}}',
  ];
}

export function legacyContainerMountsBelongToInstallation(
  mountsJson: string,
  canonicalDataDir = canonicalizeInstallationDataDir(DATA_DIR),
): boolean {
  let mounts: unknown;
  try {
    mounts = JSON.parse(mountsJson);
  } catch {
    return false;
  }
  if (!Array.isArray(mounts)) return false;
  return mounts.some((mount) => {
    if (typeof mount !== 'object' || mount === null || Array.isArray(mount)) {
      return false;
    }
    const source = (mount as Record<string, unknown>).Source;
    if (typeof source !== 'string' || !path.isAbsolute(source)) return false;
    const relative = path.relative(canonicalDataDir, path.resolve(source));
    return (
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative))
    );
  });
}

export type StartupDockerCommand = (
  args: string[],
  timeoutMs: number,
) => Promise<{ ok: boolean; stdout: string }>;

export function legacyContainerInspectionBelongsToInstallation(
  inspectionJson: string,
  canonicalDataDir = canonicalizeInstallationDataDir(DATA_DIR),
): boolean {
  let inspections: unknown;
  try {
    inspections = JSON.parse(inspectionJson);
  } catch {
    return false;
  }
  if (!Array.isArray(inspections) || inspections.length !== 1) return false;
  const inspection = inspections[0];
  if (
    typeof inspection !== 'object' ||
    inspection === null ||
    Array.isArray(inspection)
  ) {
    return false;
  }
  const record = inspection as Record<string, unknown>;
  const config = record.Config;
  if (typeof config === 'object' && config !== null && !Array.isArray(config)) {
    const labels = (config as Record<string, unknown>).Labels;
    if (
      typeof labels === 'object' &&
      labels !== null &&
      !Array.isArray(labels)
    ) {
      const labelRecord = labels as Record<string, unknown>;
      if (
        HAPPYCLAW_INSTALLATION_LABEL in labelRecord ||
        HAPPYCLAW_MANAGED_LABEL in labelRecord
      ) {
        return false;
      }
    }
  }
  return legacyContainerMountsBelongToInstallation(
    JSON.stringify(record.Mounts ?? null),
    canonicalDataDir,
  );
}

export async function removeAndVerifyStartupContainer(
  containerName: string,
  runDockerCommand: StartupDockerCommand,
): Promise<void> {
  await runDockerCommand(['rm', '--force', containerName], 10_000);
  const listed = await runDockerCommand(
    [
      'container',
      'ls',
      '--all',
      '--quiet',
      '--filter',
      `name=^/${containerName}$`,
    ],
    5_000,
  );
  if (!listed.ok || listed.stdout.trim()) {
    throw new Error(`Could not verify removal of container ${containerName}`);
  }
}

export async function settleOrdinaryContainerCreateFencesAtStartup(
  runDockerCommand: StartupDockerCommand,
  now: () => number = Date.now,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<string[]> {
  const settled: string[] = [];
  for (const fence of listOrdinaryContainerCreateFences()) {
    const remaining = fence.expiresAt - now();
    if (remaining > 0) await wait(remaining + 25);
    await removeAndVerifyStartupContainer(
      fence.containerName,
      runDockerCommand,
    );
    clearOrdinaryContainerCreateFence(fence);
    settled.push(fence.containerName);
  }
  return settled;
}

/**
 * External containers have durable lease and cleanup reconciliation of their
 * own. Generic startup cleanup must leave them running so another live process
 * is not interrupted before the external worker can inspect and adopt them.
 */
export function selectStoppableStartupContainers(
  output: string,
  preserveExternal = true,
  installationId = getInstallationId(),
): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [name, externalMarker = '', owner = ''] = line.split('\t', 3);
      // Treat the formatted label as a second ownership fence in case a future
      // list-command change accidentally broadens the Docker filters.
      if (!name || owner.trim() !== installationId) return [];
      const external =
        isExternalCapabilityContainerName(name) ||
        externalMarker.trim() === 'true';
      return !external || !preserveExternal ? [name] : [];
    });
}
