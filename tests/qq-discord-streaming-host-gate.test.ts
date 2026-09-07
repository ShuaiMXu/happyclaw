import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-discord-host-gate-'));
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
const { DefinitiveChannelDeliveryError } =
  await import('../src/channel-outbox-delivery.js');
const { classifyImSendFailure, preAcceptImDeliveryError } =
  await import('../src/im-send-retry-policy.js');
const { DiscordStreamingEditController } =
  await import('../src/discord-streaming-edit.js');
const { QQStreamingController } = await import('../src/qq-streaming-card.js');

type HostKind = 'main' | 'conversation';
type HostController = {
  isActive(): boolean;
  complete(text: string): Promise<void>;
  abort(reason?: string): Promise<void>;
  getAcknowledgedProviderOutputCount?(): number;
};

async function runHostGate(input: {
  kind: HostKind;
  controller: HostController;
  text: string;
  prerequisitesAcknowledged?: boolean;
  staticSend: (text: string) => Promise<void>;
  route: {
    provider: string;
    accountId: string;
    sourceJid: string;
    chatId: string;
    rootId: null;
    threadId: null;
  };
  scope?: {
    turnRunId: string;
    inputTurnId: string;
    owner: string;
    token: string;
  };
}) {
  const pendingCard = input.controller.isActive()
    ? input.controller
    : undefined;
  if (input.kind === 'main' && !pendingCard) {
    await input.staticSend(input.text);
    return { presentation: 'static' as const };
  }

  const finalization = pendingCard
    ? await finalizeChannelCardAfterDelivery(
        pendingCard,
        input.text,
        input.prerequisitesAcknowledged ?? true,
        'finalize failed',
      )
    : undefined;
  const fenced =
    finalization?.error && input.scope
      ? await persistUncertainStreamingDelivery({
          scope: { ...input.route, ...input.scope },
          operationKey: `${input.route.provider}-${input.kind}-stream-final`,
          payload: {
            role: 'primary_stream_final',
            contentHash: input.text,
          },
          error: finalization.error,
        })
      : null;
  const handled =
    finalization?.acknowledged === true ||
    (finalization?.error !== undefined &&
      classifyImSendFailure(finalization.error) === 'uncertain');
  if (input.kind === 'main' && !handled) {
    await input.staticSend(input.text);
    return { presentation: 'static' as const, finalization, fenced };
  }
  if (input.kind === 'conversation' && !handled) {
    await input.staticSend(input.text);
    return { presentation: 'static' as const, finalization, fenced };
  }
  return { presentation: 'stream' as const, finalization, fenced };
}

function startRuntime(
  route: Parameters<typeof runHostGate>[0]['route'],
  externalMessageId: string,
) {
  return ChannelTurnRuntime.start({ ...route, externalMessageId });
}

const discordRoute = {
  provider: 'discord',
  accountId: 'discord-bot',
  sourceJid: 'discord:channel:host-gate',
  chatId: 'channel:host-gate',
  rootId: null,
  threadId: null,
};
const qqRoute = {
  provider: 'qq',
  accountId: 'qq-bot',
  sourceJid: 'qq:c2c:host-gate',
  chatId: 'c2c:host-gate',
  rootId: null,
  threadId: null,
};

