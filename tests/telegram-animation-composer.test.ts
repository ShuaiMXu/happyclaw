import { Api, Composer, Context } from 'grammy';
import { describe, expect, test } from 'vitest';

import { yieldTelegramAnimationDocument } from '../src/telegram.js';

const botInfo = {
  id: 1,
  is_bot: true,
  first_name: 'HappyClaw',
  username: 'happyclaw_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
} as const;

function contextFor(message: Record<string, unknown>): Context {
  return new Context(
    {
      update_id: Number(message.message_id ?? 1),
      message: {
        date: 1_777_000_000,
        chat: { id: 42, type: 'private' },
        ...message,
      },
    } as never,
    new Api('123456:TEST_TOKEN'),
    botInfo,
  );
}

describe('Telegram animation/document grammY middleware chain', () => {
  test('compatibility document yields to animation exactly once', async () => {
    const composer = new Composer<Context>();
    let documentEntered = 0;
    let documentHandled = 0;
    let animationHandled = 0;

    composer.on('message:document', async (ctx, next) => {
      documentEntered += 1;
      if (await yieldTelegramAnimationDocument(ctx.message, next)) return;
      documentHandled += 1;
    });
    composer.on('message:animation', async () => {
      animationHandled += 1;
    });

    await composer.middleware()(
      contextFor({
        message_id: 7,
        document: { file_id: 'compat-document', file_unique_id: 'doc-1' },
        animation: {
          file_id: 'animation',
          file_unique_id: 'anim-1',
          width: 1,
          height: 1,
          duration: 1,
        },
      }),
      async () => {},
    );

    expect(documentEntered).toBe(1);
    expect(documentHandled).toBe(0);
    expect(animationHandled).toBe(1);
  });

  test('ordinary document remains owned by the document handler', async () => {
    const composer = new Composer<Context>();
    let documentHandled = 0;
    let animationHandled = 0;
    composer.on('message:document', async (ctx, next) => {
      if (await yieldTelegramAnimationDocument(ctx.message, next)) return;
      documentHandled += 1;
    });
    composer.on('message:animation', async () => {
      animationHandled += 1;
    });

    await composer.middleware()(
      contextFor({
        message_id: 8,
        document: { file_id: 'document', file_unique_id: 'doc-2' },
      }),
      async () => {},
    );

    expect(documentHandled).toBe(1);
    expect(animationHandled).toBe(0);
  });
});
