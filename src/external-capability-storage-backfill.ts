import crypto from 'node:crypto';

import {
  abortExternalCapabilityVaultCensus,
  backfillExternalCapabilityStorageOccupancy,
  beginExternalCapabilityVaultCensus,
  EXTERNAL_CAPABILITY_VAULT_CENSUS_STATE_KEY,
  EXTERNAL_CAPABILITY_VAULT_PHYSICAL_IDENTITY_KEY,
  getRouterState,
  type ExternalCapabilityStorageBackfillResult,
} from './db.js';
import {
  getExternalCapabilityVaultCensusIdentity,
  getExternalCapabilityVaultRoot,
  withExternalCapabilityVaultCensus,
} from './external-capability-storage.js';
import {
  acquireExternalCapabilityVaultExclusiveLock,
  type ExternalCapabilityVaultLock,
} from './external-capability-vault-lock.js';
import { logger } from './logger.js';

export const EXTERNAL_CAPABILITY_STORAGE_BACKFILL_MARKER =
  EXTERNAL_CAPABILITY_VAULT_CENSUS_STATE_KEY;

const EXTERNAL_CAPABILITY_STORAGE_CENSUS_BLOCKED_PREFIX = 'blocked:';

export interface ExternalCapabilityVaultCensusSession {
  blockedValue: string;
  release: () => void;
}

function getExpectedExternalCapabilityVaultId(env: NodeJS.ProcessEnv): string {
  const expectedVaultId = env.EXTERNAL_CAPABILITY_VAULT_ID?.trim();
  if (!expectedVaultId) {
    throw new Error(
      'EXTERNAL_CAPABILITY_VAULT_ID is required for external capability Vault census',
    );
  }
  return expectedVaultId;
}

/** Fence every current-version producer before Docker quiescence begins. */
export function beginConfiguredExternalCapabilityVaultCensus(
  env: NodeJS.ProcessEnv = process.env,
): ExternalCapabilityVaultCensusSession | null {
  if (!env.EXTERNAL_CAPABILITY_VAULT_DIR?.trim()) return null;

  let lock: ExternalCapabilityVaultLock | null =
    acquireExternalCapabilityVaultExclusiveLock(env);
  const blockedValue = `${EXTERNAL_CAPABILITY_STORAGE_CENSUS_BLOCKED_PREFIX}${crypto.randomUUID()}`;
  try {
    const physicalIdentity = getExternalCapabilityVaultCensusIdentity(
      getExternalCapabilityVaultRoot(env),
      getExpectedExternalCapabilityVaultId(env),
    );
    beginExternalCapabilityVaultCensus(blockedValue, physicalIdentity);
  } catch (error) {
    lock.release();
    lock = null;
    throw error;
  }

  return {
    blockedValue,
    release: () => {
      lock?.release();
      lock = null;
    },
  };
}

export function isExternalCapabilityVaultCensusReady(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (
    !env.EXTERNAL_CAPABILITY_VAULT_DIR?.trim() ||
    !env.EXTERNAL_CAPABILITY_VAULT_ID?.trim()
  ) {
    return false;
  }
  try {
    const currentIdentity = getExternalCapabilityVaultCensusIdentity(
      getExternalCapabilityVaultRoot(env),
      getExpectedExternalCapabilityVaultId(env),
    );
    return (
      getRouterState(EXTERNAL_CAPABILITY_STORAGE_BACKFILL_MARKER) ===
        currentIdentity &&
      getRouterState(EXTERNAL_CAPABILITY_VAULT_PHYSICAL_IDENTITY_KEY) ===
        currentIdentity
    );
  } catch {
    return false;
  }
}

/**
 * Account every pre-ledger Vault byte before external intake can be published.
 * Installations without a configured Vault remain unaffected until one is
 * configured and the service is restarted.
 */
export function backfillConfiguredExternalCapabilityVaultOccupancy(
  blockedValue: string,
  env: NodeJS.ProcessEnv = process.env,
): ExternalCapabilityStorageBackfillResult | null {
  if (!env.EXTERNAL_CAPABILITY_VAULT_DIR?.trim()) return null;

  const vaultRoot = getExternalCapabilityVaultRoot(env);
  const expectedVaultId = getExpectedExternalCapabilityVaultId(env);
  let vaultObjects = 0;
  let publishedValue: string | null = null;
  try {
    const result = withExternalCapabilityVaultCensus(
      vaultRoot,
      expectedVaultId,
      (census) => {
        vaultObjects = census.occupancies.length;
        publishedValue = census.identity;
        return backfillExternalCapabilityStorageOccupancy({
          markerKey: EXTERNAL_CAPABILITY_STORAGE_BACKFILL_MARKER,
          markerValue: census.identity,
          occupancies: census.occupancies,
          blockedValue,
        });
      },
    );
    logger.info(
      {
        vaultObjects,
        insertedRows: result.insertedRows,
        expandedRows: result.expandedRows,
        importedBytes: result.importedBytes,
        alreadyComplete: result.alreadyComplete,
      },
      'External capability Vault occupancy backfill completed',
    );
    return result;
  } catch (error) {
    try {
      abortExternalCapabilityVaultCensus(publishedValue, blockedValue);
    } catch (abortError) {
      throw new AggregateError(
        [error, abortError],
        'External capability Vault census failed and its durable fence could not be restored',
      );
    }
    throw error;
  }
}
