import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { DiscordStreamingEditController } from '../src/discord-streaming-edit.js';
import { QQStreamingController } from '../src/qq-streaming-card.js';
import { WeComStreamingController } from '../src/wecom-streaming.js';
import { finalizeChannelCardAfterDelivery } from '../src/channel-card-finalization.js';
import { preAcceptImDeliveryError } from '../src/im-send-retry-policy.js';
import { DefinitiveChannelDeliveryError } from '../src/channel-outbox-delivery.js';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('streaming finalize must not send a second full copy', () => {
  test('Discord: preview flush + failed final edit does not fallback-send', async () => {
    vi.useFakeTimers();

    const fallbackSend = vi.fn(async () => {});
    const finalizeError = new Error('discord finalize edit failed');
    let editCount = 0;
    const message = {
      id: 'msg-preview',
      edit: vi.fn(async (_content: string) => {
        editCount += 1;
        // First edit is the preview flush; the finalize edit fails.
        if (editCount > 1) throw finalizeError;
        return message;
      }),
    };
    const channel = {
      send: vi.fn(async (_content: string) => message),
    };

    const ctrl = new DiscordStreamingEditController(channel as any, {
      fallbackSend,
    });
    ctrl.append('Hello from the preview');
    await vi.advanceTimersByTimeAsync(600);

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(message.edit).toHaveBeenCalledTimes(1);
    expect(fallbackSend).not.toHaveBeenCalled();

    const finalized = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Hello from the preview — final',
      true,
      'finalize failed',
    );

    expect(finalized).toMatchObject({
      acknowledged: false,
      error: {
        code: 'CHANNEL_DELIVERY_PARTIAL',
        cause: finalizeError,
      },
    });
    const repeated = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Hello from the preview — final',
      true,
      'finalize failed',
    );
    expect(repeated).toMatchObject({
      acknowledged: false,
      error: { code: 'CHANNEL_DELIVERY_PARTIAL' },
    });
    expect(message.edit).toHaveBeenCalledTimes(2);
    expect(fallbackSend).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  test('Discord: visible placeholder plus pre-accept final edit is partial', async () => {
    const fallbackSend = vi.fn(async () => {});
    const message = {
      id: 'msg-placeholder',
      edit: vi.fn(async () => {
        throw preAcceptImDeliveryError('discord finalize edit failed');
      }),
    };
    const channel = {
      send: vi.fn(async (_content: string) => message),
    };

    const ctrl = new DiscordStreamingEditController(channel as any, {
      fallbackSend,
    });
    const finalized = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Only the final text',
      true,
      'finalize failed',
    );

    expect(finalized.acknowledged).toBe(false);
    expect(finalized.error).toMatchObject({
      code: 'CHANNEL_DELIVERY_PARTIAL',
      cause: { deliveryPhase: 'pre_accept' },
    });
    expect(channel.send).toHaveBeenCalledOnce();
    expect(message.edit).toHaveBeenCalledOnce();
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  test('Discord: uncertain first final edit never falls back', async () => {
    const uncertain = new Error('Discord edit ACK lost');
    const fallbackSend = vi.fn(async () => {});
    const message = {
      id: 'msg-placeholder',
      edit: vi.fn(async () => Promise.reject(uncertain)),
    };
    const channel = {
      send: vi.fn(async () => message),
    };
    const ctrl = new DiscordStreamingEditController(channel as any, {
      fallbackSend,
    });

    const first = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Only the final text',
      true,
      'finalize failed',
    );
    const repeated = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Only the final text',
      true,
      'finalize failed',
    );

    expect(first).toMatchObject({
      acknowledged: false,
      error: { code: 'CHANNEL_DELIVERY_PARTIAL', cause: uncertain },
    });
    expect(repeated).toEqual(first);
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  test('Discord: no-preview multi-chunk partial send is fenced without full fallback', async () => {
    const continuationError = new Error('discord continuation failed');
    const fallbackSend = vi.fn(async () => {});
    const message = {
      id: 'msg-placeholder',
      edit: vi.fn(async () => message),
    };
    let sends = 0;
    const channel = {
      send: vi.fn(async () => {
        sends += 1;
        if (sends > 1) throw continuationError;
        return message;
      }),
    };

    const ctrl = new DiscordStreamingEditController(channel as any, {
      fallbackSend,
    });
    const finalized = await finalizeChannelCardAfterDelivery(
      ctrl,
      'x'.repeat(3000),
      true,
      'finalize failed',
    );

    expect(finalized).toMatchObject({
      acknowledged: false,
      error: {
        code: 'CHANNEL_DELIVERY_PARTIAL',
        deliveredOutputs: 1,
        totalOutputs: 2,
        cause: continuationError,
      },
    });
    const repeated = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Hello from the preview — final',
      true,
      'finalize failed',
    );
    expect(repeated).toMatchObject({
      acknowledged: false,
      error: { code: 'CHANNEL_DELIVERY_PARTIAL' },
    });
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(message.edit).toHaveBeenCalledOnce();
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  test('Discord: ACK-lost first final edit stops every continuation send', async () => {
    vi.useFakeTimers();
    const editAckLoss = Object.assign(
      new Error('Discord final edit accepted but ACK was lost'),
      { code: 'ETIMEDOUT' },
    );
    let editCalls = 0;
    const message = {
      id: 'msg-split-ack-loss',
      edit: vi.fn(async () => {
        editCalls += 1;
        if (editCalls === 2) throw editAckLoss;
        return message;
      }),
    };
    const channel = { send: vi.fn(async () => message) };
    const ctrl = new DiscordStreamingEditController(channel as any);
    ctrl.append('PREVIEW');
    await vi.advanceTimersByTimeAsync(600);

    const result = await finalizeChannelCardAfterDelivery(
      ctrl,
      'x'.repeat(2500),
      true,
      'finalize failed',
    );

    expect(result).toMatchObject({
      acknowledged: false,
      error: {
        code: 'CHANNEL_DELIVERY_PARTIAL',
        deliveredOutputs: 1,
        totalOutputs: 2,
        cause: editAckLoss,
      },
    });
    expect(channel.send).toHaveBeenCalledOnce();
    expect(message.edit).toHaveBeenCalledTimes(2);
    const repeated = await finalizeChannelCardAfterDelivery(
      ctrl,
      'x'.repeat(2500),
      true,
      'finalize failed',
    );
    expect(repeated).toEqual(result);
    expect(channel.send).toHaveBeenCalledOnce();
    expect(message.edit).toHaveBeenCalledTimes(2);
  });

  test('QQ: preview flush + failed DONE chunk does not fallback-send', async () => {
    vi.useFakeTimers();

    const fallbackSend = vi.fn(async () => {});
    const streamCalls: Array<{ input_state: number; content_raw: string }> = [];
    const sendStreamChunk = vi.fn(async (_openid: string, params: any) => {
      streamCalls.push({
        input_state: params.input_state,
        content_raw: params.content_raw,
      });
      if (params.input_state === 10) {
        throw new Error('qq finalize DONE failed');
      }
      return { id: 'stream-msg-1' };
    });

    const ctrl = new QQStreamingController({
      openid: 'user-openid',
      msgSeq: 1,
      sendStreamChunk,
      fallbackSend,
      passiveMsgId: 'passive-1',
    });
    ctrl.append('Hello from the preview');
    await vi.advanceTimersByTimeAsync(600);

    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0].input_state).toBe(1);
    expect(fallbackSend).not.toHaveBeenCalled();

    await expect(
      ctrl.complete('Hello from the preview — final'),
    ).rejects.toMatchObject({
      code: 'CHANNEL_DELIVERY_PARTIAL',
      cause: expect.objectContaining({ message: 'qq finalize DONE failed' }),
    });

    expect(streamCalls.some((c) => c.input_state === 10)).toBe(true);
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  test('WeCom: preview flush + failed DONE stream does not fallback-send', async () => {
    vi.useFakeTimers();

    const fallbackSend = vi.fn(async () => {});
    const finalizeError = new Error('wecom finalize DONE failed');
    const streamCalls: Array<{ content: string; finish: boolean }> = [];
    const sendStream = vi.fn(async (content: string, finish: boolean) => {
      streamCalls.push({ content, finish });
      if (finish) throw finalizeError;
    });

    const ctrl = new WeComStreamingController({
      chatId: 'chat-1',
      sendStream,
      fallbackSend,
    });
    ctrl.append('Hello from the preview');
    await vi.advanceTimersByTimeAsync(800);

    expect(streamCalls).toEqual([
      { content: 'Hello from the preview', finish: false },
    ]);
    expect(fallbackSend).not.toHaveBeenCalled();

    const finalized = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Hello from the preview — final',
      true,
      'finalize failed',
    );

    expect(finalized).toMatchObject({
      acknowledged: false,
      error: {
        code: 'CHANNEL_DELIVERY_PARTIAL',
        cause: finalizeError,
      },
    });
    const repeated = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Hello from the preview — final',
      true,
      'finalize failed',
    );
    expect(repeated).toMatchObject({
      acknowledged: false,
      error: { code: 'CHANNEL_DELIVERY_PARTIAL' },
    });
    expect(streamCalls).toContainEqual({
      content: 'Hello from the preview — final',
      finish: true,
    });
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  test('WeCom: pre-accept first DONE delegates static fallback to the host', async () => {
    const fallbackSend = vi.fn(async () => {});
    const sendStream = vi.fn(async () => {
      throw preAcceptImDeliveryError('wecom finalize DONE failed');
    });

    const ctrl = new WeComStreamingController({
      chatId: 'chat-1',
      sendStream,
      fallbackSend,
    });
    const finalized = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Only the final text',
      true,
      'finalize failed',
    );

    expect(finalized.acknowledged).toBe(false);
    expect(finalized.error).toMatchObject({ deliveryPhase: 'pre_accept' });
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  test('WeCom: uncertain first DONE never falls back and remains unacknowledged', async () => {
    const uncertain = new Error('WeCom DONE ACK was lost');
    const fallbackSend = vi.fn(async () => {});
    const ctrl = new WeComStreamingController({
      chatId: 'chat-1',
      sendStream: vi.fn(async () => Promise.reject(uncertain)),
      fallbackSend,
    });

    const first = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Only the final text',
      true,
      'finalize failed',
    );
    const repeated = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Only the final text',
      true,
      'finalize failed',
    );

    expect(first).toEqual({ acknowledged: false, error: uncertain });
    expect(repeated).toEqual({ acknowledged: false, error: uncertain });
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  test('WeCom: oversized final close failure fences the preview before pagination', async () => {
    vi.useFakeTimers();
    try {
      const closeError = new Error('WeCom oversized close ACK lost');
      let calls = 0;
      const sendStream = vi.fn(async () => {
        calls += 1;
        if (calls > 1) throw closeError;
      });
      const fallbackSend = vi.fn(async () => {});
      const ctrl = new WeComStreamingController({
        chatId: 'chat-1',
        sendStream,
        fallbackSend,
      });

      ctrl.append('visible preview');
      await vi.advanceTimersByTimeAsync(800);
      const finalized = await finalizeChannelCardAfterDelivery(
        ctrl,
        'x'.repeat(21_000),
        true,
        'finalize failed',
      );

      expect(finalized).toMatchObject({
        acknowledged: false,
        error: {
          code: 'CHANNEL_DELIVERY_PARTIAL',
          cause: closeError,
        },
      });
      expect(sendStream).toHaveBeenCalledTimes(2);
      expect(fallbackSend).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('WeCom: preview plus failed abort DONE is sticky partial and never sends a third fallback', async () => {
    vi.useFakeTimers();
    const fallbackSend = vi.fn(async () => {});
    const abortError = new Error('WeCom abort DONE ACK was lost');
    const streamCalls: Array<{ content: string; finish: boolean }> = [];
    const sendStream = vi.fn(async (content: string, finish: boolean) => {
      streamCalls.push({ content, finish });
      if (finish) throw abortError;
    });
    const ctrl = new WeComStreamingController({
      chatId: 'chat-abort-preview',
      sendStream,
      fallbackSend,
    });

    ctrl.append('visible preview');
    await vi.advanceTimersByTimeAsync(800);
    const first = await finalizeChannelCardAfterDelivery(
      ctrl,
      'unused final',
      false,
      'attachment failed',
    );
    const repeated = await finalizeChannelCardAfterDelivery(
      ctrl,
      'unused final',
      false,
      'attachment failed',
    );

    expect(first).toMatchObject({
      acknowledged: false,
      error: {
        code: 'CHANNEL_DELIVERY_PARTIAL',
        deliveredOutputs: 1,
        totalOutputs: 2,
        cause: abortError,
      },
    });
    expect(repeated).toEqual(first);
    expect(streamCalls).toEqual([
      { content: 'visible preview', finish: false },
      {
        content: 'visible preview\n\n⚠️ 已中断: attachment failed',
        finish: true,
      },
    ]);
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  test('WeCom: successful abort of an existing preview still fences static fallback', async () => {
    vi.useFakeTimers();
    const fallbackSend = vi.fn(async () => {});
    const sendStream = vi.fn(async () => {});
    const ctrl = new WeComStreamingController({
      chatId: 'chat-abort-ack',
      sendStream,
      fallbackSend,
    });

    ctrl.append('visible preview');
    await vi.advanceTimersByTimeAsync(800);
    const result = await finalizeChannelCardAfterDelivery(
      ctrl,
      'unused final',
      false,
      'attachment failed',
    );

    expect(result).toMatchObject({
      acknowledged: false,
      error: {
        code: 'CHANNEL_DELIVERY_PARTIAL',
        deliveredOutputs: 2,
        totalOutputs: 3,
      },
    });
    expect(sendStream).toHaveBeenCalledTimes(2);
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  test('WeCom: preview update ACK loss becomes sticky before complete can send DONE', async () => {
    vi.useFakeTimers();
    const fallbackSend = vi.fn(async () => {});
    const previewError = new Error('WeCom preview update ACK was lost');
    let calls = 0;
    const sendStream = vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw previewError;
    });
    const ctrl = new WeComStreamingController({
      chatId: 'chat-preview-update',
      sendStream,
      fallbackSend,
    });

    ctrl.append('first acknowledged preview');
    await vi.advanceTimersByTimeAsync(800);
    ctrl.append('second uncertain preview');
    await vi.advanceTimersByTimeAsync(800);
    const first = await finalizeChannelCardAfterDelivery(
      ctrl,
      'final answer must not create a third mutation',
      true,
      'finalize failed',
    );
    const repeated = await finalizeChannelCardAfterDelivery(
      ctrl,
      'final answer must not create a third mutation',
      true,
      'finalize failed',
    );

    expect(first).toMatchObject({
      acknowledged: false,
      error: {
        code: 'CHANNEL_DELIVERY_PARTIAL',
        deliveredOutputs: 1,
        totalOutputs: 2,
        cause: previewError,
      },
    });
    expect(repeated).toEqual(first);
    expect(sendStream).toHaveBeenCalledTimes(2);
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  test('WeCom: first preview ACK loss blocks both DONE and static fallback', async () => {
    vi.useFakeTimers();
    const fallbackSend = vi.fn(async () => {});
    const previewError = new Error('WeCom first preview ACK was lost');
    const sendStream = vi.fn(async () => Promise.reject(previewError));
    const ctrl = new WeComStreamingController({
      chatId: 'chat-first-preview',
      sendStream,
      fallbackSend,
    });

    ctrl.append('possibly visible preview');
    await vi.advanceTimersByTimeAsync(800);
    const result = await finalizeChannelCardAfterDelivery(
      ctrl,
      'must not send DONE',
      true,
      'finalize failed',
    );

    expect(result).toEqual({ acknowledged: false, error: previewError });
    expect(sendStream).toHaveBeenCalledOnce();
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  test('WeCom: zero-output abort performs no provider mutation and leaves fallback to the host', async () => {
    const fallbackSend = vi.fn(async () => {});
    const sendStream = vi.fn(async () => {});
    const ctrl = new WeComStreamingController({
      chatId: 'chat-abort-empty',
      sendStream,
      fallbackSend,
    });

    const result = await finalizeChannelCardAfterDelivery(
      ctrl,
      'unused final',
      false,
      'attachment failed',
    );

    expect(result).toEqual({ acknowledged: false });
    expect(sendStream).not.toHaveBeenCalled();
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  test.each([
    [
      'pre-accept',
      preAcceptImDeliveryError('WeCom stream rejected before provider send'),
    ],
    [
      'definitive rejection',
      new DefinitiveChannelDeliveryError('WeCom provider rejected DONE'),
    ],
  ])(
    'WeCom: zero-output %s remains authoritative for host fallback',
    async (_label, failure) => {
      const fallbackSend = vi.fn(async () => {});
      const ctrl = new WeComStreamingController({
        chatId: 'chat-zero-rejected',
        sendStream: vi.fn(async () => Promise.reject(failure)),
        fallbackSend,
      });

      const result = await finalizeChannelCardAfterDelivery(
        ctrl,
        'final text',
        true,
        'finalize failed',
      );

      expect(result).toEqual({ acknowledged: false, error: failure });
      expect(fallbackSend).not.toHaveBeenCalled();
    },
  );
});
