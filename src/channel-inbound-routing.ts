import { getChannelType } from './im-channel.js';
import {
  isNativeContextContainer,
  resolveChannelMountTarget,
} from './channel-mount-service.js';
import {
  resolveNativeThreadContext,
  type NativeThreadContext,
} from './channel-native-context.js';
import { logger } from './logger.js';
import type {
  RegisteredGroup,
  SubAgent,
  ChannelMount,
  ChannelMessageMeta,
} from './types.js';

export interface ChannelInboundRoutingDeps {
  getRegisteredGroup: (jid: string) => RegisteredGroup | undefined;
  getAgent: (id: string) => SubAgent | undefined;
  getChannelMount: (jid: string) => ChannelMount | undefined;
  resolveWorkspaceJid: (jid: string) => string | null;
  ensureNativeContextChannelMount: (
    jid: string,
    group: RegisteredGroup,
  ) => RegisteredGroup | null;
  resolveOrCreateNativeThreadAgent: (
    jid: string,
    workspaceJid: string,
    workspace: RegisteredGroup,
    group: RegisteredGroup,
    thread: NativeThreadContext,
  ) => { effectiveJid: string; agentId: string; sourceJid: string };
}

export function hasExplicitChannelBinding(
  chatJid: string,
  deps: ChannelInboundRoutingDeps,
): boolean {
  const { getRegisteredGroup, getAgent, resolveWorkspaceJid } = deps;
  const group = getRegisteredGroup(chatJid);
  if (!group || !group.created_by) return false;
  if (!group.target_agent_id && !group.target_main_jid) return false;
  const session = group.target_agent_id
    ? getAgent(group.target_agent_id)
    : undefined;
  if (group.target_agent_id && (!session || session.kind !== 'conversation'))
    return false;
  if (session && isNativeContextContainer(chatJid, group)) return false;
  const workspaceJid =
    session?.chat_jid ?? resolveWorkspaceJid(group.target_main_jid!);
  if (!workspaceJid?.startsWith('web:')) return false;
  const workspace = getRegisteredGroup(workspaceJid);
  return !!workspace && workspace.created_by === group.created_by;
}

export function createChannelInboundRouter(deps: ChannelInboundRoutingDeps): (
  chatJid: string,
  messageMeta?: ChannelMessageMeta,
) => {
  effectiveJid: string;
  agentId: string | null;
  sourceJid?: string;
} | null {
  const {
    getRegisteredGroup,
    getAgent,
    resolveWorkspaceJid,
    getChannelMount,
    ensureNativeContextChannelMount,
    resolveOrCreateNativeThreadAgent,
  } = deps;
  return (chatJid: string, messageMeta) => {
    let group = getRegisteredGroup(chatJid);
    if (!group) {
      logger.debug({ chatJid }, 'resolveEffectiveChatJid: group not found');
      return null;
    }

    if (!hasExplicitChannelBinding(chatJid, deps)) return null;
    const channelType = getChannelType(chatJid);
    const nativeThread =
      channelType === 'feishu' && messageMeta?.nativeContextType !== 'thread'
        ? null
        : resolveNativeThreadContext(messageMeta);
    const topicContainer = isNativeContextContainer(chatJid, group);
    if (topicContainer && !nativeThread) return null;
    const nativeThreadDetected =
      !!nativeThread &&
      (messageMeta?.nativeContextType === 'thread' ||
        (channelType === 'telegram' && !!messageMeta?.threadId));
    if (nativeThreadDetected && topicContainer) {
      const upgraded = ensureNativeContextChannelMount(chatJid, group);
      if (!upgraded) return null;
      group = upgraded;
    }

    const mount = getChannelMount(chatJid);
    if (mount) {
      const mountedTarget = resolveChannelMountTarget(mount, {
        getAgent,
        getRegisteredGroup: (jid) => getRegisteredGroup(jid),
      });
      if (mountedTarget.status === 'stale') {
        logger.warn(
          {
            chatJid,
            reason: mountedTarget.reason,
            sessionId: mountedTarget.sessionId,
            workspaceJid: mountedTarget.workspaceJid,
          },
          'resolveEffectiveChatJid: stale channel_mounts row, message will not route',
        );
        return null;
      }
      if (mountedTarget.workspace.created_by !== group.created_by) return null;
      if (mountedTarget.workspaceMismatch) {
        logger.warn(
          { chatJid, ...mountedTarget.workspaceMismatch },
          'resolveEffectiveChatJid: channel_mounts workspace differs from session owner, using session owner workspace',
        );
      }
      if (mountedTarget.agentId) {
        return {
          effectiveJid: mountedTarget.effectiveJid,
          agentId: mountedTarget.agentId,
        };
      }

      if (
        topicContainer &&
        mount.routing_mode === 'thread_map' &&
        nativeThread
      ) {
        return resolveOrCreateNativeThreadAgent(
          chatJid,
          mountedTarget.workspaceJid,
          mountedTarget.workspace,
          group,
          nativeThread,
        );
      }

      return { effectiveJid: mountedTarget.effectiveJid, agentId: null };
    }

    // Agent binding takes priority
    if (group.target_agent_id) {
      const agent = getAgent(group.target_agent_id);
      if (!agent) {
        logger.warn(
          { chatJid, targetAgentId: group.target_agent_id },
          'resolveEffectiveChatJid: agent not found for target_agent_id',
        );
        return null;
      }
      // Use the agent's actual chat_jid (the workspace's registered JID) as the
      // base for the virtual JID.  Previously we constructed web:${folder} which
      // doesn't match any registered group for non-main workspaces (folder ≠ JID).
      const effectiveJid = `${agent.chat_jid}#agent:${group.target_agent_id}`;
      return { effectiveJid, agentId: group.target_agent_id };
    }

    if (
      topicContainer &&
      group.binding_mode === 'thread_map' &&
      group.target_main_jid &&
      nativeThread
    ) {
      const workspaceJid = resolveWorkspaceJid(group.target_main_jid);
      if (!workspaceJid) {
        logger.warn(
          { chatJid, targetMainJid: group.target_main_jid },
          'thread_map resolveWorkspaceJid returned null — stale target_main_jid',
        );
        return null;
      }
      const workspace = getRegisteredGroup(workspaceJid);
      if (!workspace) return null;

      return resolveOrCreateNativeThreadAgent(
        chatJid,
        workspaceJid,
        workspace,
        group,
        nativeThread,
      );
    }

    // Main conversation binding
    if (group.target_main_jid) {
      const effectiveJid = resolveWorkspaceJid(group.target_main_jid);
      if (!effectiveJid) {
        logger.warn(
          { chatJid, targetMainJid: group.target_main_jid },
          'resolveWorkspaceJid returned null — target_main_jid is stale or missing, message will not route to workspace',
        );
        return null;
      }
      return { effectiveJid, agentId: null };
    }

    logger.debug(
      {
        chatJid,
        targetAgentId: group.target_agent_id,
        targetMainJid: group.target_main_jid,
      },
      'resolveEffectiveChatJid: no binding found',
    );
    return null;
  };
}
