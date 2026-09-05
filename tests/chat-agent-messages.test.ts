import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '../web/src/stores/chat';

const {
  apiGetMock,
  apiPostMock,
  apiPatchMock,
  apiDeleteMock,
  deleteAgentMessageSnapshotMock,
  deleteGroupMessageSnapshotsMock,
  loadAgentMessageSnapshotMock,
  saveAgentMessageSnapshotMock,
  notifyIfHiddenMock,
  showToastMock,
  showNotificationPromptToastMock,
} = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  apiPatchMock: vi.fn(),
  apiDeleteMock: vi.fn(),
  deleteAgentMessageSnapshotMock: vi.fn(),
  deleteGroupMessageSnapshotsMock: vi.fn(),
  loadAgentMessageSnapshotMock: vi.fn(),
  saveAgentMessageSnapshotMock: vi.fn(),
  notifyIfHiddenMock: vi.fn(),
  showToastMock: vi.fn(),
  showNotificationPromptToastMock: vi.fn(),
}));

vi.mock('../web/src/api/client', () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
    patch: apiPatchMock,
    delete: apiDeleteMock,
  },
}));

vi.mock('../web/src/api/ws', () => ({
  wsManager: {
    send: vi.fn(() => true),
    on: vi.fn(() => vi.fn()),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  },
}));

vi.mock('../web/src/stores/files', () => ({
  useFileStore: {
    getState: () => ({
      loadFiles: vi.fn(),
    }),
  },
}));

vi.mock('../web/src/stores/auth', () => ({
  useAuthStore: {
    getState: () => ({
      user: null,
    }),
  },
}));

vi.mock('../web/src/utils/toast', () => ({
  showToast: showToastMock,
  notifyIfHidden: notifyIfHiddenMock,
  shouldEmitBackgroundTaskNotice: vi.fn(() => false),
  showNotificationPromptToast: showNotificationPromptToastMock,
}));

vi.mock('../web/src/utils/messageSnapshotCache', () => ({
  deleteAgentMessageSnapshot: deleteAgentMessageSnapshotMock,
  deleteGroupMessageSnapshots: deleteGroupMessageSnapshotsMock,
  loadAgentMessageSnapshot: loadAgentMessageSnapshotMock,
  saveAgentMessageSnapshot: saveAgentMessageSnapshotMock,
}));

const { shouldRecoverStaleWaiting, useChatStore } =
  await import('../web/src/stores/chat');
const initialState = useChatStore.getState();

function message(id: string, timestamp: string): Message {
  return {
    id,
    chat_jid: 'web:main#agent:agent-1',
    sender: 'user',
    sender_name: 'User',
    content: id,
    timestamp,
    is_from_me: false,
  };
}

function resetChatStore(): void {
  useChatStore.setState(
    {
      ...initialState,
      groups: {},
      currentGroup: null,
      messages: {},
      waiting: {},
      activeRuns: {},
      hasMore: {},
      loading: false,
      error: null,
      streaming: {},
      thinkingCache: {},
      thinkingDurationCache: {},
      pendingThinking: {},
      pendingThinkingDuration: {},
      clearing: {},
      agents: {},
      agentStreaming: {},
      activeAgentTab: {},
      sdkTasks: {},
      sdkTaskAliases: {},
      agentMessages: {},
      agentWaiting: {},
      agentHasMore: {},
      drafts: {},
      unreadReplies: {},
    },
    true,
  );
}

