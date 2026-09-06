import fs from 'node:fs';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { IMChannelConnectOpts } from '../src/im-channel.js';
import type { TelegramConnectOpts } from '../src/telegram.js';

const capture = vi.hoisted(() => ({
  telegramLoads: 0,
  qqLoads: 0,
  telegramOpts: null as TelegramConnectOpts | null,
  telegramConnected: false,
}));

vi.mock('../src/telegram.js', () => {
  capture.telegramLoads += 1;
  return {
    createTelegramConnection: () => ({
      async connect(opts: TelegramConnectOpts) {
        capture.telegramOpts = opts;
        capture.telegramConnected = true;
        opts.onReady?.();
      },
      async disconnect() {
        capture.telegramConnected = false;
      },
      async sendMessage() {},
      async sendImage() {},
      async sendFile() {},
      async sendChatAction() {},
      async clearAckReaction() {},
      isConnected: () => capture.telegramConnected,
    }),
  };
});

vi.mock('../src/qq.js', () => {
  capture.qqLoads += 1;
  return {
    createQQConnection: () => ({
      async connect() {},
      async disconnect() {},
      async sendMessage() {},
      async sendImage() {},
      async sendFile() {},
      async sendTyping() {},
      isConnected: () => true,
    }),
  };
});

const { createQQChannel, createTelegramChannel } =
  await import('../src/im-channel.js');
const { IMConnectionManager } = await import('../src/im-manager.js');
const { loadChannelImplementation, setChannelImplementationLoaderForTest } =
  await import('../src/channel-registry.js');

describe('lazy channel implementation registry', () => {
  beforeEach(() => {
    capture.telegramOpts = null;
    capture.telegramConnected = false;
  });

  test('loads only the provider that actually connects', async () => {
    const telegram = createTelegramChannel({ botToken: 'token' });
    createQQChannel({ appId: 'app', appSecret: 'secret' });

    expect(capture.telegramLoads).toBe(0);
    expect(capture.qqLoads).toBe(0);

    await expect(
      telegram.connect({ onReady: vi.fn(), onNewChat: vi.fn() }),
    ).resolves.toBe(true);

    expect(capture.telegramLoads).toBe(1);
    expect(capture.qqLoads).toBe(0);
    await telegram.disconnect();
  });

  test('coalesces concurrent loads of the same provider', async () => {
    const implementation = {
      createQQConnection: vi.fn(),
    } as unknown as typeof import('../src/qq.js');
    const loader = vi.fn(async () => implementation);
    const restore = setChannelImplementationLoaderForTest('qq', loader);
    try {
      const [left, right] = await Promise.all([
        loadChannelImplementation('qq'),
        loadChannelImplementation('qq'),
      ]);
      expect(left).toBe(implementation);
      expect(right).toBe(implementation);
      expect(loader).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });

  test('projects committed Telegram messages through an injected host callback', async () => {
    const manager = new IMConnectionManager();
    const onMessagePersisted =
      vi.fn<NonNullable<IMChannelConnectOpts['onMessagePersisted']>>();

    await expect(
      manager.connectUserTelegram(
        'owner',
        { botToken: 'token' },
        vi.fn(),
        vi.fn(() => true),
        undefined,
        { onMessagePersisted },
      ),
    ).resolves.toBe(true);

    const message = {
      id: 'message-1',
      chat_jid: 'web:main',
      source_jid: 'telegram:chat',
      sender: 'tg:1',
      sender_name: 'Owner',
      content: 'hello',
      timestamp: '2026-08-21T00:00:00.000Z',
      is_from_me: false,
    };
    capture.telegramOpts?.onMessagePersisted?.('web:main', message, 'agent-1');

    expect(onMessagePersisted).toHaveBeenCalledWith(
      'web:main',
      message,
      'agent-1',
    );
    await manager.disconnectAll();
  });

  test('channel connectors project through host services, never the Web gateway', () => {
    const connectorNames = [
      'feishu',
      'telegram',
      'qq',
      'wechat',
      'wecom',
      'dingtalk',
      'discord',
      'whatsapp',
    ];
    for (const connectorName of connectorNames) {
      const source = fs.readFileSync(
        new URL(`../src/${connectorName}.ts`, import.meta.url),
        'utf8',
      );
      expect(source, connectorName).not.toContain("from './web.js'");
      expect(source, connectorName).toContain('onMessagePersisted?.(');
    }

    const feishuSource = fs.readFileSync(
      new URL('../src/feishu.ts', import.meta.url),
      'utf8',
    );
    expect(feishuSource).toContain('onFollowUpsChanged?.(targetJid)');
  });

  test('route modules project through WebDeps without reverse imports', () => {
    for (const route of ['groups', 'agents']) {
      const source = fs.readFileSync(
        new URL(`../src/routes/${route}.ts`, import.meta.url),
        'utf8',
      );
      expect(source, route).not.toMatch(
        /(?:from\s+['"]\.\.\/web\.js['"]|import\(['"]\.\.\/web\.js['"]\))/,
      );
    }
  });

  test('the server entrypoint does not eagerly import provider implementations', () => {
    const entrypoint = fs.readFileSync(
      new URL('../src/index.ts', import.meta.url),
      'utf8',
    );
    expect(entrypoint).not.toMatch(
      /from ['"]\.\/(?:feishu|telegram|qq|wechat|wecom|dingtalk|discord|whatsapp)\.js['"]/,
    );
    const connectivity = fs.readFileSync(
      new URL('../src/channel-account-connectivity.ts', import.meta.url),
      'utf8',
    );
    expect(connectivity).not.toMatch(
      /from ['"]\.\/(?:feishu|telegram|qq|wechat|wecom|dingtalk|discord|whatsapp)\.js['"]/,
    );
  });
});
