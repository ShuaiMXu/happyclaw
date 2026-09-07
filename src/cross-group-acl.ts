import type { RegisteredGroup } from './types.js';

/**
 * Check if a source group is authorized to send IPC messages to a target group.
 * - Admin home can send to any group.
 * - Non-home groups can only send to groups sharing the same folder.
 * - Member home groups can send to groups created by the same user.
 * - IM channels bound (target_main_jid) to the source workspace are reachable
 *   from that workspace — without this, after agent-runner started rewriting
 *   ctx.chatJid to the IM source, send_file/send_image/send_message from
 *   non-home sub-workspaces got rejected.
 * - IM channels bound to a Runtime Session (target_agent_id) resolve through
 *   that session's workspace folder. Workspace binds record target_main_jid,
 *   but direct-chat session binds only record target_agent_id and leave the
 *   channel row's own `folder` at the channel account's default workspace, so
 *   the folder and target_main_jid branches both miss and every reply from a
 *   session living outside that default workspace was rejected — the runner
 *   completed the turn while the channel stayed silent.
 */
export function canSendCrossGroupMessage(
  isAdminHome: boolean,
  isHome: boolean,
  sourceFolder: string,
  sourceGroupEntry: RegisteredGroup | undefined,
  targetGroup: RegisteredGroup | undefined,
  lookupGroup: (jid: string) => RegisteredGroup | undefined,
  /**
   * Resolve a Runtime Session id to the workspace folder it lives in.
   * Returns undefined for unknown sessions, which denies the branch.
   */
  lookupAgentFolder: (agentId: string) => string | undefined,
): boolean {
  if (isAdminHome) return true;
  if (targetGroup && targetGroup.folder === sourceFolder) return true;
  if (
    isHome &&
    targetGroup &&
    sourceGroupEntry?.created_by != null &&
    targetGroup.created_by === sourceGroupEntry.created_by
  )
    return true;
  if (targetGroup?.target_main_jid) {
    const bound = lookupGroup(targetGroup.target_main_jid);
    if (bound?.folder === sourceFolder) return true;
  }
  if (targetGroup?.target_agent_id) {
    // An unknown session yields undefined, which never equals a folder string.
    if (lookupAgentFolder(targetGroup.target_agent_id) === sourceFolder)
      return true;
  }
  return false;
}
