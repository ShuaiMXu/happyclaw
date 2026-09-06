import {
  deliverChannelOutboxItem,
  type ChannelOutboxDeliveryResult,
} from './channel-outbox-delivery.js';
import {
  semanticChannelOutboxIdentity,
  stableChannelOutboxOrdinal,
  type ActiveChannelOutboxScope,
} from './channel-outbox-runtime-scope.js';
import { classifyImSendFailure } from './im-send-retry-policy.js';

/**
 * Persist a provider streaming side effect whose acknowledgement was lost.
 *
 * Streaming APIs perform their mutation inside the controller, outside the
 * ordinary static-message Outbox callback. Re-entering the Outbox at its
 * already-started `sending` boundary records the same ambiguity without
 * invoking another provider call. The resulting `uncertain` row fences the
 * whole Turn and routes it through manual reconciliation.
 */
export async function persistUncertainStreamingDelivery(input: {
  scope: ActiveChannelOutboxScope;
  operationKey: string;
  payload: Record<string, unknown>;
  error: unknown;
}): Promise<ChannelOutboxDeliveryResult | null> {
  if (classifyImSendFailure(input.error) !== 'uncertain') return null;
  const semanticIdentity = semanticChannelOutboxIdentity({
    route: input.scope,
    kind: 'card',
    payload: input.payload,
    ordinalSlot: input.operationKey,
  });
  const ordinal = stableChannelOutboxOrdinal(semanticIdentity);
  return deliverChannelOutboxItem({
    provider: input.scope.provider,
    accountId: input.scope.accountId,
    sourceJid: input.scope.sourceJid,
    chatId: input.scope.chatId,
    rootId: input.scope.rootId,
    threadId: input.scope.threadId,
    turnRunId: input.scope.turnRunId,
    ordinal,
    kind: 'card',
    payload: input.payload,
    idempotencyKey: `${input.scope.turnRunId}:${semanticIdentity}`,
    owner: input.scope.owner,
    delivery: {
      mode: 'single',
      // The physical stream attempt already happened. Throwing from the
      // persisted `sending` phase records uncertainty and never sends again.
      send: async () => {
        throw input.error;
      },
    },
  });
}
