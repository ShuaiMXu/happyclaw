// ─── ChatGPT/Codex 订阅 — OAuth PKCE 流程 ────────────────────────
//
// 参数与 openai/codex 官方 CLI 源码一致：
// - authorize: codex-rs/tui/src/onboarding/auth.rs（PRODUCTION_LENGTH_AUTH_URL）
// - token 交换: form 编码；refresh: JSON 编码（codex-rs/login/src/oauth/client.rs
//   明确注释 "ChatGPT refresh uses JSON; authorization-code ... use form encoding"）
// - id_token claims: codex-rs/login/src/token_data.rs（auth.chatgpt_account_id 等）
// - 刷新失败分类: codex-rs/login/src/auth/manager.rs request_chatgpt_token_refresh
// - 吊销: codex-rs/login/src/auth/revoke.rs

import { createHash, randomBytes } from 'node:crypto';

import { logger } from '../logger.js';
import { CODEX_ORIGINATOR, codexClientHeaders } from './client-identity.js';
import {
  CODEX_OAUTH_AUTHORIZE_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_REDIRECT_URI,
  CODEX_OAUTH_REVOKE_URL,
  CODEX_OAUTH_SCOPES,
  CODEX_OAUTH_TOKEN_URL,
  type CodexOAuthCredentials,
} from './types.js';

export interface CodexPkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

export interface CodexTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresAt: number;
}

