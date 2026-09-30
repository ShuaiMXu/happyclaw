import type { ApiError } from '../api/client';
import { extractErrorMessage } from './error';

function getErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return undefined;
  }

  const status = Number((error as Partial<ApiError>).status);
  return Number.isFinite(status) ? status : undefined;
}

/**
 * Turn authentication transport failures into concise, actionable UI copy.
 *
 * Login credential failures deliberately remain combined. Separating an unknown
 * username from an incorrect password would allow attackers to enumerate
 * accounts.
 */
export function getLoginErrorMessage(error: unknown): string {
  switch (getErrorStatus(error)) {
    case 0:
      return '网络连接失败，请检查网络连接后重试。';
    case 408:
      return '登录请求超时，请检查网络连接后重试。';
    case 429:
      return '登录尝试次数过多，请稍后再试。';
    case 401:
      return '用户名或密码不正确，请检查后重试。';
    default:
      if (error instanceof Error && error.message === 'Unauthorized') {
        return '用户名或密码不正确，请检查后重试。';
      }
      return extractErrorMessage(error) || '登录失败，请稍后重试。';
  }
}
