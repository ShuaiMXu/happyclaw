import { describe, expect, test } from 'vitest';
import {
  conversationBindingPolicyError,
  resolveChannelConversationKind,
} from '../src/channel-conversation-kind.js';

describe('resolveChannelConversationKind', () => {
  test.each([
    ['qq:c2c:user', 'direct'],
    ['qq:group:team', 'group'],
    ['dingtalk:c2c:user', 'direct'],
    ['dingtalk:cid-group', 'group'],
    ['discord:dm:123', 'direct'],
    ['discord:456', 'group'],
    ['whatsapp:123@s.whatsapp.net', 'direct'],
    ['whatsapp:1555:42@s.whatsapp.net', 'direct'],
    ['whatsapp:123456789012345@lid', 'direct'],
    ['whatsapp:123456789012345@lid#account:bot-a', 'direct'],
    ['whatsapp:hosted-user@hosted', 'direct'],
    ['whatsapp:hosted-user@hosted.lid', 'direct'],
    ['whatsapp:15551234567@c.us', 'direct'],
    ['whatsapp:15551234567:14@c.us#account:bot-a', 'direct'],
    ['whatsapp:16505361212@c.us', 'direct'],
    ['whatsapp:123@g.us', 'group'],
    ['wechat:wxid_user', 'direct'],
    ['wecom:c2c:user#account:bot-a', 'direct'],
    ['wecom:group:team#account:bot-a', 'group'],
    ['telegram:123#account:bot-a#thread:1', 'direct'],
    ['telegram:-100123#account:bot-a', 'group'],
  ])('classifies %s as %s', (jid, expected) => {
    expect(resolveChannelConversationKind(jid)).toBe(expected);
  });

  test('uses Feishu metadata because its opaque JID does not encode chat type', () => {
    expect(
      resolveChannelConversationKind('feishu:oc_same', { chat_mode: 'p2p' }),
    ).toBe('direct');
    expect(
      resolveChannelConversationKind('feishu:oc_same', {
        feishu_chat_mode: 'group',
      }),
    ).toBe('group');
    expect(resolveChannelConversationKind('feishu:oc_same')).toBe('unknown');
  });

  test('fails closed for malformed and unsupported JIDs', () => {
    expect(resolveChannelConversationKind('telegram:not-a-number')).toBe(
      'unknown',
    );
    expect(resolveChannelConversationKind('web:main')).toBe('unknown');
    expect(resolveChannelConversationKind('whatsapp:status@broadcast')).toBe(
      'unknown',
    );
    expect(resolveChannelConversationKind('whatsapp:123@newsletter')).toBe(
      'unknown',
    );
  });

  test('recognizes native Feishu topics from live or persisted provider metadata', () => {
    for (const metadata of [
      { chat_mode: 'topic' },
      { chat_mode: 'group', group_message_type: 'thread' },
      { feishu_chat_mode: 'group', feishu_group_message_type: 'thread' },
    ]) {
      expect(
        resolveChannelConversationKind('feishu:oc_topic#account:bot', metadata),
      ).toBe('topic');
    }
    expect(
      resolveChannelConversationKind('feishu:oc_private', {
        chat_mode: 'p2p',
        feishu_chat_mode: 'topic',
        feishu_group_message_type: 'thread',
      }),
    ).toBe('direct');
  });

  test('does not promote ordinary Feishu groups using legacy mention thread flags', () => {
    expect(
      resolveChannelConversationKind('feishu:oc_group', {
        chat_mode: 'group',
        native_context_type: 'thread',
        thread_capable: true,
      }),
    ).toBe('group');
    expect(
      resolveChannelConversationKind('feishu:oc_unknown', {
        native_context_type: 'thread',
        thread_capable: true,
      }),
    ).toBe('unknown');
  });

  test('keeps Telegram Forums distinct from ordinary groups and private chats', () => {
    expect(
      resolveChannelConversationKind('telegram:-100123#account:bot', {
        native_context_type: 'thread',
      }),
    ).toBe('topic');
    expect(
      resolveChannelConversationKind('telegram:-100123', {
        thread_capable: true,
      }),
    ).toBe('topic');
    expect(
      resolveChannelConversationKind('telegram:123', {
        thread_capable: true,
      }),
    ).toBe('direct');
  });
});

describe('conversationBindingPolicyError', () => {
  test('allows ordinary groups and direct chats only on sessions, topics only on workspaces', () => {
    expect(conversationBindingPolicyError('topic', 'workspace')).toBeNull();
    expect(conversationBindingPolicyError('direct', 'session')).toBeNull();
    expect(conversationBindingPolicyError('group', 'session')).toBeNull();
    expect(conversationBindingPolicyError('direct', 'workspace')).toMatch(
      /only accept native topic groups/,
    );
    expect(conversationBindingPolicyError('group', 'workspace')).toMatch(
      /only accept native topic groups/,
    );
    expect(conversationBindingPolicyError('topic', 'session')).toMatch(
      /direct chats and ordinary groups/,
    );
  });

  test('rejects unknown chats for both target types', () => {
    expect(conversationBindingPolicyError('unknown', 'workspace')).toMatch(
      /Unable to determine/,
    );
    expect(conversationBindingPolicyError('unknown', 'session')).toMatch(
      /Unable to determine/,
    );
  });
});