/** 生成 PKCE S256 对（verifier 为 43-128 字符 base64url，与官方一致）。 */
export function generateCodexPkcePair(): CodexPkcePair {
  const codeVerifier = randomBytes(64).toString('base64url');
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

/** 构造授权 URL。redirect_uri 固定 localhost:1455，用户把回调 URL 粘贴回来完成登录。 */
export function buildCodexAuthorizeUrl(
  state: string,
  codeChallenge: string,
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_OAUTH_CLIENT_ID,
    redirect_uri: CODEX_OAUTH_REDIRECT_URI,
    scope: CODEX_OAUTH_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    // server.rs build_authorize_url sends the process originator; the TUI's
    // is codex-tui, the same value every backend request carries.
    originator: CODEX_ORIGINATOR,
  });
  return `${CODEX_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

/** expires_in 与 JWT exp 都缺失时的兜底有效期。 */
const DEFAULT_ACCESS_TOKEN_TTL_MS = 3600 * 1000;

/**
 * token 端点失败。transient 与官方 manager.rs 的刷新分类一致：只有 401、
 * 400 + invalid_grant 与 refresh_token_expired / refresh_token_reused /
 * refresh_token_invalidated 是"凭据已被拒"（只能重新登录），其余一切——网络、
 * 超时、5xx/429、响应体异常以及其他 4xx（例如 Cloudflare 403）——都按瞬时失败
 * 退避重试。requestDelivered=false 只表示请求可证明从未到达服务器（DNS、拒绝
 * 连接、连接超时、TLS 握手失败）；授权码只有这种情况下才能重用。message 不含
 * 上游原文。
 */
export class CodexOAuthTokenError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
    readonly transient: boolean,
    readonly requestDelivered = true,
  ) {
    super(message);
    this.name = 'CodexOAuthTokenError';
  }
}

/**
 * 上游错误码只用于分类和提示，限制成短 token，避免把任意响应内容带进日志/界面。
 * 取值顺序同官方 TokenErrorDetail：字符串 error、error.code、顶层 code。
 */
function oauthErrorCode(body: Record<string, unknown>): string | null {
  const error = body.error;
  const candidate =
    typeof error === 'string' && error.trim()
      ? error
      : error && typeof error === 'object' && !Array.isArray(error)
        ? ((error as Record<string, unknown>).code ?? body.code)
        : body.code;
  return typeof candidate === 'string' &&
    /^[A-Za-z0-9_.-]{1,64}$/.test(candidate)
    ? candidate
    : null;
}

const PERMANENT_REFRESH_CODES = new Set([
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
]);

/** manager.rs: only these rejections end the refresh grant. */
export function isPermanentCodexTokenRejection(
  status: number,
  code: string | null,
): boolean {
  const normalized = code?.toLowerCase() ?? null;
  return (
    status === 401 ||
    (status === 400 && normalized === 'invalid_grant') ||
    (normalized !== null && PERMANENT_REFRESH_CODES.has(normalized))
  );
}

/** token-manager 落盘的被拒原因格式：`refresh_token 被拒绝（<code | HTTP status>）`。 */
export function describeCodexRefreshRejection(
  code: string | null,
  status: number | null,
): string {
  return `refresh_token 被拒绝（${code ?? `HTTP ${status}`}）`;
}

/**
 * 旧版本把 401/400 以外的 4xx（如 Cloudflare 403）也记成 reauth_required。
 * 返回 null 表示该原因按现行分类仍需重新登录；否则返回改记为瞬时失败时的描述。
 */
export function retiredCodexReauthReason(message: string): string | null {
  const match = /^refresh_token 被拒绝（(.+)）$/.exec(message);
  if (!match) return null;
  const detail = match[1];
  const status = /^HTTP (\d{3})$/.exec(detail)?.[1];
  const permanent = status
    ? status === '401'
    : detail.toLowerCase() === 'invalid_grant' ||
      PERMANENT_REFRESH_CODES.has(detail.toLowerCase());
  return permanent ? null : `令牌刷新暂时失败（${detail}）`;
}

/** Transport failures that provably happened before any request byte left. */
const UNDELIVERED_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_NONAME',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

/**
 * fetch reports transport failures as TypeError('fetch failed', { cause });
 * Happy Eyeballs connects add an AggregateError of per-address failures.
 */
function failedBeforeDelivery(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > 4) return false;
  const { code, errors, cause } = err as {
    code?: unknown;
    errors?: unknown;
    cause?: unknown;
  };
  if (typeof code === 'string' && UNDELIVERED_ERROR_CODES.has(code))
    return true;
  if (
    Array.isArray(errors) &&
    errors.length > 0 &&
    errors.every((entry) => failedBeforeDelivery(entry, depth + 1))
  )
    return true;
  return failedBeforeDelivery(cause, depth + 1);
}

/** access_token 没有 expires_in 时用其 JWT exp 推算到期时间，再不行才兜底一小时。 */
function accessTokenExpiry(accessToken: string): number {
  const exp = decodeJwtPayload(accessToken)?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) && exp > 0
    ? Math.trunc(exp * 1000)
    : Date.now() + DEFAULT_ACCESS_TOKEN_TTL_MS;
}

function toTokenResponse(raw: RawTokenResponse): CodexTokenResponse {
  if (typeof raw.access_token !== 'string' || !raw.access_token.trim()) {
    throw new CodexOAuthTokenError(
      'Codex OAuth response missing access_token',
      null,
      null,
      true,
    );
  }
  if (
    raw.expires_in !== undefined &&
    (!Number.isFinite(raw.expires_in) || raw.expires_in <= 0)
  ) {
    throw new CodexOAuthTokenError(
      'Codex OAuth response has invalid expires_in',
      null,
      null,
      true,
    );
  }
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? null,
    idToken: raw.id_token ?? null,
    expiresAt:
      raw.expires_in !== undefined
        ? Date.now() + raw.expires_in * 1000
        : accessTokenExpiry(raw.access_token),
  };
}

async function postTokenEndpoint(
  init: RequestInit,
): Promise<CodexTokenResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    let response: Response;
    try {
      response = await fetch(CODEX_OAUTH_TOKEN_URL, {
        ...init,
        signal: controller.signal,
      });
    } catch (err) {
      // A response timeout may follow a request the server already consumed;
      // only a connection that never opened proves the request went nowhere.
      const delivered = controller.signal.aborted || !failedBeforeDelivery(err);
      throw new CodexOAuthTokenError(
        controller.signal.aborted
          ? 'Codex OAuth token endpoint timed out'
          : 'Codex OAuth token endpoint unreachable',
        null,
        null,
        true,
        delivered,
      );
    }
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok) {
      const code = oauthErrorCode(body);
      throw new CodexOAuthTokenError(
        `Codex OAuth token endpoint rejected: ${code ?? `HTTP ${response.status}`}`,
        response.status,
        code,
        !isPermanentCodexTokenRejection(response.status, code),
      );
    }
    return toTokenResponse(body as RawTokenResponse);
  } finally {
    clearTimeout(timeout);
  }
}

/** 用授权码换 token（form 编码）。 */
export async function exchangeCodexCode(
  code: string,
  codeVerifier: string,
): Promise<CodexTokenResponse> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CODEX_OAUTH_CLIENT_ID,
    code,
    redirect_uri: CODEX_OAUTH_REDIRECT_URI,
    code_verifier: codeVerifier,
  });
  return postTokenEndpoint({
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
  });
}

/**
 * 刷新 token（JSON 编码 — 官方 CLI 明确使用 JSON 而非 form）。官方用默认 auth
 * 客户端发送，带 originator 与 User-Agent；字段按 BTreeMap 排序。
 */
export async function refreshCodexToken(
  refreshToken: string,
): Promise<CodexTokenResponse> {
  return postTokenEndpoint({
    method: 'POST',
    headers: {
      ...codexClientHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
}

const REVOKE_TIMEOUT_MS = 10_000;

/**
 * revoke.rs: revoke the refresh token (the access token only when no refresh
 * token is stored) with the default auth client headers and a 10 s timeout.
 */
export async function revokeCodexToken(
  credentials: Pick<CodexOAuthCredentials, 'accessToken' | 'refreshToken'>,
): Promise<void> {
  const refresh = !!credentials.refreshToken;
  const token = refresh ? credentials.refreshToken : credentials.accessToken;
  if (!token) return;
  const response = await fetch(CODEX_OAUTH_REVOKE_URL, {
    method: 'POST',
    headers: { ...codexClientHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      token_type_hint: refresh ? 'refresh_token' : 'access_token',
      ...(refresh ? { client_id: CODEX_OAUTH_CLIENT_ID } : {}),
    }),
    signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
  });
  await response.body?.cancel().catch(() => {});
  if (!response.ok) {
    throw new CodexOAuthTokenError(
      `Codex OAuth revoke rejected: HTTP ${response.status}`,
      response.status,
      null,
      false,
    );
  }
}

/**
 * Logout-style best-effort revocation: the caller's action has already
 * succeeded and never waits for, or fails because of, this request.
 */
export function revokeCodexTokenInBackground(
  credentials: Pick<CodexOAuthCredentials, 'accessToken' | 'refreshToken'>,
  context: { providerId: string; reason: string },
): void {
  void revokeCodexToken(credentials).then(
    () => logger.info(context, 'Codex OAuth token revoked'),
    (err: unknown) =>
      logger.warn(
        {
          ...context,
          status: err instanceof CodexOAuthTokenError ? err.status : null,
        },
        'Codex OAuth token revocation failed',
      ),
  );
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf-8'),
    );
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface CodexIdTokenClaims {
  accountId: string | null;
  planType: string | null;
  email: string | null;
  /** `auth.chatgpt_account_is_fedramp`; serde default false. */
  isFedramp: boolean;
}

/** 解析 id_token JWT 中的 ChatGPT 账号 claim。 */
export function parseCodexIdToken(idToken: string | null): CodexIdTokenClaims {
  const empty = {
    accountId: null,
    planType: null,
    email: null,
    isFedramp: false,
  };
  if (!idToken) return empty;
  const payload = decodeJwtPayload(idToken);
  if (!payload) return empty;
  // Rust's IdClaims uses serde rename for these namespaced JWT keys. Keep
  // the old unnamespaced shape for credentials from compatible gateways.
  const claimRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const auth =
    claimRecord(payload['https://api.openai.com/auth']) ??
    claimRecord(payload.auth);
  const profile =
    claimRecord(payload['https://api.openai.com/profile']) ??
    claimRecord(payload.profile);
  const email =
    (typeof payload.email === 'string' && payload.email) ||
    (typeof profile?.email === 'string' && profile.email) ||
    null;
  return {
    accountId:
      typeof auth?.chatgpt_account_id === 'string'
        ? auth.chatgpt_account_id
        : null,
    planType:
      typeof auth?.chatgpt_plan_type === 'string'
        ? auth.chatgpt_plan_type
        : null,
    email: typeof email === 'string' ? email : null,
    isFedramp: auth?.chatgpt_account_is_fedramp === true,
  };
}

/** 把 token 响应组装成可持久化的凭据结构。 */
export function buildCodexCredentials(
  token: CodexTokenResponse,
  previous?: CodexOAuthCredentials | null,
): CodexOAuthCredentials {
  const claims = parseCodexIdToken(token.idToken);
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? previous?.refreshToken ?? '',
    expiresAt: token.expiresAt,
    accountId: claims.accountId ?? previous?.accountId ?? null,
    planType: claims.planType ?? previous?.planType ?? null,
    email: claims.email ?? previous?.email ?? null,
    // A refresh without a new id_token keeps the account's FedRAMP status.
    isFedramp: token.idToken ? claims.isFedramp : previous?.isFedramp === true,
    updatedAt: new Date().toISOString(),
  };
}
