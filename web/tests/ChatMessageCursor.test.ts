import { describe, expect, test } from 'vitest';

import { mergeMessagesChronologically, type Message } from '../src/stores/chat';

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    chat_jid: 'web:main',
    sender: 'user',
    sender_name: 'User',
    content: 'before',
    timestamp: '2026-08-31T00:00:00.000Z',
    is_from_me: false,
    ...overrides,
  };
}

describe('chat message cursor preservation', () => {
  test('keeps a REST ingest sequence across a WebSocket update without one', () => {
    const merged = mergeMessagesChronologically(
      [message({ ingest_sequence: 10 })],
      [message({ content: 'updated over ws' })],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      content: 'updated over ws',
      ingest_sequence: 10,
    });
  });
});
