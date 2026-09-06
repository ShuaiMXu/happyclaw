import { describe, expect, test, vi } from 'vitest';

import {
  PartialChannelDeliveryError,
  PhysicalDeliveryTracker,
} from '../src/im-delivery-progress.js';
import { retryUnscopedImSend } from '../src/im-send-retry-policy.js';

describe('PhysicalDeliveryTracker', () => {
  test('preserves the original error before any provider ACK', async () => {
    const failure = new Error('connect failed before accept');
    const tracker = new PhysicalDeliveryTracker(2);

    await expect(
      tracker.send(async () => Promise.reject(failure)),
    ).rejects.toBe(failure);
  });

  test('fences an acknowledged prefix when a later mutation fails', async () => {
    const tail = new Error('second chunk failed before accept');
    const first = vi.fn(async () => {});
    const tracker = new PhysicalDeliveryTracker(2);

    await tracker.send(first);
    let failure: unknown;
    try {
      await tracker.send(async () => Promise.reject(tail));
    } catch (error) {
      failure = error;
    }

    expect(first).toHaveBeenCalledOnce();
    expect(failure).toBeInstanceOf(PartialChannelDeliveryError);
    expect(failure).toMatchObject({
      code: 'CHANNEL_DELIVERY_PARTIAL',
      outcome: 'uncertain',
      deliveredOutputs: 1,
      totalOutputs: 2,
      cause: tail,
    });
  });

  test('prevents the host retry loop from resending an acknowledged prefix', async () => {
    let connectorAttempts = 0;
    let visibleFirstChunks = 0;
    const tail = Object.assign(new Error('second chunk DNS failure'), {
      code: 'ENOTFOUND',
    });

    const result = await retryUnscopedImSend(
      async () => {
        connectorAttempts += 1;
        const tracker = new PhysicalDeliveryTracker(2);
        await tracker.send(async () => {
          visibleFirstChunks += 1;
        });
        await tracker.send(async () => Promise.reject(tail));
      },
      { sleep: async () => {} },
    );

    expect(result).toMatchObject({ ok: false, outcome: 'uncertain' });
    expect(connectorAttempts).toBe(1);
    expect(visibleFirstChunks).toBe(1);
  });
});
