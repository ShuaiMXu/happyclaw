import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { preAcceptImDeliveryError } from '../src/im-send-retry-policy.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'im-channel-images-'));
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const first = path.join(root, 'first.png');
const second = path.join(root, 'second.png');
fs.writeFileSync(first, png);
fs.writeFileSync(second, png);

const fakes = vi.hoisted(() => {
  const make = (provider: 'wechat' | 'wecom' | 'dingtalk') => ({
    provider,
    connect: vi.fn(async () => (provider === 'dingtalk' ? true : undefined)),
    disconnect: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    sendImage: vi.fn(async () => undefined),
    sendFile: vi.fn(async () => undefined),
    sendTyping: vi.fn(async () => undefined),
    sendReaction: vi.fn(async () => undefined),
    clearAckReaction: vi.fn(async () => undefined),
    createStreamingSession: vi.fn(async () => undefined),
    isRunning: () => true,
    isConnected: () => true,
    getUpdatesBuf: () => '',
  });
  return {
    wechat: make('wechat'),
    wecom: make('wecom'),
    dingtalk: make('dingtalk'),
  };
});

vi.mock('../src/channel-registry.js', () => ({
  loadChannelImplementation: vi.fn(async (provider: string) => {
    if (provider === 'wechat') {
      return { createWeChatConnection: () => fakes.wechat };
    }
    if (provider === 'wecom') {
      return { createWeComConnection: () => fakes.wecom };
    }
    if (provider === 'dingtalk') {
      return { createDingTalkConnection: () => fakes.dingtalk };
    }
    throw new Error(`unexpected provider ${provider}`);
  }),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createDingTalkChannel, createWeChatChannel, createWeComChannel } =
  await import('../src/im-channel.js');

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  for (const fake of Object.values(fakes)) {
    vi.clearAllMocks();
    fake.sendMessage.mockResolvedValue(undefined);
    fake.sendImage.mockResolvedValue(undefined);
  }
});

const connectOpts = {
  onReady: vi.fn(),
  onNewChat: vi.fn(),
  isChatAuthorized: () => true,
};

describe('channel adapters preserve local image attachments', () => {
  test.each([
    {
      name: 'WeChat',
      create: () =>
        createWeChatChannel({ botToken: 'token', ilinkBotId: 'bot' }),
      fake: fakes.wechat,
    },
    {
      name: 'WeCom',
      create: () => createWeComChannel({ botId: 'bot', secret: 'secret' }),
      fake: fakes.wecom,
    },
    {
      name: 'DingTalk',
      create: () =>
        createDingTalkChannel({ clientId: 'client', clientSecret: 'secret' }),
      fake: fakes.dingtalk,
    },
  ])('$name sends text plus every image', async ({ create, fake }) => {
    const channel = create();
    await expect(channel.connect(connectOpts)).resolves.toBe(true);
    await channel.sendMessage('chat-1', 'body', [first, second], {
      deliveryId: 'adapter-delivery',
      chunkIndex: 3,
    });
    expect(fake.sendMessage).toHaveBeenCalledOnce();
    expect(fake.sendMessage.mock.calls[0]?.[2]).toEqual([]);
    expect(fake.sendImage).toHaveBeenCalledTimes(2);
    expect(fake.sendImage.mock.calls.map((call) => call[4])).toEqual([
      'first.png',
      'second.png',
    ]);
  });

  test.each([
    {
      name: 'WeChat',
      create: () =>
        createWeChatChannel({ botToken: 'token', ilinkBotId: 'bot' }),
      fake: fakes.wechat,
    },
    {
      name: 'WeCom',
      create: () => createWeComChannel({ botId: 'bot', secret: 'secret' }),
      fake: fakes.wecom,
    },
    {
      name: 'DingTalk',
      create: () =>
        createDingTalkChannel({ clientId: 'client', clientSecret: 'secret' }),
      fake: fakes.dingtalk,
    },
  ])(
    '$name reports a second-image tail rejection as partial',
    async ({ create, fake }) => {
      fake.sendImage
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(preAcceptImDeliveryError('tail rejected'));
      const channel = create();
      await channel.connect(connectOpts);
      await expect(
        channel.sendMessage('chat-1', 'body', [first, second]),
      ).rejects.toMatchObject({
        code: 'CHANNEL_DELIVERY_PARTIAL',
        deliveredOutputs: 2,
        totalOutputs: 3,
      });
      expect(fake.sendMessage).toHaveBeenCalledOnce();
      expect(fake.sendImage).toHaveBeenCalledTimes(2);
    },
  );

  test.each([
    {
      name: 'WeCom',
      create: () => createWeComChannel({ botId: 'bot', secret: 'secret' }),
      fake: fakes.wecom,
    },
    {
      name: 'DingTalk',
      create: () =>
        createDingTalkChannel({ clientId: 'client', clientSecret: 'secret' }),
      fake: fakes.dingtalk,
    },
  ])(
    '$name rejects a multi-output durable row before provider send',
    async ({ create, fake }) => {
      const channel = create();
      await channel.connect(connectOpts);
      await expect(
        channel.sendMessage('chat-1', 'body', [first], {
          deliveryId: 'one-row',
          physicalOutput: true,
        }),
      ).rejects.toMatchObject({ deliveryPhase: 'pre_accept' });
      await expect(
        channel.sendImage('chat-1', png, 'image/png', 'caption', 'photo.png', {
          deliveryId: 'one-image-row',
          physicalOutput: true,
        }),
      ).rejects.toMatchObject({ deliveryPhase: 'pre_accept' });
      expect(fake.sendMessage).not.toHaveBeenCalled();
      expect(fake.sendImage).not.toHaveBeenCalled();
    },
  );
});
