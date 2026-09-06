import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'provider-failover-context-'),
);

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runtimeConfig = await import('../src/runtime-config.js');
const db = await import('../src/db.js');
const { trySelectPoolProvider } = await import('../src/container-runner.js');
const { applyProviderSwitchToInput } =
  await import('../src/provider-switch-context.js');
const { providerPool } = await import('../src/provider-pool.js');

const created: string[] = [];

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'groups'), { recursive: true });
  db.initDatabase();
  for (const name of ['Account A', 'Account B']) {
    created.push(
      runtimeConfig.createProvider({
        name,
        type: 'official',
        anthropicApiKey: `${name.replace(/\s+/g, '-').toLowerCase()}-key`,
        anthropicModel: 'claude-fable-5',
        enabled: true,
      }).id,
    );
  }
  runtimeConfig.saveBalancingConfig({
    strategy: 'failover',
    unhealthyThreshold: 1,
    recoveryIntervalMs: 300_000,
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  for (const id of created) providerPool.resetHealth(id);
});

function persistTurn(
  chatJid: string,
  id: string,
  content: string,
  isFromMe: boolean,
  timestamp: string,
) {
  db.ensureChatExists(chatJid);
  db.storeMessageDirect(
    id,
    chatJid,
    isFromMe ? 'happyclaw' : 'user-1',
    isFromMe ? 'HappyClaw' : 'Dennis',
    content,
    timestamp,
    isFromMe,
  );
}

function conversationInput(opts?: {
  prompt?: string;
  sessionId?: string;
  chatJid?: string;
  turnId?: string;
  currentBatchMessageIds?: readonly string[];
  isScheduledTask?: boolean;
  agentId?: string;
  groupFolder?: string;
}) {
  return {
    prompt: opts?.prompt ?? '当前用户消息',
    sessionId: opts?.sessionId ?? 'sess-account-a',
    groupFolder: opts?.groupFolder ?? 'failover-keep-context',
    chatJid: opts?.chatJid ?? 'web:failover-keep-context',
    turnId: opts?.turnId ?? 'pending-now',
    currentBatchMessageIds: opts?.currentBatchMessageIds,
    isScheduledTask: opts?.isScheduledTask,
    agentId: opts?.agentId,
    isMain: true,
  };
}

/**
 * Session stickiness binds a Claude SDK session to one OAuth account.
 * Failover must start a new session on the next provider, but the new
 * prompt has to carry HappyClaw's persisted user/assistant turns — otherwise
 * the replacement account sees an empty conversation.
 */
