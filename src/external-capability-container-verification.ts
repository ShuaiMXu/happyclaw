import { execFile } from 'node:child_process';

import {
  clearExternalCapabilityRunContainerCleanupAfterVerifiedAbsence,
  getExternalCapabilityRunById,
} from './db.js';
import {
  getInstallationNamespace,
  ownedDockerLabelFilters,
} from './instance-ownership.js';

export const EXTERNAL_CONTAINER_MARKER_LABEL = 'com.happyclaw.external';
export const EXTERNAL_CONTAINER_LABEL = `${EXTERNAL_CONTAINER_MARKER_LABEL}=true`;
export const EXTERNAL_CONTAINER_PROTOCOL_LABEL =
  'com.happyclaw.external.protocol';
export const EXTERNAL_CONTAINER_RUN_ID_LABEL = 'com.happyclaw.external.run-id';
export const EXTERNAL_CONTAINER_ATTEMPT_LABEL =
  'com.happyclaw.external.attempt';
export const EXTERNAL_CONTAINER_LEASE_TOKEN_LABEL =
  'com.happyclaw.external.lease-token';

const EXTERNAL_RUN_ID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const LEGACY_EXTERNAL_CONTAINER_PATTERN = new RegExp(
  `^happyclaw-.+-external-(${EXTERNAL_RUN_ID_PATTERN})-\\d+$`,
  'i',
);

export type ExternalCapabilityContainerNameIdentity =
  | {
      generation: 'current';
      runId: string;
      attempt: number;
      leaseToken: number;
    }
  | { generation: 'legacy'; runId: string };

function parsePositiveSafeInteger(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseExternalCapabilityContainerName(
  containerName: string,
): ExternalCapabilityContainerNameIdentity | null {
  const current =
    /^happyclaw-[0-9a-f]{20}-external-(.+)-([1-9]\d*)-([1-9]\d*)$/.exec(
      containerName,
    );
  if (current) {
    const attempt = parsePositiveSafeInteger(current[2]);
    const leaseToken = parsePositiveSafeInteger(current[3]);
    if (current[1] && attempt !== null && leaseToken !== null) {
      return {
        generation: 'current',
        runId: current[1],
        attempt,
        leaseToken,
      };
    }
  }

  const legacy = LEGACY_EXTERNAL_CONTAINER_PATTERN.exec(containerName);
  return legacy?.[1] ? { generation: 'legacy', runId: legacy[1] } : null;
}

export function isExternalCapabilityContainerName(
  containerName: string,
): boolean {
  return (
    /^happyclaw-[0-9a-f]{20}-external-/.test(containerName) ||
    containerName.startsWith('happyclaw-external-') ||
    LEGACY_EXTERNAL_CONTAINER_PATTERN.test(containerName)
  );
}

function listExternalCapabilityRunContainers(
  runId: string,
): Promise<{ ok: boolean; present: boolean }> {
  const safeRunId = runId.replace(/[^a-zA-Z0-9-]/g, '-');
  const escapedRunId = safeRunId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expectedName = new RegExp(
    `^happyclaw-${getInstallationNamespace()}-external-${escapedRunId}-[1-9]\\d*-[1-9]\\d*$`,
  );
  return new Promise((resolve) => {
    execFile(
      'docker',
      [
        'container',
        'ls',
        '--all',
        '--format',
        '{{.Names}}',
        ...ownedDockerLabelFilters(),
      ],
      { timeout: 5_000 },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, present: false });
          return;
        }
        const names = stdout
          .split(/\r?\n/)
          .map((name) => name.trim())
          .filter(Boolean);
        if (names.some((name) => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))) {
          resolve({ ok: false, present: false });
          return;
        }
        resolve({
          ok: true,
          present: names.some((name) => {
            const identity = parseExternalCapabilityContainerName(name);
            return (
              expectedName.test(name) ||
              (identity?.generation === 'legacy' && identity.runId === runId)
            );
          }),
        });
      },
    );
  });
}

/**
 * Prove that no isolated container remains for a run, then clear only the exact
 * durable cleanup identity that the proof covers.
 */
export async function verifyExternalCapabilityRunContainerAbsent(
  runId: string,
): Promise<boolean> {
  const listed = await listExternalCapabilityRunContainers(runId);
  if (!listed.ok || listed.present) return false;

  const run = getExternalCapabilityRunById(runId);
  if (!run) return true;
  const attempt = run.container_cleanup_attempt;
  const leaseToken = run.container_cleanup_lease_token;
  if (run.container_create_pending_until !== null) {
    if (attempt === null || leaseToken === null) return false;
  } else if (attempt === null && leaseToken === null) {
    return true;
  }
  if (attempt === null || leaseToken === null) return false;
  if (
    clearExternalCapabilityRunContainerCleanupAfterVerifiedAbsence(
      runId,
      attempt,
      leaseToken,
    )
  ) {
    return true;
  }
  const latest = getExternalCapabilityRunById(runId);
  return Boolean(
    latest &&
    latest.container_cleanup_attempt === null &&
    latest.container_cleanup_lease_token === null &&
    latest.container_create_pending_until === null,
  );
}
