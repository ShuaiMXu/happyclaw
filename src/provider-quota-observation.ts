import type { ProviderQuotaObservation } from './agent-runtime-contracts.js';
import type { ContainerOutput } from './agent-runtime-contracts.js';

export type ProviderQuotaSnapshot = ProviderQuotaObservation;

export const MAX_PROVIDER_QUOTA_OBSERVATIONS = 64;

const MAX_TEXT_LENGTH = 100;
const MAX_PROVIDER_QUOTA_EPOCHS = MAX_PROVIDER_QUOTA_OBSERVATIONS * 4;
const observations = new Map<string, ProviderQuotaSnapshot>();
const observationEpochs = new Map<string, number>();
let nextObservationEpoch = 1;

function enforceEpochCapacity(): void {
  while (observationEpochs.size > MAX_PROVIDER_QUOTA_EPOCHS) {
    const oldestProviderId = observationEpochs.keys().next().value as
      | string
      | undefined;
    if (oldestProviderId === undefined) break;
    observationEpochs.delete(oldestProviderId);
  }
}

function currentObservationEpoch(providerId: string): number {
  const normalizedProviderId = providerId.trim();
  const existing = observationEpochs.get(normalizedProviderId);
  if (existing !== undefined) return existing;
  const created = nextObservationEpoch++;
  observationEpochs.set(normalizedProviderId, created);
  enforceEpochCapacity();
  return created;
}

/** Capture the credential generation that a Runner was launched with. */
export function captureProviderQuotaObservationEpoch(
  providerId: string,
): number {
  return currentObservationEpoch(providerId);
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_TEXT_LENGTH
    ? normalized
    : undefined;
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function fraction(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : undefined;
}

function enforceCapacity(): void {
  while (observations.size > MAX_PROVIDER_QUOTA_OBSERVATIONS) {
    let oldestKey: string | undefined;
    let oldestObservedAt = Number.POSITIVE_INFINITY;
    for (const [providerId, snapshot] of observations) {
      if (snapshot.observedAt < oldestObservedAt) {
        oldestObservedAt = snapshot.observedAt;
        oldestKey = providerId;
      }
    }
    if (oldestKey === undefined) break;
    observations.delete(oldestKey);
  }
}

function normalizeObservation(
  value: ProviderQuotaObservation,
  now: number,
): ProviderQuotaObservation | null {
  if (
    value?.source !== 'sdk_rate_limit_event' ||
    !['allowed', 'allowed_warning', 'rejected'].includes(value.status)
  ) {
    return null;
  }

  const reportedAt = finitePositive(value.observedAt);
  // Docker and host share a clock, but fail closed on a wildly future stamp.
  const observedAt =
    reportedAt !== undefined && reportedAt <= now + 60_000 ? reportedAt : now;
  const rateLimitType = boundedText(value.rateLimitType);
  const utilization = fraction(value.utilization);
  const resetsAt = finitePositive(value.resetsAt);
  const overageResetsAt = finitePositive(value.overageResetsAt);
  const overageDisabledReason = boundedText(value.overageDisabledReason);
  const surpassedThreshold = fraction(value.surpassedThreshold);
  const errorCode = boundedText(value.errorCode);
  const overageStatus = ['allowed', 'allowed_warning', 'rejected'].includes(
    String(value.overageStatus),
  )
    ? value.overageStatus
    : undefined;

  return {
    source: 'sdk_rate_limit_event',
    observedAt,
    status: value.status,
    ...(rateLimitType ? { rateLimitType } : {}),
    ...(utilization !== undefined ? { utilization } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(overageStatus ? { overageStatus } : {}),
    ...(overageResetsAt !== undefined ? { overageResetsAt } : {}),
    ...(overageDisabledReason ? { overageDisabledReason } : {}),
    ...(typeof value.isUsingOverage === 'boolean'
      ? { isUsingOverage: value.isUsingOverage }
      : {}),
    ...(typeof value.overageInUse === 'boolean'
      ? { overageInUse: value.overageInUse }
      : {}),
    ...(surpassedThreshold !== undefined ? { surpassedThreshold } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(typeof value.canUserPurchaseCredits === 'boolean'
      ? { canUserPurchaseCredits: value.canUserPurchaseCredits }
      : {}),
    ...(typeof value.hasChargeableSavedPaymentMethod === 'boolean'
      ? {
          hasChargeableSavedPaymentMethod:
            value.hasChargeableSavedPaymentMethod,
        }
      : {}),
  };
}

/**
 * Replace the provider's passive observation with the newest complete event.
 * Fields from different responses are never unioned, matching CLIProxyAPI's
 * current-response snapshot semantics.
 */
export function observeProviderQuota(
  providerId: string,
  value: ProviderQuotaObservation,
  now = Date.now(),
): ProviderQuotaSnapshot | null {
  const normalizedProviderId = providerId.trim();
  if (!normalizedProviderId || normalizedProviderId.length > 128) return null;
  const normalized = normalizeObservation(value, now);
  if (!normalized) return null;
  const existing = observations.get(normalizedProviderId);
  if (existing && normalized.observedAt < existing.observedAt) return existing;

  const snapshot: ProviderQuotaSnapshot = { ...normalized };
  observations.set(normalizedProviderId, snapshot);
  enforceCapacity();
  return { ...snapshot };
}

export function getProviderQuotaObservation(
  providerId: string,
): ProviderQuotaSnapshot | null {
  const snapshot = observations.get(providerId.trim());
  return snapshot ? { ...snapshot } : null;
}

export function clearProviderQuotaObservation(providerId: string): boolean {
  const normalizedProviderId = providerId.trim();
  const removed = observations.delete(normalizedProviderId);
  // Rotate even when no snapshot exists: an already-running process may emit
  // its first event after the credential mutation completes.
  observationEpochs.delete(normalizedProviderId);
  observationEpochs.set(normalizedProviderId, nextObservationEpoch++);
  enforceEpochCapacity();
  return removed;
}

/** Test/runtime reset hook; observation state is deliberately not persisted. */
export function clearAllProviderQuotaObservations(): void {
  observations.clear();
  observationEpochs.clear();
  nextObservationEpoch = 1;
}

export function isProviderQuotaControlOutput(
  output: Pick<ContainerOutput, 'providerQuotaObservation'>,
): boolean {
  return output.providerQuotaObservation !== undefined;
}

/** Consume one Runner control frame before any user-facing projection. */
export function consumeProviderQuotaControlOutput(
  providerId: string | null,
  output: Pick<ContainerOutput, 'providerQuotaObservation'>,
  launchEpoch?: number | null,
): boolean {
  if (!output.providerQuotaObservation) return false;
  if (
    providerId &&
    (launchEpoch === undefined ||
      launchEpoch === currentObservationEpoch(providerId))
  ) {
    observeProviderQuota(providerId, output.providerQuotaObservation);
  }
  return true;
}
