import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';

import type { ContainerOutput } from './types.js';

export type RunnerProviderQuotaObservation = NonNullable<
  ContainerOutput['providerQuotaObservation']
>;

const MAX_SIGNAL_TEXT_LENGTH = 100;

function boundedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SIGNAL_TEXT_LENGTH)
    return undefined;
  return normalized;
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

/**
 * Convert the SDK's normalized event into HappyClaw's bounded control-plane
 * DTO. The SDK derives utilization from Anthropic's unified headers, whose
 * unit is a 0..1 fraction. Keeping that unit here prevents accidental mixing
 * with `/api/oauth/usage`, where utilization is already a 0..100 percentage.
 */
export function normalizeSdkRateLimitObservation(
  info: SDKRateLimitInfo,
  observedAt = Date.now(),
): RunnerProviderQuotaObservation {
  const utilization = fraction(info.utilization);
  const resetsAt = finitePositive(info.resetsAt);
  const overageResetsAt = finitePositive(info.overageResetsAt);
  const surpassedThreshold = fraction(info.surpassedThreshold);
  const rateLimitType = boundedText(info.rateLimitType);
  const overageDisabledReason = boundedText(info.overageDisabledReason);
  const errorCode = boundedText(info.errorCode);

  return {
    source: 'sdk_rate_limit_event',
    observedAt:
      Number.isFinite(observedAt) && observedAt > 0 ? observedAt : Date.now(),
    status: info.status,
    ...(rateLimitType ? { rateLimitType } : {}),
    ...(utilization !== undefined ? { utilization } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(info.overageStatus ? { overageStatus: info.overageStatus } : {}),
    ...(overageResetsAt !== undefined ? { overageResetsAt } : {}),
    ...(overageDisabledReason ? { overageDisabledReason } : {}),
    ...(typeof info.isUsingOverage === 'boolean'
      ? { isUsingOverage: info.isUsingOverage }
      : {}),
    ...(typeof info.overageInUse === 'boolean'
      ? { overageInUse: info.overageInUse }
      : {}),
    ...(surpassedThreshold !== undefined ? { surpassedThreshold } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(typeof info.canUserPurchaseCredits === 'boolean'
      ? { canUserPurchaseCredits: info.canUserPurchaseCredits }
      : {}),
    ...(typeof info.hasChargeableSavedPaymentMethod === 'boolean'
      ? {
          hasChargeableSavedPaymentMethod: info.hasChargeableSavedPaymentMethod,
        }
      : {}),
  };
}

/** A rejected subscription claim is still serviceable once overage is active. */
export function isTerminalSdkRateLimitRejection(
  info: SDKRateLimitInfo,
): boolean {
  return (
    info.status === 'rejected' &&
    info.isUsingOverage !== true &&
    info.overageInUse !== true
  );
}