beforeAll(() => db.initDatabase());
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe.each<HostKind>(['main', 'conversation'])(
  'Discord %s host gate',
  (kind) => {
    test('accepted initial message timeout stays host-owned with one visible mutation', async () => {
      vi.useFakeTimers();
      const ackLoss = Object.assign(
        new Error('Discord create accepted but ACK was lost'),
        { code: 'ETIMEDOUT' },
      );
      const visibleMutations: string[] = [];
      const channel = {
        send: vi.fn(async () => {
          visibleMutations.push('discord-create');
          throw ackLoss;
        }),
      };
      const staticSend = vi.fn(async () => {
        visibleMutations.push('host-static');
      });
      const controller = new DiscordStreamingEditController(channel as any, {
        fallbackSend: staticSend,
      });
      const runtime = startRuntime(
        discordRoute,
        `${kind}-discord-create-ack-loss`,
      );

      controller.append('possibly visible Discord placeholder');
      await vi.advanceTimersByTimeAsync(600);
      expect(controller.isActive()).toBe(true);

      const result = await runHostGate({
        kind,
        controller,
        text: 'final answer',
        staticSend,
        route: discordRoute,
        scope: {
          turnRunId: runtime.runId,
          inputTurnId: runtime.inputTurnId,
          owner: `discord-${kind}-host-test`,
          token: `discord-${kind}-host-token`,
        },
      });

      expect(result).toMatchObject({
        presentation: 'stream',
        finalization: { acknowledged: false, error: ackLoss },
        fenced: { status: 'uncertain' },
      });
      expect(staticSend).not.toHaveBeenCalled();
      expect(visibleMutations).toEqual(['discord-create']);
      expect(
        reliability.getUncertainChannelOutboxForTurn(runtime.runId),
      ).toMatchObject({ status: 'uncertain', kind: 'card' });

      controller.append('late delta');
      controller.setSystemStatus('late status');
      await vi.advanceTimersByTimeAsync(1800);
      await expect(controller.complete('repeat complete')).rejects.toBe(
        ackLoss,
      );
      await expect(controller.abort('repeat abort')).rejects.toBe(ackLoss);
      expect(visibleMutations).toEqual(['discord-create']);

      runtime.interrupt('Discord create ACK is uncertain');
      runtime.dispose();
    });

    test.each([
      [
        'pre-accept',
        () => preAcceptImDeliveryError('Discord send failed before acceptance'),
      ],
      [
        'definitive rejection',
        () =>
          new DefinitiveChannelDeliveryError(
            'Discord provider rejected message create',
          ),
      ],
    ])(
      '%s create failure releases exactly one static send',
      async (_label, failureFactory) => {
        vi.useFakeTimers();
        const failure = failureFactory();
        const visibleMutations: string[] = [];
        const channel = { send: vi.fn(async () => Promise.reject(failure)) };
        const staticSend = vi.fn(async () => {
          visibleMutations.push('host-static');
        });
        const controller = new DiscordStreamingEditController(channel as any, {
          fallbackSend: staticSend,
        });

        controller.append('rejected Discord placeholder');
        await vi.advanceTimersByTimeAsync(600);
        expect(controller.isActive()).toBe(false);

        const result = await runHostGate({
          kind,
          controller,
          text: 'safe static answer',
          staticSend,
          route: discordRoute,
        });
        expect(result).toMatchObject({ presentation: 'static' });
        expect(staticSend).toHaveBeenCalledOnce();
        expect(visibleMutations).toEqual(['host-static']);
        await expect(controller.complete('repeat complete')).rejects.toBe(
          failure,
        );
        await expect(controller.abort('repeat abort')).rejects.toBe(failure);
      },
    );

    test('real Discord HTTP 403 rejection releases exactly one static send', async () => {
      vi.useFakeTimers();
      const rejection = Object.assign(new Error('Missing Access'), {
        status: 403,
        code: 50013,
      });
      const visibleMutations: string[] = [];
      const channel = {
        send: vi.fn(async () => Promise.reject(rejection)),
      };
      const staticSend = vi.fn(async () => {
        visibleMutations.push('host-static');
      });
      const controller = new DiscordStreamingEditController(channel as any, {
        fallbackSend: staticSend,
      });

      controller.append('HTTP rejected Discord placeholder');
      await vi.advanceTimersByTimeAsync(600);
      expect(controller.isActive()).toBe(false);
      const result = await runHostGate({
        kind,
        controller,
        text: 'safe static answer',
        staticSend,
        route: discordRoute,
      });

      expect(result).toMatchObject({ presentation: 'static' });
      expect(staticSend).toHaveBeenCalledOnce();
      expect(visibleMutations).toEqual(['host-static']);
      const completeError = await controller
        .complete('repeat complete')
        .catch((error) => error);
      expect(completeError).toMatchObject({
        deliveryPhase: 'rejected',
        cause: rejection,
      });
      await expect(controller.abort('repeat abort')).rejects.toBe(
        completeError,
      );
    });

    test('Discord HTTP 503 remains uncertain and never sends static', async () => {
      vi.useFakeTimers();
      const unavailable = Object.assign(new Error('Service Unavailable'), {
        status: 503,
      });
      const visibleMutations: string[] = [];
      const channel = {
        send: vi.fn(async () => Promise.reject(unavailable)),
      };
      const staticSend = vi.fn(async () => {
        visibleMutations.push('host-static');
      });
      const controller = new DiscordStreamingEditController(channel as any, {
        fallbackSend: staticSend,
      });
      const runtime = startRuntime(discordRoute, `${kind}-discord-http-503`);

      controller.append('uncertain Discord placeholder');
      await vi.advanceTimersByTimeAsync(600);
      expect(controller.isActive()).toBe(true);
      const result = await runHostGate({
        kind,
        controller,
        text: 'must not send static',
        staticSend,
        route: discordRoute,
        scope: {
          turnRunId: runtime.runId,
          inputTurnId: runtime.inputTurnId,
          owner: `discord-${kind}-503-owner`,
          token: `discord-${kind}-503-token`,
        },
      });

      expect(result).toMatchObject({
        presentation: 'stream',
        finalization: { acknowledged: false, error: unavailable },
        fenced: { status: 'uncertain' },
      });
      expect(staticSend).not.toHaveBeenCalled();
      expect(visibleMutations).toEqual([]);
      runtime.interrupt('Discord HTTP 503 is uncertain');
      runtime.dispose();
    });
  },
);

