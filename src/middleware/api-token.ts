// Scoped API token middleware for external clients (e.g. Chrome Extension).
//
// Accepts `Authorization: Bearer hc_<token>`. Tokens are scoped — each token
// is bound to a specific `ApiTokenScope` and can only be used on routes that
// require that exact scope. This differs from `authMiddleware` (cookie session),
// which grants full account access.

import crypto from 'crypto';
import type { Variables } from '../web-context.js';
import {
  findApiTokenByHash,
  getUserById,
  touchApiToken,
} from '../db.js';
import type { ApiTokenScope, AuthUser } from '../types.js';
import { getClientIp } from '../utils.js';

export const API_TOKEN_PREFIX = 'hc_';

export function hashApiToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Generate a new random token: `hc_<43 url-safe chars>` (32 bytes of entropy). */
export function generateApiToken(): { token: string; prefix: string } {
  const raw = crypto.randomBytes(32).toString('base64url');
  const token = `${API_TOKEN_PREFIX}${raw}`;
  const prefix = token.slice(0, 10);
  return { token, prefix };
}

export const requireApiToken =
  (scope: ApiTokenScope) =>
  async (c: any, next: any) => {
    const authHeader = c.req.header('authorization');
    const bearer = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : undefined;

    if (!bearer || !bearer.startsWith(API_TOKEN_PREFIX)) {
      return c.json({ error: 'Missing or invalid API token' }, 401);
    }

    const record = findApiTokenByHash(hashApiToken(bearer));
    if (!record || record.revoked_at) {
      return c.json({ error: 'Invalid API token' }, 401);
    }
    if (record.scope !== scope) {
      return c.json({ error: 'Token scope mismatch' }, 403);
    }

    const user = getUserById(record.user_id);
    if (!user || user.status !== 'active') {
      return c.json({ error: 'User unavailable' }, 403);
    }

    c.set('user', {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      display_name: user.display_name,
      permissions: user.permissions,
      must_change_password: user.must_change_password,
    } as AuthUser);
    c.set('apiTokenId', record.id);
    c.set('apiTokenScope', record.scope);

    // Best-effort usage tracking, no await to avoid latency
    try {
      touchApiToken(record.id, getClientIp(c) || null);
    } catch {
      /* best effort */
    }

    await next();
  };

export type ApiTokenVariables = Variables & {
  apiTokenId?: string;
  apiTokenScope?: ApiTokenScope;
};

/**
 * Composite auth: accepts EITHER a cookie session (full account) OR a Bearer
 * API token with the given scope. Falls through to authMiddleware if no
 * `hc_`-prefixed Bearer token is present, so existing cookie-auth callers
 * (web UI) work unchanged.
 */
export const cookieOrApiToken =
  (scope: ApiTokenScope) =>
  async (c: any, next: any) => {
    const authHeader = c.req.header('authorization');
    const bearer = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : undefined;

    if (bearer && bearer.startsWith(API_TOKEN_PREFIX)) {
      return requireApiToken(scope)(c, next);
    }

    // Defer to cookie session auth
    const { authMiddleware } = await import('./auth.js');
    return authMiddleware(c, next);
  };
