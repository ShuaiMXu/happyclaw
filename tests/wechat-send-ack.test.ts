import { describe, expect, test } from 'vitest';

import {
  assertWeChatApiSuccess,
  isWeChatContextTokenRejection,
  parseWeChatApiResponse,
} from '../src/wechat.js';

describe('WeChat strict outbound acknowledgement', () => {
  test.each([
    ['sendMessage', { errcode: 40013, errmsg: 'invalid appid' }, 'errcode'],
    ['sendImage', { ret: -14, errmsg: 'session expired' }, 'ret'],
    [
      'sendFile',
      { base_resp: { ret: 5, errmsg: 'upload rejected' } },
      'base_resp.ret',
    ],
  ])('%s rejects API-level failures', (operation, response, codeName) => {
    expect(() => assertWeChatApiSuccess(response, operation)).toThrow(
      `${operation} failed: ${codeName}=`,
    );
  });

  test('accepts omitted and explicit zero success codes', () => {
    expect(() => assertWeChatApiSuccess({}, 'sendMessage')).not.toThrow();
    expect(() =>
      assertWeChatApiSuccess({ ret: 0, errcode: '0', code: 0 }, 'sendMessage'),
    ).not.toThrow();
  });

  test.each([
    [{ ret: -2, errmsg: '' }, true],
    [{ ret: -2, errmsg: 'unknown error' }, true],
    [{ ret: -2, errmsg: 'prepare failed' }, true],
    [{ ret: -3, errmsg: 'invalid arguments' }, true],
    [{ ret: -14, errmsg: 'session expired' }, true],
    [{ ret: -2, errmsg: 'rate limited' }, false],
    [{ ret: -2, errmsg: 'frequency limit' }, false],
  ])(
    'classifies overloaded context errors without treating rate limits as expiry',
    (response, expected) => {
      let thrown: unknown;
      try {
        assertWeChatApiSuccess(response, 'sendMessage');
      } catch (error) {
        thrown = error;
      }
      expect(isWeChatContextTokenRejection(thrown)).toBe(expected);
    },
  );

  test('HTTP failure is rejected before a JSON body can look successful', async () => {
    const response = new Response(JSON.stringify({ ret: 0 }), {
      status: 502,
      statusText: 'Bad Gateway',
    });
    await expect(
      parseWeChatApiResponse(response, 'ilink/bot/sendmessage'),
    ).rejects.toThrow('HTTP 502');
  });
});