describe.each<HostKind>(['main', 'conversation'])('QQ %s host gate', (kind) => {
  test('second stream ACK loss stays partial and never opens static delivery', async () => {
    vi.useFakeTimers();
    const tailAckLoss = Object.assign(
      new Error('QQ replacement accepted but ACK was lost'),
      { code: 'ETIMEDOUT' },
    );
    const visibleMutations: string[] = [];
    let calls = 0;
    const sendStreamChunk = vi.fn(async () => {
      calls += 1;
      visibleMutations.push(`qq-stream-${calls}`);
      if (calls === 2) throw tailAckLoss;
      return { id: 'qq-stream-id' };
    });
    const staticSend = vi.fn(async () => {
      visibleMutations.push('host-static');
    });
    const controller = new QQStreamingController({
      openid: 'qq-host-gate',
      msgSeq: 1,
      passiveMsgId: 'qq-inbound',
      sendStreamChunk,
      fallbackSend: staticSend,
    });
    const runtime = startRuntime(qqRoute, `${kind}-qq-tail-ack-loss`);

    controller.append('acknowledged preview');
    await vi.advanceTimersByTimeAsync(600);
    controller.append('uncertain replacement preview');
    await vi.advanceTimersByTimeAsync(600);
    expect(controller.isActive()).toBe(true);

    const result = await runHostGate({
      kind,
      controller,
      text: 'must not create another mutation',
      staticSend,
      route: qqRoute,
      scope: {
        turnRunId: runtime.runId,
        inputTurnId: runtime.inputTurnId,
        owner: `qq-${kind}-host-test`,
        token: `qq-${kind}-host-token`,
      },
    });

    expect(result).toMatchObject({
      presentation: 'stream',
      finalization: {
        acknowledged: false,
        error: {
          code: 'CHANNEL_DELIVERY_PARTIAL',
          deliveredOutputs: 1,
          totalOutputs: 2,
          cause: tailAckLoss,
        },
      },
      fenced: { status: 'uncertain' },
    });
    const stickyError = result.finalization?.error;
    await expect(controller.complete('repeat complete')).rejects.toBe(
      stickyError,
    );
    await expect(controller.abort('repeat abort')).rejects.toBe(stickyError);
    controller.append('late delta');
    await vi.advanceTimersByTimeAsync(600);
    expect(staticSend).not.toHaveBeenCalled();
    expect(visibleMutations).toEqual(['qq-stream-1', 'qq-stream-2']);

    runtime.interrupt('QQ stream tail ACK is uncertain');
    runtime.dispose();
  });

  test.each([
    [
      'pre-accept',
      () => preAcceptImDeliveryError('QQ start failed before acceptance'),
      false,
    ],
    [
      'definitive rejection',
      () => new Error('QQ provider rejected stream start'),
      true,
    ],
  ])(
    '%s start failure releases exactly one static send',
    async (_label, failureFactory, definitive) => {
      vi.useFakeTimers();
      const failure = failureFactory();
      const visibleMutations: string[] = [];
      const staticSend = vi.fn(async () => {
        visibleMutations.push('host-static');
      });
      const controller = new QQStreamingController({
        openid: 'qq-safe-host-gate',
        msgSeq: 1,
        passiveMsgId: 'qq-safe-inbound',
        sendStreamChunk: vi.fn(async () => Promise.reject(failure)),
        fallbackSend: staticSend,
        onDefinitiveRejection: () => definitive,
      });

      controller.append('rejected QQ preview');
      await vi.advanceTimersByTimeAsync(600);
      expect(controller.isActive()).toBe(false);

      const result = await runHostGate({
        kind,
        controller,
        text: 'safe static answer',
        staticSend,
        route: qqRoute,
      });
      expect(result).toMatchObject({ presentation: 'static' });
      expect(staticSend).toHaveBeenCalledOnce();
      expect(visibleMutations).toEqual(['host-static']);
    },
  );
});

