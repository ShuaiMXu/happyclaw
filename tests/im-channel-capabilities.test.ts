import { describe, expect, test } from 'vitest';
import {
  IM_CHANNEL_CAPABILITIES as backend,
  isThreadMapCapableChat as backendThreads,
} from '../src/im-channel-capabilities.js';
import {
  IM_CHANNEL_CAPABILITIES as frontend,
  isThreadMapCapableChat as frontendThreads,
} from '../web/src/constants/im-capabilities.js';

describe('IM binding capability agreement', () => {
  test('frontend and backend advertise the same session and native-topic destinations', () => {
    expect(frontend).toEqual(backend);
    expect(
      Object.values(backend)
        .filter((caps) => caps.can_bind_workspace)
        .map((caps) => caps.channel_type)
        .sort(),
    ).toEqual(['feishu', 'telegram']);
    expect(Object.values(backend).every((caps) => caps.can_bind_session)).toBe(
      true,
    );
  });

  for (const [name, supportsThreads] of [
    ['backend', backendThreads],
    ['frontend', frontendThreads],
  ] as const) {
    test(`${name}: ordinary Feishu groups ignore legacy mention flags`, () => {
      expect(
        supportsThreads({
          channel_type: 'feishu',
          chat_mode: 'group',
          native_context_type: 'thread',
          thread_capable: true,
        }),
      ).toBe(false);
      expect(
        supportsThreads({
          channel_type: 'feishu',
          native_context_type: 'thread',
          thread_capable: true,
        }),
      ).toBe(false);
      expect(
        supportsThreads({
          channel_type: 'feishu',
          chat_mode: 'p2p',
          group_message_type: 'thread',
        }),
      ).toBe(false);
    });
    test(`${name}: real Feishu topics and Telegram Forums retain workspace support`, () => {
      expect(
        supportsThreads({ channel_type: 'feishu', chat_mode: 'topic' }),
      ).toBe(true);
      expect(
        supportsThreads({
          channel_type: 'feishu',
          chat_mode: 'group',
          group_message_type: 'thread',
        }),
      ).toBe(true);
      expect(
        supportsThreads({
          channel_type: 'telegram',
          native_context_type: 'thread',
        }),
      ).toBe(true);
      expect(
        supportsThreads({ channel_type: 'qq', native_context_type: 'thread' }),
      ).toBe(false);
    });
  }
});