describe('loadAgentMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGetMock.mockReset();
    saveAgentMessageSnapshotMock.mockResolvedValue(undefined);
    deleteAgentMessageSnapshotMock.mockResolvedValue(undefined);
    loadAgentMessageSnapshotMock.mockResolvedValue(null);
    resetChatStore();
  });

  it('replaces hydrated agent messages with the server latest page on first-page calibration', async () => {
    const jid = 'web:main';
    const agentId = 'agent-1';
    const staleHydrated = message('stale-snapshot', '2026-01-02T09:30:00.000Z');
    const serverOlder = message('server-older', '2026-01-02T10:00:00.000Z');
    const serverLatest = message('server-latest', '2026-01-02T11:00:00.000Z');

    useChatStore.setState({
      agentMessages: { [agentId]: [staleHydrated] },
      agentHasMore: { [agentId]: true },
    });
    apiGetMock.mockResolvedValueOnce({
      messages: [serverLatest, serverOlder],
      hasMore: false,
    });

    await useChatStore.getState().loadAgentMessages(jid, agentId);

    expect(useChatStore.getState().agentMessages[agentId]).toEqual([
      serverOlder,
      serverLatest,
    ]);
    expect(saveAgentMessageSnapshotMock).toHaveBeenCalledWith(
      jid,
      agentId,
      [serverOlder, serverLatest],
      false,
    );
    expect(deleteAgentMessageSnapshotMock).not.toHaveBeenCalled();
  });

  it('merges older pages only when loading more', async () => {
    const jid = 'web:main';
    const agentId = 'agent-1';
    const currentOlder = message('current-older', '2026-01-02T10:00:00.000Z');
    const currentLatest = message('current-latest', '2026-01-02T11:00:00.000Z');
    const oldOldest = message('old-oldest', '2026-01-02T08:00:00.000Z');
    const oldNewest = message('old-newest', '2026-01-02T09:00:00.000Z');

    useChatStore.setState({
      agentMessages: { [agentId]: [currentOlder, currentLatest] },
      agentHasMore: { [agentId]: true },
    });
    apiGetMock.mockResolvedValueOnce({
      messages: [oldNewest, oldOldest],
      hasMore: false,
    });

    await useChatStore.getState().loadAgentMessages(jid, agentId, true);

    expect(useChatStore.getState().agentMessages[agentId]).toEqual([
      oldOldest,
      oldNewest,
      currentOlder,
      currentLatest,
    ]);
    const calledPath = apiGetMock.mock.calls[0]?.[0] as string;
    const calledUrl = new URL(calledPath, 'http://localhost');
    expect(calledUrl.searchParams.get('before')).toBe(currentOlder.timestamp);
    expect(calledUrl.searchParams.get('agentId')).toBe(agentId);
    expect(saveAgentMessageSnapshotMock).toHaveBeenCalledWith(
      jid,
      agentId,
      [oldOldest, oldNewest, currentOlder, currentLatest],
      false,
    );
  });

  it('clears hydrated messages and deletes the snapshot when the server latest page is empty', async () => {
    const jid = 'web:main';
    const agentId = 'agent-1';
    const staleHydrated = message(
      'deleted-stale-snapshot',
      '2026-01-02T09:30:00.000Z',
    );

    useChatStore.setState({
      agentMessages: { [agentId]: [staleHydrated] },
      agentHasMore: { [agentId]: true },
    });
    apiGetMock.mockResolvedValueOnce({
      messages: [],
      hasMore: false,
    });

    await useChatStore.getState().loadAgentMessages(jid, agentId);

    expect(useChatStore.getState().agentMessages[agentId]).toEqual([]);
    expect(useChatStore.getState().agentHasMore[agentId]).toBe(false);
    expect(saveAgentMessageSnapshotMock).not.toHaveBeenCalled();
    expect(deleteAgentMessageSnapshotMock).toHaveBeenCalledWith(jid, agentId);
  });
});