describe('fast main finalization fallback', () => {
  test('Discord idle create rejection uses post-finalizer static delivery', async () => {
    const rejection = preAcceptImDeliveryError(
      'Discord create failed before provider acceptance',
    );
    const visibleMutations: string[] = [];
    const channel = { send: vi.fn(async () => Promise.reject(rejection)) };
    const staticSend = vi.fn(async () => {
      visibleMutations.push('host-static');
    });
    const controller = new DiscordStreamingEditController(channel as any, {
      fallbackSend: staticSend,
    });

    expect(controller.isActive()).toBe(true);
    const result = await runHostGate({
      kind: 'main',
      controller,
      text: 'fast Discord final',
      staticSend,
      route: discordRoute,
    });

    expect(result).toMatchObject({
      presentation: 'static',
      finalization: { acknowledged: false, error: rejection },
    });
    expect(staticSend).toHaveBeenCalledOnce();
    expect(visibleMutations).toEqual(['host-static']);
  });

  test('QQ idle start rejection uses post-finalizer static delivery', async () => {
    const rejection = new Error('QQ provider rejected fast stream start');
    const visibleMutations: string[] = [];
    const staticSend = vi.fn(async () => {
      visibleMutations.push('host-static');
    });
    const controller = new QQStreamingController({
      openid: 'qq-fast-main-rejection',
      msgSeq: 1,
      passiveMsgId: 'qq-fast-main-inbound',
      sendStreamChunk: vi.fn(async () => Promise.reject(rejection)),
      fallbackSend: staticSend,
      onDefinitiveRejection: () => true,
    });

    expect(controller.isActive()).toBe(true);
    const result = await runHostGate({
      kind: 'main',
      controller,
      text: 'fast QQ final',
      staticSend,
      route: qqRoute,
    });

    expect(result).toMatchObject({
      presentation: 'static',
      finalization: {
        acknowledged: false,
        error: { deliveryPhase: 'rejected', cause: rejection },
      },
    });
    expect(staticSend).toHaveBeenCalledOnce();
    expect(visibleMutations).toEqual(['host-static']);
  });

  test('uncertain idle create without an Outbox scope still blocks static', async () => {
    const ackLoss = Object.assign(
      new Error('Discord fast create accepted but ACK was lost'),
      { code: 'ETIMEDOUT' },
    );
    const visibleMutations: string[] = [];
    const channel = {
      send: vi.fn(async () => {
        visibleMutations.push('discord-create');
        throw ackLoss;
      }),
    };
    const staticSend = vi.fn(async () => {
      visibleMutations.push('host-static');
    });
    const controller = new DiscordStreamingEditController(channel as any, {
      fallbackSend: staticSend,
    });

    const result = await runHostGate({
      kind: 'main',
      controller,
      text: 'fast uncertain final',
      staticSend,
      route: discordRoute,
    });

    expect(result).toMatchObject({
      presentation: 'stream',
      finalization: { acknowledged: false, error: ackLoss },
    });
    expect(staticSend).not.toHaveBeenCalled();
    expect(visibleMutations).toEqual(['discord-create']);
  });
});

