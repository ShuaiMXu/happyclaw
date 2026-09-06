import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-stream-uncertain-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const reliability = await import('../src/channel-reliability-store.js');
const { ChannelTurnRuntime } = await import('../src/channel-turn-runtime.js');
const { finalizeChannelCardAfterDelivery } =
  await import('../src/channel-card-finalization.js');
const { persistUncertainStreamingDelivery } =
  await import('../src/channel-streaming-uncertainty.js');
const { QQStreamingController } = await import('../src/qq-streaming-card.js');
const { isDefinitiveQQPassiveReplyRejection, QQApiError } =
  await import('../src/qq.js');

const route = {
  provider: 'qq',
  accountId: 'qq-bot',
  sourceJid: 'qq:c2c:user-1',
  chatId: 'c2c:user-1',
  rootId: null,
  threadId: null,
};

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('QQ uncertain streaming delivery fence', () => {
  test('duplicate/unknown HTTP 400 never sends active fallback and terminalizes for manual reconciliation', async () => {
    const runtime = ChannelTurnRuntime.start({
      ...route,
      externalMessageId: 'qq-stream-duplicate-400',
    });
    const duplicate = new QQApiError(
      'duplicate or already exists',
      40054005,
      400,
    );
    const activeFallback = vi.fn(async () => {});
    const controller = new QQStreamingController({
      openid: 'user-1',
      msgSeq: 1,
      passiveMsgId: 'inbound-message',
      sendStreamChunk: vi.fn(async () => {
        throw duplicate;
      }),
      fallbackSend: activeFallback,
      onDefinitiveRejection: isDefinitiveQQPassiveReplyRejection,
    });
    controller.append('answer');

    const finalized = await finalizeChannelCardAfterDelivery(
      controller,
      'answer',
      true,
      'delivery failed',
    );
    expect(finalized).toEqual({ acknowledged: false, error: duplicate });
    expect(activeFallback).not.toHaveBeenCalled();

    const fenced = await persistUncertainStreamingDelivery({
      scope: {
        ...route,
        turnRunId: runtime.runId,
        inputTurnId: runtime.inputTurnId,
        owner: 'qq-stream-test',
        token: 'qq-stream-test-token',
      },
      operationKey: 'qq-stream-final',
      payload: { role: 'primary_stream_final', contentHash: 'answer' },
      error: finalized.error,
    });
    expect(fenced?.status).toBe('uncertain');
    expect(
      reliability.getUncertainChannelOutboxForTurn(runtime.runId),
    ).toMatchObject({
      status: 'uncertain',
      kind: 'card',
    });
    expect(
      runtime.interrupt(
        'QQ streaming delivery is uncertain; manual reconciliation required',
      ),
    ).toBe(true);
    expect(reliability.getChannelTurnRun(runtime.runId)).toMatchObject({
      status: 'interrupted',
      error: expect.stringContaining('manual reconciliation required'),
    });
    runtime.dispose();

    const replay = ChannelTurnRuntime.start({
      ...route,
      externalMessageId: 'qq-stream-duplicate-400',
    });
    expect(replay.executionDisposition).toBe('manual_reconciliation');
    replay.dispose();
  });
});
