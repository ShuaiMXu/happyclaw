import { isWhatsAppDirectProviderJid } from './whatsapp-jid.js';

/**
 * Provider-neutral classification for an external channel conversation.
 *
 * Binding policy depends on this value:
 *   - topic          -> workspace binding, one session per native topic
 *   - direct / group -> session binding
 *
 * Unknown values deliberately fail closed. In particular, Feishu uses the
 * same opaque `oc_*` identifier for P2P and group chats, so its durable/live
 * metadata is authoritative and the JID alone must never be guessed.
 */
export type ChannelConversationKind = 'direct' | 'group' | 'topic' | 'unknown';

export interface ChannelConversationMetadata {
  /** Live provider value (for example Feishu `p2p`, `group`, or `topic`). */
  chat_mode?: string | null;
  /** Durable Feishu chat mode stored on registered_groups. */
  feishu_chat_mode?: string | null;
  group_message_type?: string | null;
  feishu_group_message_type?: string | null;
  /** Provider-native context metadata, used by Telegram Forums. */
  native_context_type?: string | null;
  thread_capable?: boolean | null;
}

function baseConversationJid(jid: string): string {
  return jid.split('#', 1)[0];
}

export function resolveChannelConversationKind(
  jid: string,
  metadata: ChannelConversationMetadata = {},
): ChannelConversationKind {
  const baseJid = baseConversationJid(jid);

  if (baseJid.startsWith('feishu:')) {
    const mode = (metadata.chat_mode ?? metadata.feishu_chat_mode)
      ?.trim()
      .toLowerCase();
    if (mode === 'p2p') return 'direct';
    const messageType = (
      metadata.group_message_type ?? metadata.feishu_group_message_type
    )
      ?.trim()
      .toLowerCase();
    // Legacy mention routing also set generic thread flags. Only provider
    // chat metadata identifies a Feishu topic container.
    if (mode === 'topic' || messageType === 'thread') return 'topic';
    if (mode === 'group') return 'group';
    return 'unknown';
  }

  if (baseJid.startsWith('qq:')) {
    if (baseJid.startsWith('qq:c2c:')) return 'direct';
    if (baseJid.startsWith('qq:group:')) return 'group';
    return 'unknown';
  }

  if (baseJid.startsWith('dingtalk:')) {
    if (baseJid.startsWith('dingtalk:c2c:')) return 'direct';
    return baseJid.length > 'dingtalk:'.length ? 'group' : 'unknown';
  }

  if (baseJid.startsWith('discord:')) {
    if (baseJid.startsWith('discord:dm:')) return 'direct';
    return baseJid.length > 'discord:'.length ? 'group' : 'unknown';
  }

  if (baseJid.startsWith('wecom:')) {
    if (baseJid.startsWith('wecom:c2c:')) return 'direct';
    if (baseJid.startsWith('wecom:group:')) return 'group';
    return 'unknown';
  }

  if (baseJid.startsWith('whatsapp:')) {
    // Live JIDs are `whatsapp:${remoteJid}` from Baileys. User chats are PN
    // (`@s.whatsapp.net`, including device-suffixed `user:device@…`), legacy
    // PN (`@c.us`, still used for official-biz / PSA / older devices), LID
    // (`@lid`), and hosted PN/LID (`@hosted`, `@hosted.lid`). Groups stay
    // `@g.us`. Do not guess other suffixes as groups.
    if (isWhatsAppDirectProviderJid(baseJid.slice('whatsapp:'.length))) {
      return 'direct';
    }
    if (baseJid.endsWith('@g.us')) return 'group';
    return 'unknown';
  }

  // The current WeChat connector is P2P-only.
  if (baseJid.startsWith('wechat:')) {
    return baseJid.length > 'wechat:'.length ? 'direct' : 'unknown';
  }

  if (baseJid.startsWith('telegram:')) {
    const id = Number(baseJid.slice('telegram:'.length));
    if (!Number.isSafeInteger(id) || id === 0) return 'unknown';
    if (id > 0) return 'direct';
    return metadata.native_context_type === 'thread' ||
      metadata.thread_capable === true
      ? 'topic'
      : 'group';
  }

  return 'unknown';
}

export function conversationBindingPolicyError(
  kind: ChannelConversationKind,
  target: 'workspace' | 'session',
): string | null {
  if (kind === 'unknown') {
    return 'Unable to determine whether this channel chat is a direct, group or topic conversation; sync the chat metadata and try again';
  }
  if (target === 'workspace' && kind !== 'topic') {
    return 'Workspace bindings only accept native topic groups';
  }
  if (target === 'session' && kind !== 'direct' && kind !== 'group') {
    return 'Session bindings only accept direct chats and ordinary groups';
  }
  return null;
}