describe('deleteMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiDeleteMock.mockReset();
    apiGetMock.mockReset();
    deleteAgentMessageSnapshotMock.mockReset();
    deleteAgentMessageSnapshotMock.mockResolvedValue(undefined);
    loadAgentMessageSnapshotMock.mockReset();
    loadAgentMessageSnapshotMock.mockResolvedValue(null);
    resetChatStore();
  });

  it('removes only the exact composite-key row and invalidates Session projections', async () => {
    const jid = 'web:delete-workspace';
    const agentId = 'delete-agent';
    const virtualJid = `${jid}#agent:${agentId}`;
    const otherVirtualJid = 'web:other#agent:other-agent';
    const duplicateId = 'provider-message-id';
    const older = {
      ...message('older-message', '2026-08-20T10:00:00.000Z'),
      chat_jid: virtualJid,
      content: 'previous preview',
    };
    const target = {
      ...message(duplicateId, '2026-08-20T11:00:00.000Z'),
      chat_jid: virtualJid,
      content: 'delete me',
    };
    const sameIdElsewhere = {
      ...message(duplicateId, '2026-08-20T12:00:00.000Z'),
      chat_jid: otherVirtualJid,
      content: 'keep me',
    };
    let snapshotInvalidated = false;
    deleteAgentMessageSnapshotMock.mockImplementation(async () => {
      snapshotInvalidated = true;
    });
    loadAgentMessageSnapshotMock.mockImplementation(async () =>
      snapshotInvalidated ? null : { messages: [target], hasMore: false },
    );
    apiDeleteMock.mockResolvedValue({ success: true });
    // The local sidebar projection must remain correct even if the authoritative
    // refresh is temporarily offline.
    apiGetMock.mockRejectedValue(new Error('offline'));

    useChatStore.setState({
      messages: {
        [jid]: [target, sameIdElsewhere],
        'web:other': [sameIdElsewhere],
      },
      agentMessages: {
        [agentId]: [older, target],
        'other-agent': [sameIdElsewhere],
      },
      agents: {
        [jid]: [
          {
            id: agentId,
            name: 'Delete Session',
            prompt: '',
            status: 'idle',
            kind: 'conversation',
            created_at: '2026-08-20T09:00:00.000Z',
            latest_message: {
              content: target.content,
              timestamp: target.timestamp,
            },
          },
        ],
      },
    });

    const deleted = await useChatStore
      .getState()
      .deleteMessage(virtualJid, duplicateId);

    expect(deleted).toBe(true);
    expect(useChatStore.getState().messages[jid]).toEqual([sameIdElsewhere]);
    expect(useChatStore.getState().messages['web:other']).toEqual([
      sameIdElsewhere,
    ]);
    expect(useChatStore.getState().agentMessages[agentId]).toEqual([older]);
    expect(useChatStore.getState().agentMessages['other-agent']).toEqual([
      sameIdElsewhere,
    ]);
    expect(useChatStore.getState().agents[jid]?.[0]?.latest_message).toEqual({
      content: older.content,
      timestamp: older.timestamp,
    });
    expect(deleteAgentMessageSnapshotMock).toHaveBeenCalledWith(jid, agentId);
    expect(apiGetMock).toHaveBeenCalledWith(
      `/api/groups/${encodeURIComponent(jid)}/agents`,
    );

    // Simulate a fresh PWA store: the invalidated snapshot cannot resurrect the
    // deleted row even while the network is unavailable.
    useChatStore.setState({ agentMessages: {} });
    await useChatStore.getState().hydrateAgentMessages(jid, agentId);
    expect(useChatStore.getState().agentMessages[agentId]).toBeUndefined();
  });

  it('shows a user-visible error when deletion is rejected', async () => {
    apiDeleteMock.mockRejectedValue({
      status: 403,
      message: 'Permission denied',
    });

    const deleted = await useChatStore
      .getState()
      .deleteMessage('web:main', 'protected-message');

    expect(deleted).toBe(false);
    expect(useChatStore.getState().error).toBe('Permission denied');
    expect(showToastMock).toHaveBeenCalledWith('删除失败', 'Permission denied');
  });

  it('applies a remote deletion without issuing a second DELETE request', async () => {
    const jid = 'web:remote-delete';
    const target = {
      ...message('remote-message', '2026-08-20T11:00:00.000Z'),
      chat_jid: jid,
    };
    useChatStore.setState({ messages: { [jid]: [target] } });

    await useChatStore.getState().handleMessageDeleted(jid, target.id);

    expect(useChatStore.getState().messages[jid]).toEqual([]);
    expect(apiDeleteMock).not.toHaveBeenCalled();
  });
});