describe('streaming abort prerequisite fence', () => {
  test('QQ successful abort keeps the visible preview as the only presentation', async () => {
    vi.useFakeTimers();
    const visibleMutations: string[] = [];
    const controller = new QQStreamingController({
      openid: 'qq-abort-prereq',
      msgSeq: 1,
      passiveMsgId: 'qq-abort-inbound',
      sendStreamChunk: vi.fn(async (_openid, params) => {
        visibleMutations.push(
          params.input_state === 10 ? 'qq-abort-done' : 'qq-preview',
        );
        return { id: 'qq-abort-stream' };
      }),
      fallbackSend: async () => {},
    });
    const staticSend = vi.fn(async () => {
      visibleMutations.push('host-static');
    });
    const runtime = startRuntime(qqRoute, 'qq-abort-prerequisite');
    controller.append('visible QQ preview');
    await vi.advanceTimersByTimeAsync(600);

    const result = await runHostGate({
      kind: 'conversation',
      controller,
      text: 'unused final',
      prerequisitesAcknowledged: false,
      staticSend,
      route: qqRoute,
      scope: {
        turnRunId: runtime.runId,
        inputTurnId: runtime.inputTurnId,
        owner: 'qq-abort-owner',
        token: 'qq-abort-token',
      },
    });

    expect(result).toMatchObject({
      presentation: 'stream',
      finalization: {
        acknowledged: false,
        error: { code: 'CHANNEL_DELIVERY_PARTIAL' },
      },
      fenced: { status: 'uncertain' },
    });
    expect(staticSend).not.toHaveBeenCalled();
    expect(visibleMutations).toEqual(['qq-preview', 'qq-abort-done']);
    runtime.interrupt('QQ abort prerequisite is partial');
    runtime.dispose();
  });

  test('Discord successful abort keeps the visible message as the only presentation', async () => {
    vi.useFakeTimers();
    const visibleMutations: string[] = [];
    const message = {
      id: 'discord-abort-message',
      edit: vi.fn(async (text: string) => {
        visibleMutations.push(
          text.includes('已中断')
            ? 'discord-abort-edit'
            : 'discord-preview-edit',
        );
        return message;
      }),
    };
    const channel = {
      send: vi.fn(async () => {
        visibleMutations.push('discord-create');
        return message;
      }),
    };
    const staticSend = vi.fn(async () => {
      visibleMutations.push('host-static');
    });
    const controller = new DiscordStreamingEditController(channel as any, {
      fallbackSend: staticSend,
    });
    const runtime = startRuntime(discordRoute, 'discord-abort-prerequisite');
    controller.append('visible Discord preview');
    await vi.advanceTimersByTimeAsync(600);

    const result = await runHostGate({
      kind: 'conversation',
      controller,
      text: 'unused final',
      prerequisitesAcknowledged: false,
      staticSend,
      route: discordRoute,
      scope: {
        turnRunId: runtime.runId,
        inputTurnId: runtime.inputTurnId,
        owner: 'discord-abort-owner',
        token: 'discord-abort-token',
      },
    });

    expect(result).toMatchObject({
      presentation: 'stream',
      finalization: {
        acknowledged: false,
        error: { code: 'CHANNEL_DELIVERY_PARTIAL' },
      },
      fenced: { status: 'uncertain' },
    });
    expect(staticSend).not.toHaveBeenCalled();
    expect(visibleMutations).toEqual([
      'discord-create',
      'discord-preview-edit',
      'discord-abort-edit',
    ]);
    runtime.interrupt('Discord abort prerequisite is partial');
    runtime.dispose();
  });

  test('QQ abort ACK loss is sticky partial and never opens static delivery', async () => {
    vi.useFakeTimers();
    const abortAckLoss = Object.assign(
      new Error('QQ abort DONE accepted but ACK was lost'),
      { code: 'ETIMEDOUT' },
    );
    const visibleMutations: string[] = [];
    let calls = 0;
    const controller = new QQStreamingController({
      openid: 'qq-abort-ack-loss',
      msgSeq: 1,
      passiveMsgId: 'qq-abort-loss-inbound',
      sendStreamChunk: vi.fn(async (_openid, params) => {
        calls += 1;
        visibleMutations.push(
          params.input_state === 10 ? 'qq-abort-done' : 'qq-preview',
        );
        if (calls === 2) throw abortAckLoss;
        return { id: 'qq-abort-loss-stream' };
      }),
      fallbackSend: async () => {},
    });
    const staticSend = vi.fn(async () => {
      visibleMutations.push('host-static');
    });
    const runtime = startRuntime(qqRoute, 'qq-abort-ack-loss');
    controller.append('visible QQ preview');
    await vi.advanceTimersByTimeAsync(600);

    const result = await runHostGate({
      kind: 'conversation',
      controller,
      text: 'unused final',
      prerequisitesAcknowledged: false,
      staticSend,
      route: qqRoute,
      scope: {
        turnRunId: runtime.runId,
        inputTurnId: runtime.inputTurnId,
        owner: 'qq-abort-loss-owner',
        token: 'qq-abort-loss-token',
      },
    });

    expect(result).toMatchObject({
      presentation: 'stream',
      finalization: {
        acknowledged: false,
        error: {
          code: 'CHANNEL_DELIVERY_PARTIAL',
          cause: abortAckLoss,
        },
      },
      fenced: { status: 'uncertain' },
    });
    const stickyError = result.finalization?.error;
    await expect(controller.abort('repeat abort')).rejects.toBe(stickyError);
    await expect(controller.complete('repeat complete')).rejects.toBe(
      stickyError,
    );
    expect(staticSend).not.toHaveBeenCalled();
    expect(visibleMutations).toEqual(['qq-preview', 'qq-abort-done']);
    runtime.interrupt('QQ abort ACK is uncertain');
    runtime.dispose();
  });

  test('Discord abort ACK loss is sticky partial and never opens static delivery', async () => {
    vi.useFakeTimers();
    const abortAckLoss = Object.assign(
      new Error('Discord abort edit accepted but ACK was lost'),
      { code: 'ETIMEDOUT' },
    );
    const visibleMutations: string[] = [];
    let editCalls = 0;
    const message = {
      id: 'discord-abort-ack-loss',
      edit: vi.fn(async (text: string) => {
        editCalls += 1;
        visibleMutations.push(
          text.includes('已中断')
            ? 'discord-abort-edit'
            : 'discord-preview-edit',
        );
        if (editCalls === 2) throw abortAckLoss;
        return message;
      }),
    };
    const channel = {
      send: vi.fn(async () => {
        visibleMutations.push('discord-create');
        return message;
      }),
    };
    const staticSend = vi.fn(async () => {
      visibleMutations.push('host-static');
    });
    const controller = new DiscordStreamingEditController(channel as any, {
      fallbackSend: staticSend,
    });
    const runtime = startRuntime(discordRoute, 'discord-abort-ack-loss');
    controller.append('visible Discord preview');
    await vi.advanceTimersByTimeAsync(600);

    const result = await runHostGate({
      kind: 'conversation',
      controller,
      text: 'unused final',
      prerequisitesAcknowledged: false,
      staticSend,
      route: discordRoute,
      scope: {
        turnRunId: runtime.runId,
        inputTurnId: runtime.inputTurnId,
        owner: 'discord-abort-loss-owner',
        token: 'discord-abort-loss-token',
      },
    });

    expect(result).toMatchObject({
      presentation: 'stream',
      finalization: {
        acknowledged: false,
        error: {
          code: 'CHANNEL_DELIVERY_PARTIAL',
          cause: abortAckLoss,
        },
      },
      fenced: { status: 'uncertain' },
    });
    const stickyError = result.finalization?.error;
    await expect(controller.abort('repeat abort')).rejects.toBe(stickyError);
    await expect(controller.complete('repeat complete')).rejects.toBe(
      stickyError,
    );
    expect(staticSend).not.toHaveBeenCalled();
    expect(visibleMutations).toEqual([
      'discord-create',
      'discord-preview-edit',
      'discord-abort-edit',
    ]);
    runtime.interrupt('Discord abort ACK is uncertain');
    runtime.dispose();
  });
});

