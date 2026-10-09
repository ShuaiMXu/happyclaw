import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  quarantineExternalCapabilityStorage,
  recordExternalCapabilityStorageMaterializedBytes,
  releaseExternalCapabilityStorage,
  reserveExternalCapabilityStorage,
  settleExternalCapabilityStorage,
  type ExternalCapabilityStorageKind,
} from './db.js';
import {
  externalCapabilityRunArtifactsExist,
  probeExternalCapabilityVault,
} from './external-capability-storage.js';
import { externalCapabilityStorageReservationKey } from './external-capability-storage-identity.js';

export { externalCapabilityStorageReservationKey } from './external-capability-storage-identity.js';

const DEFAULT_VAULT_LOGICAL_LIMIT_BYTES = 100 * 1024 * 1024 * 1024;
const DEFAULT_VAULT_FILESYSTEM_SAFETY_BYTES = 1024 * 1024 * 1024;
const MAX_CONFIGURED_VAULT_BYTES = 1024 * 1024 * 1024 * 1024 * 1024;

export interface ExternalCapabilityStorageCapacityConfig {
  logicalLimitBytes: number;
  filesystemSafetyReserveBytes: number;
}

export class ExternalCapabilityStorageCapacityError extends Error {
  readonly code = 'VAULT_CAPACITY_EXCEEDED';

  constructor() {
    super('External capability Vault capacity is unavailable');
    this.name = 'ExternalCapabilityStorageCapacityError';
  }
}

function boundedByteCount(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) &&
    parsed >= 0 &&
    parsed <= MAX_CONFIGURED_VAULT_BYTES
    ? parsed
    : fallback;
}

export function getExternalCapabilityStorageCapacityConfig(
  env: NodeJS.ProcessEnv = process.env,
): ExternalCapabilityStorageCapacityConfig {
  return {
    logicalLimitBytes: boundedByteCount(
      env,
      'EXTERNAL_CAPABILITY_VAULT_MAX_BYTES',
      DEFAULT_VAULT_LOGICAL_LIMIT_BYTES,
    ),
    filesystemSafetyReserveBytes: boundedByteCount(
      env,
      'EXTERNAL_CAPABILITY_VAULT_MIN_FREE_BYTES',
      DEFAULT_VAULT_FILESYSTEM_SAFETY_BYTES,
    ),
  };
}

function existingFilesystemPath(target: string): string {
  let current = path.resolve(target);
  for (;;) {
    try {
      fs.lstatSync(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export function getExternalCapabilityVaultAvailableBytes(
  vaultRoot: string,
): number {
  const stats = fs.statfsSync(existingFilesystemPath(vaultRoot), {
    bigint: true,
  });
  const available = stats.bavail * stats.bsize;
  return available > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(available);
}

export function reserveExternalCapabilityStorageCapacity(input: {
  runId: string;
  kind: ExternalCapabilityStorageKind;
  objectKey: string;
  byteCount: number;
  vaultRoot: string;
  availableBytes?: number;
  config?: ExternalCapabilityStorageCapacityConfig;
}): string {
  const reservationKey = externalCapabilityStorageReservationKey(input);
  const config = input.config ?? getExternalCapabilityStorageCapacityConfig();
  const result = reserveExternalCapabilityStorage({
    reservationKey,
    runId: input.runId,
    kind: input.kind,
    objectKey: input.objectKey,
    reservedBytes: input.byteCount,
    filesystemAvailableBytes:
      input.availableBytes ??
      (() => getExternalCapabilityVaultAvailableBytes(input.vaultRoot)),
    filesystemSafetyReserveBytes: config.filesystemSafetyReserveBytes,
    logicalLimitBytes: config.logicalLimitBytes,
  });
  if (!result.admitted) throw new ExternalCapabilityStorageCapacityError();
  return reservationKey;
}

export function recordExternalCapabilityStorageMaterializedCapacity(
  reservationKey: string,
  materializedBytes: number,
): void {
  if (
    !recordExternalCapabilityStorageMaterializedBytes(
      reservationKey,
      materializedBytes,
    )
  ) {
    throw new Error(
      'External capability Vault materialization checkpoint failed',
    );
  }
}

export function settleExternalCapabilityStorageCapacity(
  reservationKey: string,
  occupiedBytes: number,
): void {
  if (!settleExternalCapabilityStorage(reservationKey, occupiedBytes)) {
    throw new Error('External capability Vault reservation settlement failed');
  }
}

export function quarantineExternalCapabilityStorageCapacity(
  reservationKey: string,
): void {
  if (!quarantineExternalCapabilityStorage(reservationKey)) {
    throw new Error('External capability Vault reservation quarantine failed');
  }
}

export function releaseExternalCapabilityStorageCapacity(
  reservationKey: string,
): void {
  if (!releaseExternalCapabilityStorage(reservationKey)) {
    throw new Error('External capability Vault reservation release failed');
  }
}

/** Exercise the Vault write path under the same durable capacity fence as runs. */
export function probeExternalCapabilityVaultWithCapacity(
  vaultRoot: string,
): void {
  const runId = crypto.randomUUID();
  const artifactId = `readiness-${crypto.randomUUID()}`;
  const reservationKey = reserveExternalCapabilityStorageCapacity({
    runId,
    kind: 'input',
    objectKey: 'run-artifacts',
    byteCount: 32,
    vaultRoot,
  });

  let probeError: unknown;
  try {
    probeExternalCapabilityVault(vaultRoot, { runId, artifactId });
  } catch (error) {
    probeError = error;
  }

  let physicallyPresent = true;
  try {
    physicallyPresent = externalCapabilityRunArtifactsExist(vaultRoot, runId);
  } catch {
    // Unknown filesystem state remains charged fail-closed.
  }

  if (physicallyPresent) {
    quarantineExternalCapabilityStorageCapacity(reservationKey);
  } else {
    releaseExternalCapabilityStorageCapacity(reservationKey);
  }

  if (probeError) throw probeError;
}