describe('conversation Agent usage events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveAgentMessageSnapshotMock.mockResolvedValue(undefined);
    resetChatStore();
  });

  it('patches the completed Agent reply even after streaming was cleared', async () => {
    const jid = 'web:main';
    const agentId = 'agent-1';
    const turnId = 'turn-workflow-1';
    const finalReply: Message = {
      id: 'reply-workflow-1',
      chat_jid: `${jid}#agent:${agentId}`,
      sender: 'happyclaw-agent',
      sender_name: 'HappyClaw',
      content: '13×17=221，19×23=437。',
      timestamp: '2026-07-21T15:22:58.000Z',
      is_from_me: true,
      turn_id: turnId,
      source_kind: 'sdk_final',
    };

    useChatStore.setState({
      agentMessages: { [agentId]: [finalReply] },
      agentHasMore: { [agentId]: false },
      agentStreaming: {},
      agentWaiting: { [agentId]: false },
      activeRuns: {
        [`${jid}#agent:${agentId}`]: {
          chatJid: `${jid}#agent:${agentId}`,
          runId: 'run-workflow-1',
          startedAt: '2026-07-21T15:22:00.000Z',
          phase: 'running',
        },
      },
    });

    useChatStore.getState().handleStreamEvent(
      jid,
      {
        eventType: 'usage',
        turnId,
        usage: {
          inputTokens: 74_924,
          outputTokens: 583,
          cacheReadInputTokens: 147_008,
          cacheCreationInputTokens: 0,
          reasoningTokens: 0,
          costUSD: 0,
          durationMs: 72_776,
          numTurns: 3,
        },
      },
      agentId,
      'run-workflow-1',
    );

    const updated = useChatStore.getState().agentMessages[agentId][0];
    expect(JSON.parse(updated.token_usage ?? '{}')).toMatchObject({
      inputTokens: 74_924,
      outputTokens: 583,
      cacheReadInputTokens: 147_008,
      durationMs: 72_776,
    });
    await Promise.resolve();
    expect(saveAgentMessageSnapshotMock).toHaveBeenCalledWith(
      jid,
      agentId,
      [expect.objectContaining({ id: finalReply.id })],
      false,
    );
  });
});