describe('Discord terminal-pending mutation fence', () => {
  test.each(['complete', 'abort'] as const)(
    '%s blocks a late append while the terminal edit awaits ACK',
    async (operation) => {
      vi.useFakeTimers();
      const visibleMutations: string[] = [];
      let resolveTerminal!: () => void;
      const terminalPending = new Promise<void>((resolve) => {
        resolveTerminal = resolve;
      });
      let editCalls = 0;
      const message = {
        id: `discord-late-${operation}`,
        edit: vi.fn(async (text: string) => {
          editCalls += 1;
          visibleMutations.push(text);
          if (editCalls === 2) await terminalPending;
          return message;
        }),
      };
      const channel = { send: vi.fn(async () => message) };
      const controller = new DiscordStreamingEditController(channel as any);
      controller.append('PREVIEW');
      await vi.advanceTimersByTimeAsync(600);

      const terminal =
        operation === 'complete'
          ? controller.complete('FINAL')
          : controller.abort('STOP');
      await vi.waitFor(() => expect(message.edit).toHaveBeenCalledTimes(2));
      expect(controller.isActive()).toBe(false);
      controller.append(`LATE AFTER ${operation}`);
      await vi.advanceTimersByTimeAsync(600);
      expect(message.edit).toHaveBeenCalledTimes(2);

      resolveTerminal();
      await terminal;
      expect(message.edit).toHaveBeenCalledTimes(2);
    },
  );

  test('serializes aux and text edits before fencing an ACK-lost mutation', async () => {
    vi.useFakeTimers();
    const ackLoss = Object.assign(
      new Error('Discord aux edit accepted but ACK was lost'),
      { code: 'ETIMEDOUT' },
    );
    let rejectAux!: (error: unknown) => void;
    const auxPending = new Promise<void>((_resolve, reject) => {
      rejectAux = reject;
    });
    const visibleMutations: string[] = [];
    let editCalls = 0;
    const message = {
      id: 'discord-serialized-mutations',
      edit: vi.fn(async (text: string) => {
        editCalls += 1;
        visibleMutations.push(text);
        if (editCalls === 2) await auxPending;
        return message;
      }),
    };
    const channel = { send: vi.fn(async () => message) };
    const controller = new DiscordStreamingEditController(channel as any);
    controller.append('PREVIEW');
    await vi.advanceTimersByTimeAsync(600);

    controller.setSystemStatus('status');
    controller.append('NEXT');
    await vi.advanceTimersByTimeAsync(1800);
    expect(message.edit).toHaveBeenCalledTimes(2);

    rejectAux(ackLoss);
    await vi.waitFor(() => expect(controller.isActive()).toBe(true));
    await vi.advanceTimersByTimeAsync(1800);
    expect(message.edit).toHaveBeenCalledTimes(2);
    const stickyError = await controller.complete('FINAL').catch((e) => e);
    expect(stickyError).toMatchObject({
      code: 'CHANNEL_DELIVERY_PARTIAL',
      cause: ackLoss,
    });
  });
});

