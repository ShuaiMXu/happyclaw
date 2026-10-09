import { describe, expect, test } from 'vitest';
import { getLoginErrorMessage } from './login-error';

describe('getLoginErrorMessage', () => {
  test.each([
    [
      { status: 0, message: 'Network error' },
      '网络连接失败，请检查网络连接后重试。',
    ],
    [
      { status: 408, message: 'Request timeout' },
      '登录请求超时，请检查网络连接后重试。',
    ],
    [
      { status: 401, message: 'Invalid credentials' },
      '用户名或密码不正确，请检查后重试。',
    ],
    [
      { status: 429, message: 'Too many login attempts' },
      '登录尝试次数过多，请稍后再试。',
    ],
  ])('maps %o to a clear login message', (error, expected) => {
    expect(getLoginErrorMessage(error)).toBe(expected);
  });

  test('does not distinguish an unknown account from an incorrect password', () => {
    expect(
      getLoginErrorMessage({ status: 401, message: 'Invalid credentials' }),
    ).toBe('用户名或密码不正确，请检查后重试。');
  });
});