describe('exact Web run state sequences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChatStore();
  });

  it('replaces A streaming with B snapshot after reconnect', () => {
    const jid = 'web:reconnect';
    useChatStore.setState({
      activeRuns: {
        [jid]: {
          chatJid: jid,
          runId: 'run-a',
          startedAt: '2026-07-25T00:00:00.000Z',
          phase: 'running',
        },
      },
      waiting: { [jid]: true },
      streaming: {
        [jid]: {
          partialText: 'A stale partial',
          thinkingText: '',
          isThinking: false,
          activeTools: [],
          activeHook: null,
          systemStatus: null,
          recentEvents: [],
          traceEvents: [],
          taskStates: {},
        },
      },
    });

    useChatStore.getState().handleActiveRunSnapshot([
      {
        chatJid: jid,
        runId: 'run-b',
        startedAt: '2026-07-25T00:01:00.000Z',
        phase: 'running',
      },
    ]);
    expect(useChatStore.getState().streaming[jid]).toBeUndefined();
    expect(useChatStore.getState().activeRuns[jid]?.runId).toBe('run-b');

    useChatStore.getState().handleStreamSnapshot(
      jid,
      {
        partialText: 'B canonical partial',
        activeTools: [],
        recentEvents: [],
        systemStatus: null,
      },
      undefined,
      'run-b',
    );

    expect(useChatStore.getState().streaming[jid]?.partialText).toBe(
      'B canonical partial',
    );
  });

  it('does not restore waiting for proactive sdk_send_message on a warm idle runner', async () => {
    const jid = 'web:proactive-idle';
    const proactiveUtterance: Message = {
      id: 'utterance-1',
      chat_jid: jid,
      sender: 'happyclaw-agent',
      sender_name: 'HappyClaw',
      content: '我先告诉你当前进度。',
      timestamp: '2026-07-25T00:00:00.000Z',
      is_from_me: true,
      source_kind: 'sdk_send_message',
    };
    useChatStore.setState({
      messages: { [jid]: [proactiveUtterance] },
      waiting: { [jid]: true },
      streaming: {
        [jid]: {
          partialText: 'stale',
          thinkingText: '',
          isThinking: false,
          activeTools: [],
          activeHook: null,
          systemStatus: null,
          recentEvents: [],
          traceEvents: [],
          taskStates: {},
        },
      },
    });
    apiGetMock.mockImplementation(async (path: string) => {
      if (path === '/api/status') {
        return {
          groups: [
            {
              jid,
              active: true,
              pendingMessages: false,
              queryInFlight: false,
              queryId: null,
            },
          ],
        };
      }
      return { messages: [] };
    });

    await useChatStore.getState().restoreActiveState();

    expect(useChatStore.getState().waiting[jid]).toBeUndefined();
    expect(useChatStore.getState().streaming[jid]).toBeUndefined();
  });

  it('never stale-recovers an exact active run', () => {
    expect(
      shouldRecoverStaleWaiting({
        elapsedMs: 10 * 60_000,
        hasStreamData: false,
        hasActiveRun: true,
      }),
    ).toBe(false);
    expect(
      shouldRecoverStaleWaiting({
        elapsedMs: 10 * 60_000,
        hasStreamData: true,
        hasActiveRun: true,
      }),
    ).toBe(false);
  });

  it('stale-recovers only an orphaned waiting state after its grace period', () => {
    expect(
      shouldRecoverStaleWaiting({
        elapsedMs: 60_000,
        hasStreamData: false,
        hasActiveRun: false,
      }),
    ).toBe(false);
    expect(
      shouldRecoverStaleWaiting({
        elapsedMs: 60_001,
        hasStreamData: false,
        hasActiveRun: false,
      }),
    ).toBe(true);
    expect(
      shouldRecoverStaleWaiting({
        elapsedMs: 180_000,
        hasStreamData: true,
        hasActiveRun: false,
      }),
    ).toBe(false);
    expect(
      shouldRecoverStaleWaiting({
        elapsedMs: 180_001,
        hasStreamData: true,
        hasActiveRun: false,
      }),
    ).toBe(true);
  });

  it('treats each proactive utterance as unread without finalizing its active run', () => {
    const jid = 'web:proactive-live';
    const runId = 'run-proactive-live';
    const utterance = {
      id: 'utterance-live-1',
      chat_jid: jid,
      sender: 'happyclaw-agent',
      sender_name: 'HappyClaw',
      content: '官方资料已经查完，我还在核对第三方实测。',
      timestamp: '2026-07-25T00:00:30.000Z',
      is_from_me: true,
      source_kind: 'sdk_send_message',
    };
    useChatStore.setState({
      currentGroup: 'web:other',
      groups: {
        [jid]: {
          name: '主动调研',
          folder: 'proactive-live',
          added_at: '2026-07-25T00:00:00.000Z',
          interaction_mode: 'proactive',
        },
      },
      activeRuns: {
        [jid]: {
          chatJid: jid,
          runId,
          startedAt: '2026-07-25T00:00:00.000Z',
          phase: 'running',
        },
      },
      waiting: { [jid]: true },
      streaming: {
        [jid]: {
          partialText: '',
          thinkingText: '',
          isThinking: false,
          activeTools: [],
          activeHook: null,
          systemStatus: 'requesting',
          recentEvents: [],
          traceEvents: [],
          taskStates: {},
        },
      },
    });

    useChatStore.getState().handleWsNewMessage(jid, utterance);

    let state = useChatStore.getState();
    expect(state.messages[jid]).toEqual([
      expect.objectContaining({ id: utterance.id }),
    ]);
    expect(state.unreadReplies[jid]).toBe(1);
    expect(state.waiting[jid]).toBe(true);
    expect(state.streaming[jid]?.systemStatus).toBe('requesting');
    expect(notifyIfHiddenMock).toHaveBeenCalledWith(
      '主动调研',
      utterance.content,
    );
    expect(showNotificationPromptToastMock).not.toHaveBeenCalled();

    // A duplicate WebSocket frame must not create another unread/notification.
    useChatStore.getState().handleWsNewMessage(jid, utterance);
    state = useChatStore.getState();
    expect(state.unreadReplies[jid]).toBe(1);
    expect(notifyIfHiddenMock).toHaveBeenCalledTimes(1);

    useChatStore.getState().handleRunFinished(jid, runId);
    state = useChatStore.getState();
    expect(state.waiting[jid]).toBe(false);
    expect(state.streaming[jid]).toBeUndefined();
  });

  it('marks a proactive conversation message unread outside its active tab', () => {
    const jid = 'web:main';
    const agentId = 'agent-proactive';
    useChatStore.setState({
      currentGroup: jid,
      activeAgentTab: { [jid]: null },
      agentWaiting: { [agentId]: true },
      agents: {
        [jid]: [
          {
            id: agentId,
            name: '主动调研',
            prompt: '',
            status: 'running',
            kind: 'conversation',
            created_at: '2026-07-25T00:00:00.000Z',
            latest_message: null,
          },
        ],
      },
    });

    useChatStore.getState().handleWsNewMessage(
      jid,
      {
        id: 'agent-utterance-1',
        chat_jid: `${jid}#agent:${agentId}`,
        sender: 'happyclaw-agent',
        sender_name: 'HappyClaw',
        content: '我先给你一个阶段结论。',
        timestamp: '2026-07-25T00:00:30.000Z',
        is_from_me: true,
        source_kind: 'sdk_send_message',
      },
      agentId,
    );

    let state = useChatStore.getState();
    expect(state.unreadReplies[jid]).toBe(1);
    expect(state.agentWaiting[agentId]).toBe(true);
    expect(state.agents[jid][0]).toMatchObject({
      last_active_at: '2026-07-25T00:00:30.000Z',
      latest_message: {
        content: '我先给你一个阶段结论。',
        timestamp: '2026-07-25T00:00:30.000Z',
      },
    });
    expect(notifyIfHiddenMock).toHaveBeenCalledTimes(1);
    expect(showNotificationPromptToastMock).not.toHaveBeenCalled();

    // unreadReplies is Workspace-scoped today, so entering this Agent
    // conversation marks the current Workspace as read.
    useChatStore.getState().setActiveAgentTab(jid, agentId);
    state = useChatStore.getState();
    expect(state.activeAgentTab[jid]).toBe(agentId);
    expect(state.unreadReplies[jid]).toBeUndefined();

    useChatStore.setState({ unreadReplies: { [jid]: 1 } });
    useChatStore.getState().setActiveAgentTab(jid, null);
    state = useChatStore.getState();
    expect(state.activeAgentTab[jid]).toBeNull();
    expect(state.unreadReplies[jid]).toBeUndefined();
  });

  it('does not clear unread when mirroring a background workspace tab', () => {
    const visibleJid = 'web:visible';
    const backgroundJid = 'web:background';
    useChatStore.setState({
      currentGroup: visibleJid,
      unreadReplies: { [backgroundJid]: 2 },
    });

    useChatStore
      .getState()
      .setActiveAgentTab(backgroundJid, 'agent-background');

    const state = useChatStore.getState();
    expect(state.activeAgentTab[backgroundJid]).toBe('agent-background');
    expect(state.unreadReplies[backgroundJid]).toBe(2);
  });
});

