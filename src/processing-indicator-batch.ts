import { getChannelType } from './im-channel.js';

export interface ProcessingIndicatorInput {
  id: string;
  sourceJid?: string | null;
}

export interface ProcessingIndicatorOwner {
  inputTurnId: string;
  transportJid: string;
}

/**
 * Select provider acknowledgement owners for one executing batch.
 *
 * Feishu reactions are created only when a batch starts, so the latest Feishu
 * input is the batch's single visible owner. Other providers still attach at
 * ingress and therefore retain every exact input until they migrate to the
 * same lifecycle independently.
 */
export function selectBatchProcessingIndicatorOwners(
  inputs: ProcessingIndicatorInput[],
  fallbackTransportJid?: string | null,
): ProcessingIndicatorOwner[] {
  const resolved: ProcessingIndicatorOwner[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const explicit = input.sourceJid?.trim();
    const transportJid = explicit
      ? getChannelType(explicit)
        ? explicit
        : null
      : fallbackTransportJid && getChannelType(fallbackTransportJid)
        ? fallbackTransportJid
        : null;
    if (!transportJid) continue;
    const key = `${transportJid}\0${input.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ inputTurnId: input.id, transportJid });
  }

  let lastFeishuIndex = -1;
  for (let index = resolved.length - 1; index >= 0; index -= 1) {
    if (getChannelType(resolved[index].transportJid) === 'feishu') {
      lastFeishuIndex = index;
      break;
    }
  }
  return resolved.filter(
    (owner, index) =>
      getChannelType(owner.transportJid) !== 'feishu' ||
      index === lastFeishuIndex,
  );
}
