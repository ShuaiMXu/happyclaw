import { logger } from './logger.js';
import { deleteSession, setSessionProviderId } from './db.js';
import { buildRecentConversationHistoryContext } from './conversation-history.js';
export interface ProviderSwitchInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  turnId?: string;
  /** Persisted message IDs already represented by this cold-run prompt. */
  readonly currentBatchMessageIds?: readonly string[];
  isScheduledTask?: boolean;
  agentId?: string;
}

const PROVIDER_SWITCH_HISTORY_INTRO =
  '检测到本次因切换 provider 需要使用新的底层模型 session。以下是 HappyClaw 保存的最近对话记录，供你延续上下文。';

export interface ProviderSwitchSelection {
  profileId: string;
  previousProviderId?: string;
  resetSession?: boolean;
}

function conversationHistoryChatJid(input: ProviderSwitchInput): string {
  if (!input.agentId) return input.chatJid;
  if (input.chatJid.includes('#agent:')) return input.chatJid;
  return `${input.chatJid}#agent:${input.agentId}`;
}

function seedPromptWithPersistedHistory<T extends ProviderSwitchInput>(
  input: T,
): T {
  // Isolated scheduled tasks use their own session namespace and must not
  // inherit the workspace chat. Conversation turns (including group-mode
  // scheduled prompts that arrive via processGroupMessages) do.
  if (input.isScheduledTask) return input;
  // Orchestration may already have prepended recovery/provider-switch history.
  if (input.prompt.includes('<system_context>')) return input;

  const pendingMessageIds = new Set(input.currentBatchMessageIds);
  if (input.turnId) pendingMessageIds.add(input.turnId);

  const chatJid = conversationHistoryChatJid(input);
  const history = buildRecentConversationHistoryContext(
    chatJid,
    pendingMessageIds,
    {
      limit: 30,
      maxMessageLength: 700,
      intro: PROVIDER_SWITCH_HISTORY_INTRO,
    },
  );
  if (!history) return input;

  logger.info(
    {
      groupFolder: input.groupFolder,
      chatJid,
      historyCount: history.count,
    },
    'Provider switch: injected recent conversation history into prompt',
  );
  return { ...input, prompt: history.context + input.prompt };
}

/**
 * Claude SDK sessions are bound to one OAuth account / provider. When the
 * pool fails over, drop the resume token and seed the replacement session
 * with HappyClaw's persisted transcript so prior user/assistant turns survive.
 *
 * Isolated scheduled tasks only drop the resume token.
 */
export function applyProviderSwitchToInput<T extends ProviderSwitchInput>(
  input: T,
  poolResult: ProviderSwitchSelection | null,
  sessionAgentId?: string | null,
): T {
  if (!poolResult?.resetSession) return input;

  logger.info(
    {
      groupFolder: input.groupFolder,
      agentId: sessionAgentId || null,
      previousProviderId: poolResult.previousProviderId,
      providerId: poolResult.profileId,
    },
    'Clearing Claude session after switching providers',
  );

  // deleteSession removes the whole sessions row, including the provider_id
  // binding trySelectPoolProvider just wrote. Re-bind the freshly-selected
  // provider so the next turn stays sticky to it instead of degrading to a
  // fresh pool pick.
  if (input.sessionId) {
    deleteSession(input.groupFolder, sessionAgentId);
    setSessionProviderId(
      input.groupFolder,
      sessionAgentId,
      poolResult.profileId,
    );
  }

  return {
    ...seedPromptWithPersistedHistory(input),
    sessionId: undefined,
  };
}