describe('held Workflow acknowledgements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveAgentMessageSnapshotMock.mockResolvedValue(undefined);
    resetChatStore();
  });

  const runningWorkflow = {
    taskId: 'wkk0k70oj',
    workflowName: 'test-dynamic-workflow',
    summary: '动态工作流测试',
    status: 'running' as const,
    phases: [
      { index: 1, title: 'Discover' },
      { index: 2, title: 'Research' },
      { index: 3, title: 'Synthesize' },
    ],
    agents: [],
  };

  it('keeps a conversation Agent Workflow card live after the held sdk_final', () => {
    const jid = 'web:main';
    const agentId = 'agent-1';

    useChatStore.getState().handleWsNewMessage(
      jid,
      {
        id: 'held-agent-reply',
        chat_jid: `${jid}#agent:${agentId}`,
        sender: 'happyclaw-agent',
        sender_name: 'HappyClaw',
        content: '工作流已启动',
        timestamp: '2026-07-21T15:32:53.000Z',
        is_from_me: true,
        source_kind: 'sdk_final',
        workflow_runs: [runningWorkflow],
      },
      agentId,
    );

    const state = useChatStore.getState();
    expect(state.agentWaiting[agentId]).toBe(true);
    expect(
      state.agentStreaming[agentId].taskStates.wkk0k70oj.workflowRun,
    ).toMatchObject({ status: 'running', phases: runningWorkflow.phases });
    expect(state.agentMessages[agentId][0].workflow_runs).toBeUndefined();
  });

  it('keeps the main-conversation Workflow card live after the held sdk_final', () => {
    const jid = 'web:main';

    useChatStore.getState().handleWsNewMessage(jid, {
      id: 'held-main-reply',
      chat_jid: jid,
      sender: 'happyclaw-agent',
      sender_name: 'HappyClaw',
      content: '工作流已启动',
      timestamp: '2026-07-21T15:32:53.000Z',
      is_from_me: true,
      source_kind: 'sdk_final',
      workflow_runs: [runningWorkflow],
    });

    const state = useChatStore.getState();
    expect(state.waiting[jid]).toBe(true);
    expect(state.streaming[jid].taskStates.wkk0k70oj.workflowRun).toMatchObject(
      { status: 'running', phases: runningWorkflow.phases },
    );
    expect(state.messages[jid][0].workflow_runs).toBeUndefined();
  });
});

