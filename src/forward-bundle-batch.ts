import type { ChannelTurnContext, NewMessage } from './types.js';

export interface ForwardBundleBatchAnchor {
  context: ChannelTurnContext;
  message: NewMessage;
}

/**
 * Extend a structurally verified forward bundle across earlier top-level
 * messages from the same provider chat. This is intentionally narrower than
 * "same chat": unrelated topics in one Feishu group must not inherit the
 * bundle note's reply route or channel capabilities.
 */
export function resolveCompatibleChannelBatchAnchor(
  messages: NewMessage[],
): ForwardBundleBatchAnchor | undefined {
  if (messages.length < 2) return undefined;
  const entries = messages.map((message) => ({
    message,
    context: message.channel_context,
    link: message.channel_context?.message.contentLink,
  }));
  if (entries.some((entry) => !entry.context)) return undefined;
  const first = entries[0].context!;
  if (
    entries.some(
      (entry) =>
        entry.context!.provider !== first.provider ||
        entry.context!.channelAccountId !== first.channelAccountId ||
        entry.context!.chat.id !== first.chat.id,
    )
  ) {
    return undefined;
  }

  const bundleIds = new Set(
    entries
      .map((entry) => entry.link)
      .filter((link) => link?.kind === 'forward_bundle')
      .map((link) => link!.bundleId),
  );
  if (bundleIds.size !== 1) return undefined;
  const bundleId = [...bundleIds][0];
  const bundleEntries = entries.filter(
    (entry) =>
      entry.link?.kind === 'forward_bundle' && entry.link.bundleId === bundleId,
  );
  if (
    !bundleEntries.some((entry) => entry.link!.role === 'forwarded_content')
  ) {
    return undefined;
  }
  const commentEntries = bundleEntries.filter(
    (entry) =>
      entry.link!.role === 'forwarder_comment' &&
      !entry.message.content.trimStart().startsWith('/'),
  );
  if (commentEntries.length === 0) return undefined;
  const anchor = commentEntries[commentEntries.length - 1];
  if (entries[entries.length - 1] !== anchor) return undefined;
  const forwardedRoot = bundleEntries.find(
    (entry) => entry.link!.role === 'forwarded_content',
  )!;

  const bundleThreadIds = new Set(
    bundleEntries
      .map((entry) => entry.context!.message.threadId)
      .filter((threadId): threadId is string => Boolean(threadId)),
  );
  if (bundleThreadIds.size > 1) return undefined;
  const bundleThreadId = [...bundleThreadIds][0];
  for (const entry of entries) {
    if (entry.link?.kind === 'forward_bundle') continue;
    if (entry.context!.sourceJid !== forwardedRoot.context!.sourceJid) {
      return undefined;
    }
    const { threadId, rootId } = entry.context!.message;
    if (threadId && threadId !== bundleThreadId) return undefined;
    if (rootId && rootId !== bundleId) return undefined;
  }

  return { context: anchor.context!, message: anchor.message };
}

/**
 * A merged-forward root and its authored note use different native route JIDs:
 * the note points at the root while the root itself does not. Treat them as one
 * route only when every row carries the adapter's structural assertion for the
 * same bundle. This deliberately does not infer a relationship from message
 * text or provider IDs here.
 */
export function resolveForwardBundleBatchAnchor(
  messages: NewMessage[],
): ForwardBundleBatchAnchor | undefined {
  if (messages.length < 2) return undefined;

  const entries = messages.map((message) => ({
    message,
    context: message.channel_context,
    link: message.channel_context?.message.contentLink,
  }));
  if (
    entries.some(
      (entry) => !entry.context || entry.link?.kind !== 'forward_bundle',
    )
  ) {
    return undefined;
  }

  const first = entries[0];
  const bundleId = first.link!.bundleId;
  if (
    entries.some(
      (entry) =>
        entry.link!.bundleId !== bundleId ||
        entry.context!.provider !== first.context!.provider ||
        entry.context!.channelAccountId !== first.context!.channelAccountId ||
        entry.context!.chat.id !== first.context!.chat.id,
    )
  ) {
    return undefined;
  }

  const threadIds = new Set(
    entries
      .map((entry) => entry.context!.message.threadId)
      .filter((threadId): threadId is string => Boolean(threadId)),
  );
  if (threadIds.size > 1) return undefined;

  const hasForwardedContent = entries.some(
    (entry) => entry.link!.role === 'forwarded_content',
  );
  if (!hasForwardedContent) return undefined;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.link!.role === 'forwarder_comment') {
      if (entry.message.content.trimStart().startsWith('/')) return undefined;
      return {
        context: entry.context!,
        message: entry.message,
      };
    }
  }
  return undefined;
}
