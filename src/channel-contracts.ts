import type { NewMessage } from './types.js';

export type OnChannelMessagePersisted = (
  chatJid: string,
  message: NewMessage & { is_from_me?: boolean },
  agentId?: string,
) => void;

export type OnChannelFollowUpsChanged = (chatJid: string) => void;