describe('provider failover keeps conversation context', () => {
  test('sticky provider fails → next provider is selected with prior turns seeded', () => {
    const groupFolder = 'failover-keep-context';
    const chatJid = 'web:failover-keep-context';
    db.setSession(groupFolder, 'sess-account-a', null);
    db.setSessionProviderId(groupFolder, null, created[0]);
    persistTurn(
      chatJid,
      'user-1',
      '请记住项目代号 Phoenix',
      false,
      '2026-08-18T10:00:00.000Z',
    );
    persistTurn(
      chatJid,
      'asst-1',
      '已记住，项目代号是 Phoenix。',
      true,
      '2026-08-18T10:00:01.000Z',
    );
    persistTurn(
      chatJid,
      'pending-now',
      '继续刚才的计划',
      false,
      '2026-08-18T10:00:02.000Z',
    );

    providerPool.reportFailure(created[0], true);
    expect(providerPool.getHealthStatus(created[0]).healthy).toBe(false);

    const selected = trySelectPoolProvider(groupFolder, null, null);
    expect(selected).not.toBeNull();
    expect(selected!.profileId).toBe(created[1]);
    expect(selected!.resetSession).toBe(true);
    expect(selected!.previousProviderId).toBe(created[0]);

    const prepared = applyProviderSwitchToInput(
      conversationInput({ groupFolder, chatJid }),
      selected,
      null,
    );

    expect(prepared.sessionId).toBeUndefined();
    expect(prepared.prompt).toContain('请记住项目代号 Phoenix');
    expect(prepared.prompt).toContain('已记住，项目代号是 Phoenix。');
    expect(prepared.prompt).toContain('当前用户消息');
    expect(prepared.prompt).not.toContain('继续刚才的计划');
    expect(db.getSessionProviderId(groupFolder, null)).toBe(created[1]);
  });

  test('healthy sticky path keeps the resume token and does not rewrite the prompt', () => {
    const groupFolder = 'failover-sticky-healthy';
    const chatJid = 'web:failover-sticky-healthy';
    db.setSession(groupFolder, 'sess-keep', null);
    db.setSessionProviderId(groupFolder, null, created[0]);
    persistTurn(
      chatJid,
      'hist-user',
      '历史不该被注入',
      false,
      '2026-08-18T11:00:00.000Z',
    );

    const selected = trySelectPoolProvider(groupFolder, null, null);
    expect(selected?.profileId).toBe(created[0]);
    expect(selected?.resetSession ?? false).toBe(false);

    const input = conversationInput({
      groupFolder,
      chatJid,
      sessionId: 'sess-keep',
      prompt: '只问这一句',
    });
    const prepared = applyProviderSwitchToInput(input, selected, null);
    expect(prepared.sessionId).toBe('sess-keep');
    expect(prepared.prompt).toBe('只问这一句');
    expect(prepared.prompt).not.toContain('<system_context>');
  });

  test('excludes every pending message in a cold-run batch while preserving the original prompt', () => {
    const groupFolder = 'failover-pending-batch';
    const chatJid = 'web:failover-pending-batch';
    const currentPrompt = 'Dennis: 第一条当前消息\nDennis: 第二条当前消息';
    persistTurn(
      chatJid,
      'hist-user',
      '需要保留的历史消息',
      false,
      '2026-08-18T10:30:00.000Z',
    );
    persistTurn(
      chatJid,
      'pending-first',
      '第一条当前消息',
      false,
      '2026-08-18T10:30:01.000Z',
    );
    persistTurn(
      chatJid,
      'pending-last',
      '第二条当前消息',
      false,
      '2026-08-18T10:30:02.000Z',
    );

    const prepared = applyProviderSwitchToInput(
      conversationInput({
        groupFolder,
        chatJid,
        turnId: 'pending-last',
        currentBatchMessageIds: ['pending-first', 'pending-last'],
        prompt: currentPrompt,
      }),
      {
        profileId: created[1],
        previousProviderId: created[0],
        resetSession: true,
      },
      null,
    );

    const historyBlock = prepared.prompt.slice(
      0,
      prepared.prompt.indexOf('</system_context>'),
    );
    expect(historyBlock).toContain('需要保留的历史消息');
    expect(historyBlock).not.toContain('第一条当前消息');
    expect(historyBlock).not.toContain('第二条当前消息');
    expect(prepared.prompt.endsWith(currentPrompt)).toBe(true);
  });

  test('does not double-inject when orchestration already seeded history', () => {
    const already =
      '<system_context>\n已注入的历史\n</system_context>\n\n当前用户消息';
    const prepared = applyProviderSwitchToInput(
      conversationInput({ prompt: already }),
      {
        profileId: created[1],
        previousProviderId: created[0],
        resetSession: true,
      },
      null,
    );
    expect(prepared.prompt).toBe(already);
    expect(prepared.sessionId).toBeUndefined();
  });

  test('isolated scheduled tasks drop resume without inheriting workspace chat', () => {
    const chatJid = 'web:failover-scheduled';
    persistTurn(
      chatJid,
      'ws-user',
      '工作区闲聊不该进隔离任务',
      false,
      '2026-08-18T12:00:00.000Z',
    );
    const prepared = applyProviderSwitchToInput(
      conversationInput({
        chatJid,
        prompt: '跑每日巡检',
        isScheduledTask: true,
      }),
      {
        profileId: created[1],
        previousProviderId: created[0],
        resetSession: true,
      },
      null,
    );
    expect(prepared.sessionId).toBeUndefined();
    expect(prepared.prompt).toBe('跑每日巡检');
    expect(prepared.prompt).not.toContain('工作区闲聊');
  });
});
