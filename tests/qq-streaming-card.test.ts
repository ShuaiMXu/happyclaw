import { describe, expect, test, vi } from 'vitest';

import { QQStreamingController } from '../src/qq-streaming-card.js';
import { finalizeChannelCardAfterDelivery } from '../src/channel-card-finalization.js';

describe('QQ streaming passive rejection fallback', () => {
  test('definitive start rejection delegates static fallback to the durable host', async () => {
    const rejection = new Error('provider rejected msg_id');
    const fallback = vi.fn(async () => {});
    const controller = new QQStreamingController({
      openid: 'user',
      msgSeq: 2,
      passiveMsgId: 'message',
      sendStreamChunk: vi.fn(async () => {
        throw rejection;
      }),
      fallbackSend: fallback,
      onDefinitiveRejection: (error) => error === rejection,
    });

    controller.append('partial');
    const finalized = await finalizeChannelCardAfterDelivery(
      controller,
      'partial and final',
      true,
      'delivery failed',
    );

    expect(finalized).toMatchObject({
      acknowledged: false,
      error: { deliveryPhase: 'rejected', cause: rejection },
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  test('uncertain start never falls back or reuses the sequence', async () => {
    const timeout = new Error('socket timed out after write');
    const send = vi.fn(async () => {
      throw timeout;
    });
    const fallback = vi.fn(async () => {});
    const controller = new QQStreamingController({
      openid: 'user',
      msgSeq: 2,
      passiveMsgId: 'message',
      sendStreamChunk: send,
      fallbackSend: fallback,
      onDefinitiveRejection: () => false,
    });

    controller.append('partial');
    const first = await finalizeChannelCardAfterDelivery(
      controller,
      'partial and final',
      true,
      'delivery failed',
    );
    const repeated = await finalizeChannelCardAfterDelivery(
      controller,
      'partial and final',
      true,
      'delivery failed',
    );
    expect(first).toEqual({ acknowledged: false, error: timeout });
    expect(repeated).toEqual({ acknowledged: false, error: timeout });
    expect(send).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });

  test('definitive rejection remains sticky and never invokes controller fallback', async () => {
    const rejection = new Error('verified expired reference');
    const fallback = vi.fn(async () => {
      throw new Error('controller fallback must not run');
    });
    const controller = new QQStreamingController({
      openid: 'user',
      msgSeq: 1,
      passiveMsgId: 'message',
      sendStreamChunk: vi.fn(async () => {
        throw rejection;
      }),
      fallbackSend: fallback,
      onDefinitiveRejection: (error) => error === rejection,
    });
    controller.append('partial');

    const finalized = await finalizeChannelCardAfterDelivery(
      controller,
      'complete answer',
      true,
      'delivery failed',
    );

    expect(finalized).toMatchObject({
      acknowledged: false,
      error: { deliveryPhase: 'rejected', cause: rejection },
    });
    const repeated = await finalizeChannelCardAfterDelivery(
      controller,
      'complete answer',
      true,
      'delivery failed',
    );
    expect(repeated).toMatchObject({
      acknowledged: false,
      error: { deliveryPhase: 'rejected', cause: rejection },
    });
    expect(fallback).not.toHaveBeenCalled();
    expect(controller.isActive()).toBe(false);
  });

  test('visible stream overflow is fenced instead of sending a plain duplicate', async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(async () => ({ id: 'stream-visible' }));
      const fallback = vi.fn(async () => {});
      const controller = new QQStreamingController({
        openid: 'user',
        msgSeq: 1,
        passiveMsgId: 'message',
        sendStreamChunk: send,
        fallbackSend: fallback,
      });

      controller.append('x'.repeat(1000));
      await vi.advanceTimersByTimeAsync(600);
      controller.append('x'.repeat(4600));
      await vi.advanceTimersByTimeAsync(600);

      const finalized = await finalizeChannelCardAfterDelivery(
        controller,
        'x'.repeat(4600),
        true,
        'delivery failed',
      );

      expect(finalized.acknowledged).toBe(false);
      expect(finalized.error).toMatchObject({
        code: 'CHANNEL_DELIVERY_PARTIAL',
        deliveredOutputs: 1,
      });
      expect(send).toHaveBeenCalledOnce();
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('initial overflow delegates one durable static send to the host', async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(async () => ({ id: 'must-not-start' }));
      const fallback = vi.fn(async () => {});
      const controller = new QQStreamingController({
        openid: 'user',
        msgSeq: 1,
        passiveMsgId: 'message',
        sendStreamChunk: send,
        fallbackSend: fallback,
      });

      controller.append('x'.repeat(4600));
      await vi.advanceTimersByTimeAsync(600);
      const first = await finalizeChannelCardAfterDelivery(
        controller,
        'x'.repeat(4600),
        true,
        'delivery failed',
      );
      const repeated = await finalizeChannelCardAfterDelivery(
        controller,
        'x'.repeat(4600),
        true,
        'delivery failed',
      );

      expect(first).toMatchObject({
        acknowledged: false,
        error: { deliveryPhase: 'pre_accept' },
      });
      expect(repeated).toMatchObject({
        acknowledged: false,
        error: { deliveryPhase: 'pre_accept' },
      });
      expect(send).not.toHaveBeenCalled();
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('visible stream DONE rejection is partial-visible and never falls back', async () => {
    vi.useFakeTimers();
    try {
      const rejection = Object.assign(new Error('QQ rejected DONE'), {
        httpStatus: 403,
      });
      let calls = 0;
      const send = vi.fn(async () => {
        calls += 1;
        if (calls > 1) throw rejection;
        return { id: 'stream-visible' };
      });
      const fallback = vi.fn(async () => {});
      const controller = new QQStreamingController({
        openid: 'user',
        msgSeq: 1,
        passiveMsgId: 'message',
        sendStreamChunk: send,
        fallbackSend: fallback,
        onDefinitiveRejection: () => true,
      });

      controller.append('visible preview');
      await vi.advanceTimersByTimeAsync(600);
      const finalized = await finalizeChannelCardAfterDelivery(
        controller,
        'visible preview and final',
        true,
        'delivery failed',
      );

      expect(finalized.acknowledged).toBe(false);
      expect(finalized.error).toMatchObject({
        code: 'CHANNEL_DELIVERY_PARTIAL',
        cause: rejection,
      });
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
