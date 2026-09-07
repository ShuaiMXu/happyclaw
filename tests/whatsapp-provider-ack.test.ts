import { afterEach, describe, expect, test, vi } from 'vitest';

import { WhatsAppProviderAckTracker } from '../src/whatsapp-provider-ack.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('WhatsApp provider ACK boundary', () => {
  test('socket-write success without a server ACK becomes explicitly uncertain', async () => {
    vi.useFakeTimers();
    const tracker = new WhatsAppProviderAckTracker(25);
    tracker.activate(1);
    const socket = {
      sendMessage: vi.fn(async () => ({
        key: { id: 'write-only-1', remoteJid: 'peer', fromMe: true },
      })),
    };

    const send = tracker
      .send(socket as never, 1, 'peer', { text: 'hello' })
      .catch((error) => error);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);

    await expect(send).resolves.toMatchObject({
      deliveryPhase: 'uncertain',
    });
  });

  test('a server rejection is definitive and never reported as delivered', async () => {
    const tracker = new WhatsAppProviderAckTracker(1000);
    tracker.activate(7);
    const socket = {
      sendMessage: vi.fn(async () => ({
        key: { id: 'rejected-1', remoteJid: 'peer', fromMe: true },
      })),
    };

    const send = tracker.send(socket as never, 7, 'peer', { text: 'hello' });
    await vi.waitFor(() => expect(socket.sendMessage).toHaveBeenCalledOnce());
    tracker.recordServerAck(7, 'rejected-1', '479');

    await expect(send).rejects.toMatchObject({
      deliveryPhase: 'rejected',
    });
  });
});
