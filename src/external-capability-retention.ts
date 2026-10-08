import {
  deleteExternalCapabilityRunForRetention,
  getExternalCapabilityRunById,
  listExternalCapabilityRunsForRetention,
} from './db.js';
import { parseExternalCapabilityRunRetentionMs } from './external-capability-retention-config.js';
import { getExternalCapabilitySafeErrorMetadata } from './external-capability-safe-error.js';
import {
  deleteExternalCapabilityRunArtifacts,
  deleteExternalCapabilityRuntimeDirectory,
  getExternalCapabilityVaultRoot,
  listExternalCapabilityRunDirectories,
  listExternalCapabilityRuntimeDirectories,
} from './external-capability-storage.js';
import { logger } from './logger.js';
import type { ExternalCapabilityRun } from './types.js';

export interface ExternalCapabilityRetentionResult {
  deletedRuns: number;
  deletedOrphanRunDirectories: number;
  deletedRuntimeDirectories: number;
  errors: number;
}

export interface ExternalCapabilityRetentionOptions {
  now?: Date;
  retentionMs?: number;
  vaultRoot?: string;
}

function isTerminalRunEligible(
  run: ExternalCapabilityRun,
  completedBefore: string,
): boolean {
  return (
    (run.status === 'succeeded' ||
      run.status === 'failed' ||
      run.status === 'cancelled') &&
    run.completed_at !== null &&
    run.completed_at < completedBefore &&
    run.lease_owner === null &&
    run.lease_expires_at === null
  );
}

/**
 * Delete private external-call data filesystem-first, then remove the terminal
 * receipt with the same status and cutoff predicate. Unknown names and active
 * runs fail closed and remain untouched.
 */
export function runExternalCapabilityRetention(
  options: ExternalCapabilityRetentionOptions = {},
): ExternalCapabilityRetentionResult {
  const now = options.now ?? new Date();
  const retentionMs =
    options.retentionMs ??
    parseExternalCapabilityRunRetentionMs(
      process.env.EXTERNAL_CAPABILITY_RUN_RETENTION_HOURS,
    );
  const cutoffMs = now.getTime() - retentionMs;
  const completedBefore = new Date(cutoffMs).toISOString();
  const vaultRoot = options.vaultRoot ?? getExternalCapabilityVaultRoot();
  const result: ExternalCapabilityRetentionResult = {
    deletedRuns: 0,
    deletedOrphanRunDirectories: 0,
    deletedRuntimeDirectories: 0,
    errors: 0,
  };

  let runtimeDirectories = listExternalCapabilityRuntimeDirectories(vaultRoot);
  for (const run of listExternalCapabilityRunsForRetention(completedBefore)) {
    const matchingRuntime = runtimeDirectories.filter(
      (directory) => directory.runId === run.id,
    );
    if (matchingRuntime.some((directory) => directory.mtimeMs >= cutoffMs)) {
      continue;
    }
    try {
      deleteExternalCapabilityRunArtifacts(vaultRoot, run.id);
      for (const directory of matchingRuntime) {
        deleteExternalCapabilityRuntimeDirectory(vaultRoot, directory.name);
        result.deletedRuntimeDirectories += 1;
      }
      if (deleteExternalCapabilityRunForRetention(run.id, completedBefore)) {
        result.deletedRuns += 1;
      }
    } catch (error) {
      result.errors += 1;
      logger.warn(
        {
          ...getExternalCapabilitySafeErrorMetadata(error),
          runId: run.id,
        },
        'External capability retention could not remove a terminal run',
      );
    }
  }

  for (const directory of listExternalCapabilityRunDirectories(vaultRoot)) {
    if (directory.mtimeMs >= cutoffMs) continue;
    try {
      if (getExternalCapabilityRunById(directory.runId)) continue;
      deleteExternalCapabilityRunArtifacts(vaultRoot, directory.runId);
      result.deletedOrphanRunDirectories += 1;
    } catch (error) {
      result.errors += 1;
      logger.warn(
        {
          ...getExternalCapabilitySafeErrorMetadata(error),
          runId: directory.runId,
        },
        'External capability retention could not remove an orphan run directory',
      );
    }
  }

  runtimeDirectories = listExternalCapabilityRuntimeDirectories(vaultRoot);
  for (const directory of runtimeDirectories) {
    if (directory.mtimeMs >= cutoffMs) continue;
    try {
      const run = getExternalCapabilityRunById(directory.runId);
      if (run && !isTerminalRunEligible(run, completedBefore)) continue;
      deleteExternalCapabilityRuntimeDirectory(vaultRoot, directory.name);
      result.deletedRuntimeDirectories += 1;
    } catch (error) {
      result.errors += 1;
      logger.warn(
        {
          ...getExternalCapabilitySafeErrorMetadata(error),
          runId: directory.runId,
        },
        'External capability retention could not remove a stale runtime directory',
      );
    }
  }

  return result;
}
