import { describe, expect, test } from 'vitest';
import {
  resolveFeishuConversationPlan,
  type FeishuConversationPolicyInput,
} from '../src/feishu-conversation-policy.js';

const base: FeishuConversationPolicyInput = {
  chatType: 'group',
  chatMode: 'group',
  activationMode: 'always',
  mentionedBot: false,
  messageId: 'om_message',
};

function plan(overrides: Partial<FeishuConversationPolicyInput> = {}) {
  return resolveFeishuConversationPlan({ ...base, ...overrides });
}

describe('Feishu conversation policy', () => {
  test('private chats always share one context without mention semantics', () => {
    expect(
      plan({
        chatType: 'p2p',
        chatMode: 'p2p',
        activationMode: 'when_mentioned',
      }),
    ).toMatchObject({
      disabled: false,
      allowWithoutMention: true,
      independentContext: false,
      reason: 'direct',
    });
  });

  test('disabled is a hard stop for direct and group chats', () => {
    expect(plan({ chatType: 'p2p', activationMode: 'disabled' })).toMatchObject(
      { disabled: true, reason: 'disabled' },
    );
    expect(
      plan({ activationMode: 'disabled', mentionedBot: true }),
    ).toMatchObject({ disabled: true, reason: 'disabled' });
  });

  test('ordinary always-on groups keep thread replies in the shared context', () => {
    expect(
      plan({ threadId: 'omt_manual', rootId: 'om_manual_root' }),
    ).toMatchObject({
      allowWithoutMention: true,
      independentContext: false,
      reason: 'shared_chat',
    });
  });

  test('ordinary mention mode rejects an unmentioned main-timeline message', () => {
    expect(
      plan({ activationMode: 'when_mentioned', mentionedBot: false }),
    ).toMatchObject({
      allowWithoutMention: false,
      independentContext: false,
      reason: 'mention_required',
    });
  });

  test.each([
    {},
    { rootId: 'om_old_root' },
    { threadId: 'omt_existing', rootId: 'om_old_root' },
    { activeContext: { contextId: 'old', rootMessageId: 'om_old' } },
    {
      threadId: 'omt_existing',
      activeContext: { contextId: 'old', rootMessageId: 'om_old' },
    },
  ])('ordinary mentions always use the bound session: %j', (context) => {
    const result = plan({
      ...context,
      activationMode: 'when_mentioned',
      mentionedBot: true,
    });
    expect(result).toMatchObject({
      independentContext: false,
      allowWithoutMention: false,
      reason: 'shared_chat',
    });
    expect(result.contextId).toBeUndefined();
  });

  test.each(['when_mentioned', 'owner_mentioned', 'auto'] as const)(
    'old ordinary-group context cannot bypass %s activation',
    (activationMode) => {
      const result = plan({
        activationMode,
        requireMention: true,
        mentionedBot: false,
        threadId: 'omt_old',
        rootId: 'om_old',
        activeContext: { contextId: 'old', rootMessageId: 'om_old' },
      });
      expect(result).toMatchObject({
        independentContext: false,
        allowWithoutMention: false,
        reason: 'mention_required',
      });
      expect(result.contextId).toBeUndefined();
    },
  );

  test('ordinary group preserves only the current reply anchor, not an old active context', () => {
    const result = plan({
      rootId: 'om_current_root',
      activeContext: { contextId: 'old', rootMessageId: 'om_old_root' },
    });
    expect(result).toMatchObject({
      independentContext: false,
      rootMessageId: 'om_current_root',
    });
    expect(result.contextId).toBeUndefined();
  });

  test('provider group_message_type marks a native topic group independently of activation', () => {
    expect(
      plan({
        groupMessageType: 'thread',
        rootId: 'om_topic',
        threadId: 'omt_topic',
      }),
    ).toMatchObject({
      independentContext: true,
      contextId: 'omt_topic',
      reason: 'new_native_topic',
    });
    expect(plan({ chatType: 'p2p', groupMessageType: 'thread' })).toMatchObject(
      { independentContext: false, reason: 'direct' },
    );
  });

  test('topic groups isolate every topic in always mode', () => {
    expect(
      plan({
        chatMode: 'topic',
        threadId: 'omt_topic_a',
        rootId: 'om_topic_a',
      }),
    ).toMatchObject({
      allowWithoutMention: true,
      independentContext: true,
      contextId: 'omt_topic_a',
      rootMessageId: 'om_topic_a',
      reason: 'new_native_topic',
    });
  });

  test('topic mention mode requires mention only until the topic is active', () => {
    expect(
      plan({
        chatMode: 'topic',
        activationMode: 'when_mentioned',
        threadId: 'omt_topic_a',
      }),
    ).toMatchObject({
      allowWithoutMention: false,
      independentContext: false,
      reason: 'mention_required',
    });

    expect(
      plan({
        chatMode: 'topic',
        activationMode: 'when_mentioned',
        mentionedBot: true,
        threadId: 'omt_topic_a',
        rootId: 'om_topic_a',
      }),
    ).toMatchObject({
      independentContext: true,
      contextId: 'omt_topic_a',
      reason: 'new_native_topic',
    });

    expect(
      plan({
        chatMode: 'topic',
        activationMode: 'when_mentioned',
        threadId: 'omt_topic_a',
        activeContext: {
          contextId: 'omt_topic_a',
          rootMessageId: 'om_topic_a',
        },
      }),
    ).toMatchObject({
      allowWithoutMention: true,
      independentContext: true,
      reason: 'active_context',
    });
  });

  test('auto mode preserves the legacy require_mention flag', () => {
    expect(
      plan({
        activationMode: 'auto',
        requireMention: true,
        mentionedBot: false,
      }),
    ).toMatchObject({ reason: 'mention_required' });
    expect(
      plan({ activationMode: 'auto', requireMention: false }),
    ).toMatchObject({ reason: 'shared_chat' });
  });
});