describe('SDK task terminal status and sticky API retry', () => {
  const rafCbs: FrameRequestCallback[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    resetChatStore();
    rafCbs.length = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCbs.push(cb);
      return rafCbs.length;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafCbs[id - 1] = () => {};
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function flushRaf(): void {
    const pending = rafCbs.splice(0);
    for (const cb of pending) cb(0);
  }

  const baseStreaming = {
    partialText: '',
    thinkingText: '',
    isThinking: false,
    activeTools: [] as [],
    activeHook: null,
    systemStatus: null as string | null,
    recentEvents: [] as [],
    traceEvents: [] as [],
    taskStates: {},
  };

  it('finalizes stopped and aborted task_updated so they leave running counts', () => {
    const jid = 'web:main';
    const runId = 'run-terminal-tasks';
    useChatStore.setState({
      activeRuns: {
        [jid]: {
          chatJid: jid,
          runId,
          startedAt: '2026-07-25T00:00:00.000Z',
          phase: 'running',
        },
      },
      waiting: { [jid]: true },
      streaming: { [jid]: { ...baseStreaming } },
      sdkTasks: {
        'task-stopped': {
          chatJid: jid,
          description: 'stopped task',
          status: 'running',
        },
        'task-aborted': {
          chatJid: jid,
          description: 'aborted task',
          status: 'running',
        },
      },
    });

    useChatStore.getState().handleStreamEvent(
      jid,
      {
        eventType: 'task_updated',
        toolUseId: 'task-stopped',
        taskId: 'task-stopped',
        taskPatch: { status: 'stopped' },
      },
      undefined,
      runId,
    );
    useChatStore.getState().handleStreamEvent(
      jid,
      {
        eventType: 'task_updated',
        toolUseId: 'task-aborted',
        taskId: 'task-aborted',
        taskPatch: { status: 'aborted' },
      },
      undefined,
      runId,
    );

    const state = useChatStore.getState();
    expect(state.sdkTasks['task-stopped']?.status).toBe('error');
    expect(state.sdkTasks['task-aborted']?.status).toBe('error');
    expect(state.streaming[jid]?.taskStates['task-stopped']?.status).toBe(
      'error',
    );
    expect(state.streaming[jid]?.taskStates['task-aborted']?.status).toBe(
      'error',
    );
    expect(
      Object.values(state.sdkTasks).filter((task) => task.status === 'running'),
    ).toHaveLength(0);
  });

  it('clears sticky API retry status when generation resumes', () => {
    const jid = 'web:main';
    const runId = 'run-retry-clear';
    useChatStore.setState({
      activeRuns: {
        [jid]: {
          chatJid: jid,
          runId,
          startedAt: '2026-07-25T00:00:00.000Z',
          phase: 'running',
        },
      },
      waiting: { [jid]: true },
      streaming: {
        [jid]: {
          ...baseStreaming,
          systemStatus: 'API 重试中 (1/3)，2s 后重试',
        },
      },
    });

    useChatStore.getState().handleStreamEvent(
      jid,
      {
        eventType: 'text_delta',
        text: 'hello',
      },
      undefined,
      runId,
    );
    flushRaf();

    expect(useChatStore.getState().streaming[jid]?.systemStatus).toBeNull();
    expect(useChatStore.getState().streaming[jid]?.partialText).toBe('hello');
  });

  it('clears sticky API retry status on tool_use_start without waiting for rAF', () => {
    const jid = 'web:main';
    const runId = 'run-retry-tool';
    useChatStore.setState({
      activeRuns: {
        [jid]: {
          chatJid: jid,
          runId,
          startedAt: '2026-07-25T00:00:00.000Z',
          phase: 'running',
        },
      },
      waiting: { [jid]: true },
      streaming: {
        [jid]: {
          ...baseStreaming,
          systemStatus: 'API retry in progress (2/5)',
        },
      },
    });

    useChatStore.getState().handleStreamEvent(
      jid,
      {
        eventType: 'tool_use_start',
        toolName: 'Read',
        toolUseId: 'tool-1',
      },
      undefined,
      runId,
    );

    expect(useChatStore.getState().streaming[jid]?.systemStatus).toBeNull();
  });

  it('does not clear unrelated system status on text_delta', () => {
    const jid = 'web:main';
    const runId = 'run-keep-status';
    useChatStore.setState({
      activeRuns: {
        [jid]: {
          chatJid: jid,
          runId,
          startedAt: '2026-07-25T00:00:00.000Z',
          phase: 'running',
        },
      },
      waiting: { [jid]: true },
      streaming: {
        [jid]: {
          ...baseStreaming,
          systemStatus: '正在整理上下文…',
        },
      },
    });

    useChatStore.getState().handleStreamEvent(
      jid,
      {
        eventType: 'text_delta',
        text: 'still compacting context note',
      },
      undefined,
      runId,
    );
    flushRaf();

    expect(useChatStore.getState().streaming[jid]?.systemStatus).toBe(
      '正在整理上下文…',
    );
    expect(useChatStore.getState().streaming[jid]?.partialText).toBe(
      'still compacting context note',
    );
  });
});
