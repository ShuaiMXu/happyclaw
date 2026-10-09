import {
  getExternalCapabilityRunById,
  listExternalCapabilityRunsForRetention,
  listExternalCapabilityStorageReservationsForReconciliation,
  purgeReleasedExternalCapabilityStorageReservations,
  releaseExternalCapabilityStorageForRunArtifacts,
  releaseOrphanedExternalCapabilityIntakeStorage,
  sanitizeExternalCapabilityRunForRetention,
} from './db.js';
import {
  EXTERNAL_CAPABILITY_STORAGE_RELEASE_GC_GRACE_MS,
  parseExternalCapabilityRunRetentionMs,
} from './external-capability-retention-config.js';
import { getExternalCapabilitySafeErrorMetadata } from './external-capability-safe-error.js';
import {
  externalCapabilityStorageReservationKey,
  releaseExternalCapabilityStorageCapacity,
} from './external-capability-storage-capacity.js';
import {
  deleteExternalCapabilityRunArtifactsAsync,
  deleteExternalCapabilityRuntimeDirectoryAsync,
  externalCapabilityArtifactExists,
  externalCapabilityRunArtifactsExist,
  externalCapabilityRuntimeDirectoryExists,
  getExternalCapabilityVaultRoot,
  iterateExternalCapabilityRunDirectories,
  iterateExternalCapabilityRuntimeDirectories,
} from './external-capability-storage.js';
import { logger } from './logger.js';
import type { ExternalCapabilityRun } from './types.js';

const RETENTION_RUN_BATCH_SIZE = 50;
const RETENTION_YIELD_INTERVAL = 50;

export interface ExternalCapabilityRetentionResult {
  sanitizedRuns: number;
  deletedOrphanRunDirectories: number;
  deletedRuntimeDirectories: number;
  deletedReleasedStorageReservations: number;
  errors: number;
}

export interface ExternalCapabilityRetentionOptions {
  now?: Date;
  retentionMs?: number;
  vaultRoot?: string;
  runBatchSize?: number;
  verifyRunContainerAbsent?: (runId: string) => Promise<boolean>;
  releaseRunStorage?: (runId: string) => void;
  releaseRuntimeStorage?: (runId: string, directoryName: string) => void;
}

function hasRuntimeCleanupEligibleStatus(run: ExternalCapabilityRun): boolean {
  if (run.status === 'queued' || run.status === 'retry_wait') {
    // Each claim creates a new server-named runtime directory. Therefore any
    // directory left while the run is unclaimed belongs to a completed
    // pre-START attempt and can be retried independently of the durable input.
    return true;
  }

  return (
    (run.status === 'succeeded' ||
      run.status === 'failed' ||
      run.status === 'cancelled') &&
    run.completed_at !== null
  );
}

function isRunEligibleForRuntimeCleanupVerification(
  run: ExternalCapabilityRun,
  now: string,
): boolean {
  if (
    run.lease_owner !== null ||
    run.lease_expires_at !== null ||
    !hasRuntimeCleanupEligibleStatus(run)
  ) {
    return false;
  }

  const cleanupIdentityComplete =
    (run.container_cleanup_attempt === null) ===
    (run.container_cleanup_lease_token === null);
  if (!cleanupIdentityComplete) return false;

  return (
    run.container_create_pending_until === null ||
    run.container_create_pending_until <= now
  );
}

function isRunSafeForRuntimeCleanup(run: ExternalCapabilityRun): boolean {
  return (
    run.lease_owner === null &&
    run.lease_expires_at === null &&
    run.container_cleanup_attempt === null &&
    run.container_cleanup_lease_token === null &&
    run.container_create_pending_until === null &&
    hasRuntimeCleanupEligibleStatus(run)
  );
}

