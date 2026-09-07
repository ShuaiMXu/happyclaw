import { describe, expect, test, vi } from 'vitest';

import type { IMChannel } from '../src/im-channel.js';

const route = vi.hoisted(() => ({
  jid: 'wecom:c2c:user-1#account:wecom-a',
  owner: 'owner-1',
  accountId: 'wecom-a',
}));

vi.mock('../src/db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db.js')>()),
  getRegisteredGroup: () => ({
    jid: route.jid,
    created_by: route.owner,
    channel_account_id: route.accountId,
  }),
  isDatabaseInitialized: () => false,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { IMConnectionManager } = await import('../src/im-manager.js');

describe('IMConnectionManager WeCom public media routing', () => {
  test('sendImage and sendFile use the connected WeCom provider methods', async () => {
    const sendImage = vi.fn(async () => undefined);
    const sendFile = vi.fn(async () => undefined);
    const channel: IMChannel = {
      channelType: 'wecom',
      connect: vi.fn(async () => true),
      disconnect: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
      sendImage,
      sendFile,
      setTyping: vi.fn(async () => undefined),
      isConnected: () => true,
    };
    const manager = new IMConnectionManager();
    const internals = manager as unknown as {
      connections: Map<
        string,
        { userId: string; channels: Map<string, IMChannel> }
      >;
    };
    internals.connections.set(route.owner, {
      userId: route.owner,
      channels: new Map([[`wecom\0${route.accountId}`, channel]]),
    });

    const image = Buffer.from('image');
    await manager.sendImage(
      route.jid,
      image,
      'image/png',
      'caption',
      'photo.png',
    );
    await manager.sendFile(route.jid, '/tmp/report.bin', 'report.bin');

    expect(sendImage).toHaveBeenCalledWith(
      'c2c:user-1',
      image,
      'image/png',
      'caption',
      'photo.png',
    );
    expect(sendFile).toHaveBeenCalledWith(
      'c2c:user-1',
      '/tmp/report.bin',
      'report.bin',
    );
  });
});
