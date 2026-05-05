// User API token management routes (cookie-auth).
//
// Users generate scoped tokens here (e.g. for the Chrome Extension).
// The plaintext token is only returned ONCE at creation time.

import { Hono } from 'hono';
import crypto from 'crypto';
import { z } from 'zod';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  generateApiToken,
  hashApiToken,
} from '../middleware/api-token.js';
import {
  createApiToken,
  listApiTokensByUser,
  revokeApiToken,
} from '../db.js';
import type { ApiTokenScope, AuthUser } from '../types.js';

const SUPPORTED_SCOPES: ApiTokenScope[] = ['knowledge'];

const CreateTokenSchema = z.object({
  scope: z.enum(SUPPORTED_SCOPES as [ApiTokenScope, ...ApiTokenScope[]]),
  name: z.string().max(80).optional(),
});

const tokenRoutes = new Hono<{ Variables: Variables }>();

tokenRoutes.use('*', authMiddleware);

// GET /api/user/tokens — list current user's tokens (without plaintext)
tokenRoutes.get('/', (c) => {
  const user = c.get('user') as AuthUser;
  return c.json({ tokens: listApiTokensByUser(user.id) });
});

// POST /api/user/tokens — create new token; returns plaintext ONCE
tokenRoutes.post('/', async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsed = CreateTokenSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message }, 400);
  }

  const { token, prefix } = generateApiToken();
  const id = crypto.randomUUID();
  createApiToken({
    id,
    userId: user.id,
    tokenHash: hashApiToken(token),
    tokenPrefix: prefix,
    scope: parsed.data.scope,
    name: parsed.data.name || defaultNameFor(parsed.data.scope),
  });

  return c.json(
    {
      id,
      scope: parsed.data.scope,
      name: parsed.data.name || defaultNameFor(parsed.data.scope),
      token_prefix: prefix,
      token, // plaintext — only shown once
      created_at: new Date().toISOString(),
    },
    201,
  );
});

// DELETE /api/user/tokens/:id — revoke token
tokenRoutes.delete('/:id', (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const ok = revokeApiToken(id, user.id);
  if (!ok) return c.json({ error: 'Token not found' }, 404);
  return c.json({ ok: true });
});

function defaultNameFor(scope: ApiTokenScope): string {
  if (scope === 'knowledge') return '浏览器扩展';
  return scope;
}

export default tokenRoutes;