describe('QQ terminal-pending mutation fence', () => {
  test.each(['complete', 'abort'] as const)(
    '%s blocks a late append while the DONE chunk awaits ACK',
    async (operation) => {
      vi.useFakeTimers();
      let releaseTerminal!: () => void;
      const terminalPending = new Promise<void>((resolve) => {
        releaseTerminal = resolve;
      });
      let calls = 0;
      const visibleMutations: string[] = [];
      const controller = new QQStreamingController({
        openid: `qq-late-${operation}`,
        msgSeq: 1,
        passiveMsgId: `qq-late-${operation}-inbound`,
        sendStreamChunk: vi.fn(async (_openid, params) => {
          calls += 1;
          visibleMutations.push(
            params.input_state === 10 ? 'qq-terminal-done' : 'qq-preview',
          );
          if (calls === 2) await terminalPending;
          return { id: `qq-late-${operation}-stream` };
        }),
        fallbackSend: async () => {},
      });
      controller.append('PREVIEW');
      await vi.advanceTimersByTimeAsync(600);

      const terminal =
        operation === 'complete'
          ? controller.complete('FINAL')
          : controller.abort('STOP');
      await vi.waitFor(() => expect(visibleMutations).toHaveLength(2));
      expect(controller.isActive()).toBe(false);
      controller.append(`LATE AFTER ${operation}`);
      await vi.advanceTimersByTimeAsync(600);
      expect(visibleMutations).toEqual(['qq-preview', 'qq-terminal-done']);

      releaseTerminal();
      await terminal;
      expect(visibleMutations).toEqual(['qq-preview', 'qq-terminal-done']);
    },
  );
});
