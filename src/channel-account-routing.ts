import type { ChannelConversationKind } from './channel-conversation-kind.js';
import type { ChannelAccount, RegisteredGroup } from './types.js';

export interface ChannelAccountFallbackWorkspace {
  jid: string;
  folder: string;
}

/** Account routing is workspace-owned. A deprecated Agent default must never
 * pick that Agent's arbitrary first workspace. */
export function resolveChannelAccountFallbackWorkspace(
  account: ChannelAccount,
  lookup: {
    getGroup: (jid: string) => RegisteredGroup | undefined;
    getHome: (
      ownerUserId: string,
    ) => (RegisteredGroup & { jid: string }) | undefined;
  },
): ChannelAccountFallbackWorkspace | null {
  if (account.default_workspace_jid) {
    const group = lookup.getGroup(account.default_workspace_jid);
    if (group?.created_by === account.owner_user_id) {
      return { jid: account.default_workspace_jid, folder: group.folder };
    }
  }
  const home = lookup.getHome(account.owner_user_id);
  return home ? { jid: home.jid, folder: home.folder } : null;
}

/** Discovery records the channel account; only an explicit bind selects a target. */
export function applyChannelAccountRegistrationFallback(
  group: RegisteredGroup,
  accountId: string,
  _fallbackWorkspaceJid: string,
  _conversationKind: ChannelConversationKind = 'unknown',
): RegisteredGroup {
  if (group.channel_account_id) return group;
  return { ...group, channel_account_id: accountId };
}