function isRunSafeForArtifactStorageReconciliation(
  run: ExternalCapabilityRun,
): boolean {
  return (
    run.lease_owner === null &&
    run.lease_expires_at === null &&
    run.completed_at !== null &&
    (run.status === 'succeeded' ||
      run.status === 'failed' ||
      run.status === 'cancelled')
  );
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Delete private external-call data filesystem-first, then scrub the terminal
 * row to a non-sensitive idempotency and quota receipt. Database candidates are
 * paged and filesystem work is asynchronous so lease heartbeats remain timely.
 */
export async function runExternalCapabilityRetention(
  options: ExternalCapabilityRetentionOptions = {},
): Promise<ExternalCapabilityRetentionResult> {
  const now = options.now ?? new Date();
  const retentionMs =
    options.retentionMs ??
    parseExternalCapabilityRunRetentionMs(
      process.env.EXTERNAL_CAPABILITY_RUN_RETENTION_HOURS,
    );
  const nowIso = now.toISOString();
  const cutoffMs = now.getTime() - retentionMs;
  const completedBefore = new Date(cutoffMs).toISOString();
  const vaultRoot = options.vaultRoot ?? getExternalCapabilityVaultRoot();
  const requestedBatchSize = options.runBatchSize ?? RETENTION_RUN_BATCH_SIZE;
  const runBatchSize = Number.isSafeInteger(requestedBatchSize)
    ? Math.max(1, Math.min(500, requestedBatchSize))
    : RETENTION_RUN_BATCH_SIZE;
  const result: ExternalCapabilityRetentionResult = {
    sanitizedRuns: 0,
    deletedOrphanRunDirectories: 0,
    deletedRuntimeDirectories: 0,
    deletedReleasedStorageReservations: 0,
    errors: 0,
  };

  const verifyRunContainerAbsent =
    options.verifyRunContainerAbsent ?? (async () => false);
  const releaseRunStorage =
    options.releaseRunStorage ??
    releaseExternalCapabilityStorageForRunArtifacts;
  const releaseRuntimeStorage =
    options.releaseRuntimeStorage ??
    ((runId: string, directoryName: string) => {
      releaseExternalCapabilityStorageCapacity(
        externalCapabilityStorageReservationKey({
          runId,
          kind: 'runtime',
          objectKey: directoryName,
        }),
      );
    });
  const absenceChecks = new Map<string, Promise<boolean>>();
  const confirmRunContainerAbsent = (runId: string): Promise<boolean> => {
    const existing = absenceChecks.get(runId);
    if (existing) return existing;
    const check = verifyRunContainerAbsent(runId);
    absenceChecks.set(runId, check);
    return check;
  };
  const runtimeCleanupBlocked = new Set<string>();
  const storageReconciliationBlocked = new Set<string>();

  // Runtime data is removed before a row can be tombstoned. Container absence
  // is a mandatory proof: neither age nor a prior database marker can stand in
  // for Docker lifecycle verification.
  let visitedDirectories = 0;
  for await (const directory of iterateExternalCapabilityRuntimeDirectories(
    vaultRoot,
  )) {
    try {
      const run = getExternalCapabilityRunById(directory.runId);
      const runEligible =
        run !== undefined &&
        isRunEligibleForRuntimeCleanupVerification(run, nowIso);
      const orphanEligible = !run && directory.mtimeMs <= cutoffMs;
      if (runEligible || orphanEligible) {
        if (!(await confirmRunContainerAbsent(directory.runId))) {
          runtimeCleanupBlocked.add(directory.runId);
          throw new Error(
            'External capability container absence could not be verified',
          );
        }
        const verifiedRun = getExternalCapabilityRunById(directory.runId);
        if (verifiedRun && !isRunSafeForRuntimeCleanup(verifiedRun)) {
          runtimeCleanupBlocked.add(directory.runId);
          throw new Error(
            'External capability cleanup fence remained after absence verification',
          );
        }
        await deleteExternalCapabilityRuntimeDirectoryAsync(
          vaultRoot,
          directory.name,
        );
        releaseRuntimeStorage(directory.runId, directory.name);
        result.deletedRuntimeDirectories += 1;
      }
    } catch (error) {
      runtimeCleanupBlocked.add(directory.runId);
      result.errors += 1;
      logger.warn(
        {
          ...getExternalCapabilitySafeErrorMetadata(error),
          runId: directory.runId,
        },
        'External capability retention could not remove a stale runtime directory',
      );
    }
    visitedDirectories += 1;
    if (visitedDirectories % RETENTION_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }

  let after: { completedAt: string; id: string } | undefined;
  while (true) {
    const runs = listExternalCapabilityRunsForRetention(
      completedBefore,
      runBatchSize,
      after,
      nowIso,
    );
    if (runs.length === 0) break;
    for (const run of runs) {
      if (runtimeCleanupBlocked.has(run.id)) continue;
      try {
        if (!(await confirmRunContainerAbsent(run.id))) {
          throw new Error(
            'External capability container absence could not be verified',
          );
        }
        await deleteExternalCapabilityRunArtifactsAsync(vaultRoot, run.id);
        releaseRunStorage(run.id);
        if (
          sanitizeExternalCapabilityRunForRetention(run.id, completedBefore)
        ) {
          result.sanitizedRuns += 1;
        }
      } catch (error) {
        storageReconciliationBlocked.add(run.id);
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
    const lastRun = runs.at(-1)!;
    after = { completedAt: lastRun.completed_at!, id: lastRun.id };
    await yieldToEventLoop();
  }

  visitedDirectories = 0;
  for await (const directory of iterateExternalCapabilityRunDirectories(
    vaultRoot,
  )) {
    if (directory.mtimeMs <= cutoffMs) {
      try {
        if (!getExternalCapabilityRunById(directory.runId)) {
          await deleteExternalCapabilityRunArtifactsAsync(
            vaultRoot,
            directory.runId,
          );
          releaseRunStorage(directory.runId);
          result.deletedOrphanRunDirectories += 1;
        }
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
    visitedDirectories += 1;
    if (visitedDirectories % RETENTION_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }

  // A crash can leave a reservation without a discoverable directory (for
  // example, after SQLite admission but before the first file create). Reconcile
  // only aged rows and release them solely when their exact physical object is
  // absent. This also retries the delete-succeeded/ledger-update-failed case.
  let storageAfter: { createdAt: string; reservationKey: string } | undefined;
  while (true) {
    const reservations =
      listExternalCapabilityStorageReservationsForReconciliation(
        completedBefore,
        runBatchSize,
        storageAfter,
      );
    if (reservations.length === 0) break;
    for (const reservation of reservations) {
      if (storageReconciliationBlocked.has(reservation.run_id)) continue;
      try {
        const run = getExternalCapabilityRunById(reservation.run_id);
        if (!run) {
          if (reservation.kind !== 'input') continue;
          if (
            externalCapabilityRunArtifactsExist(vaultRoot, reservation.run_id)
          ) {
            continue;
          }
          // Preflight binds the server-generated run ID to the durable intake
          // before storage admission. Once that intake is finished or expired,
          // it cannot renew or publish a run; the database transaction rechecks
          // those fences after this exact physical-absence observation.
          releaseOrphanedExternalCapabilityIntakeStorage(
            reservation.reservation_key,
            reservation.run_id,
            nowIso,
          );
          continue;
        }

        if (reservation.kind === 'runtime') {
          if (!isRunEligibleForRuntimeCleanupVerification(run, nowIso)) {
            continue;
          }
          if (!(await confirmRunContainerAbsent(reservation.run_id))) {
            continue;
          }
        } else if (!isRunSafeForArtifactStorageReconciliation(run)) {
          continue;
        }

        const physicallyPresent =
          reservation.kind === 'runtime'
            ? externalCapabilityRuntimeDirectoryExists(
                vaultRoot,
                reservation.object_key,
              )
            : reservation.kind === 'output'
              ? externalCapabilityArtifactExists(
                  vaultRoot,
                  reservation.run_id,
                  reservation.object_key,
                )
              : externalCapabilityRunArtifactsExist(
                  vaultRoot,
                  reservation.run_id,
                );
        if (physicallyPresent) continue;

        // Re-read every mutable lifecycle fence after the filesystem check.
        // Producers cannot legally materialize storage once these conditions
        // hold, so releasing the exact missing object cannot race settlement.
        const verifiedRun = getExternalCapabilityRunById(reservation.run_id);
        const lifecycleStillSafe =
          verifiedRun !== undefined &&
          (reservation.kind === 'runtime'
            ? isRunSafeForRuntimeCleanup(verifiedRun)
            : isRunSafeForArtifactStorageReconciliation(verifiedRun));
        if (lifecycleStillSafe) {
          releaseExternalCapabilityStorageCapacity(reservation.reservation_key);
        }
      } catch (error) {
        result.errors += 1;
        logger.warn(
          {
            ...getExternalCapabilitySafeErrorMetadata(error),
            runId: reservation.run_id,
          },
          'External capability retention could not reconcile Vault accounting',
        );
      }
    }
    const lastReservation = reservations.at(-1)!;
    storageAfter = {
      createdAt: lastReservation.created_at,
      reservationKey: lastReservation.reservation_key,
    };
    await yieldToEventLoop();
  }

  try {
    const releasedBefore = new Date(
      now.getTime() - EXTERNAL_CAPABILITY_STORAGE_RELEASE_GC_GRACE_MS,
    ).toISOString();
    result.deletedReleasedStorageReservations =
      purgeReleasedExternalCapabilityStorageReservations(releasedBefore);
  } catch (error) {
    result.errors += 1;
    logger.warn(
      getExternalCapabilitySafeErrorMetadata(error),
      'External capability retention could not purge released Vault reservations',
    );
  }

  return result;
}
