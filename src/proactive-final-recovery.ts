import type { ActiveTurnOutputRegistry } from './turn-output-coordinator.js';
import type { MessageFinalizationReason } from './types.js';

export interface UnacknowledgedProactiveFinalProjectionResult {
  projected: boolean;
  /** The canonical Web answer fully satisfies the user-visible final even
   * though the native provider definitively rejected its channel copy. */
  webCompleted: boolean;
  finalizationReason: Extract<
    MessageFinalizationReason,
    'completed' | 'delivery_uncertain' | 'error'
  >;
}

export type NativeFinalDeliveryFailure =
  | 'rejected'
  | 'uncertain'
  | 'unavailable';

/**
 * Preserve the exact explicit final in the canonical Web session when native
 * delivery was not acknowledged.
 *
 * This never retries the provider mutation and deliberately records only a
 * projection, so native delivery accounting and retry fences remain intact.
 */
export async function preserveUnacknowledgedProactiveFinal(input: {
  registry: ActiveTurnOutputRegistry;
  scopeKey: string;
  inputTurnId: string;
  text: string;
  nativeFailure: NativeFinalDeliveryFailure;
  project: (
    text: string,
    finalizationReason: Extract<
      MessageFinalizationReason,
      'completed' | 'delivery_uncertain' | 'error'
    >,
  ) => Promise<boolean>;
}): Promise<UnacknowledgedProactiveFinalProjectionResult> {
  // Web is the canonical record. An authoritative native rejection says only
  // that the channel copy failed; it must not downgrade the answer itself.
  const finalizationReason =
    input.nativeFailure === 'rejected'
      ? 'completed'
      : input.nativeFailure === 'uncertain'
        ? 'delivery_uncertain'
        : 'error';
  const projected = await input.project(input.text, finalizationReason);
  if (projected) {
    input.registry.recordProjectedUtterance({
      scopeKey: input.scopeKey,
      inputTurnId: input.inputTurnId,
      role: 'final',
      text: input.text,
    });
  }
  return {
    projected,
    webCompleted: projected && input.nativeFailure === 'rejected',
    finalizationReason,
  };
}
