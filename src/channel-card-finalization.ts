import { PartialChannelDeliveryError } from './im-delivery-progress.js';

export interface FinalizableChannelCard {
  complete(text: string): Promise<void>;
  abort(reason?: string): Promise<void>;
  /** Provider-confirmed visible messages already owned by this presentation. */
  getAcknowledgedProviderOutputCount?(): number;
}

export interface ChannelCardFinalizationResult {
  acknowledged: boolean;
  error?: unknown;
}

/**
 * Terminalize a provider card only after every prerequisite physical delivery
 * has been acknowledged.  `acknowledged` is deliberately stricter than
 * "complete was attempted": only a resolved provider terminal operation may
 * advance a Turn/cursor.
 */
export async function finalizeChannelCardAfterDelivery(
  card: FinalizableChannelCard,
  text: string,
  prerequisitesAcknowledged: boolean,
  abortReason: string,
): Promise<ChannelCardFinalizationResult> {
  if (!prerequisitesAcknowledged) {
    try {
      await card.abort(abortReason);
      const acknowledgedOutputs = Math.max(
        0,
        card.getAcknowledgedProviderOutputCount?.() ?? 0,
      );
      if (acknowledgedOutputs > 0) {
        return {
          acknowledged: false,
          error: new PartialChannelDeliveryError(
            acknowledgedOutputs,
            acknowledgedOutputs + 1,
            new Error(
              `Provider stream was terminalized after final-delivery prerequisites failed: ${abortReason}`,
            ),
          ),
        };
      }
      return { acknowledged: false };
    } catch (error) {
      // An abort is itself a provider terminal mutation. Preserve its exact
      // delivery evidence so the host can fence an ACK-lost/partial stream;
      // swallowing it here would incorrectly open the static fallback path.
      return { acknowledged: false, error };
    }
  }

  try {
    await card.complete(text);
    return { acknowledged: true };
  } catch (error) {
    await card.abort(abortReason).catch(() => {});
    return { acknowledged: false, error };
  }
}
