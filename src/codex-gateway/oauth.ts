// ─── ChatGPT/Codex 订阅 — OAuth PKCE 流程 ────────────────────────
//
// 参数与 openai/codex 官方 CLI 源码一致：
// - authorize: codex-rs/tui/src/onboarding/auth.rs（PRODUCTION_LENGTH_AUTH_URL）
// - token 交换: form 编码；refresh: JSON 编码（codex-rs/login/src/oauth/client.rs
//   明确注释 "ChatGPT refresh uses JSON; authorization-code ... use form encoding"）
// - id_token claims: codex-rs/login/src/token_data.rs（auth.chatgpt_account_id 等）

import { createHash, randomBytes } from 'node:crypto';

import {
  CODEX_OAUTH_AUTHORIZE_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_REDIRECT_URI,
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
    originator: 'codex_cli_rs',
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
 * token 端点失败。transient 区分"稍后重试可能成功"（网络、超时、5xx、429、
 * 响应体异常）与"凭据/授权码已被拒"（400/401/403，如 invalid_grant、
 * refresh_token_reused）；后者只能重新登录。message 不含上游原文。
 */
export class CodexOAuthTokenError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = 'CodexOAuthTokenError';
  }
}

/** 上游错误码只用于分类和提示，限制成短 token，避免把任意响应内容带进日志/界面。 */
function oauthErrorCode(body: Record<string, unknown>): string | null {
  const error = body.error;
  const candidate =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && !Array.isArray(error)
        ? ((error as Record<string, unknown>).code ??
          (error as Record<string, unknown>).type)
        : body.code;
  return typeof candidate === 'string' &&
    /^[A-Za-z0-9_.-]{1,64}$/.test(candidate)
    ? candidate
    : null;
}

function isTransientTokenStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
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
    } catch {
      throw new CodexOAuthTokenError(
        controller.signal.aborted
          ? 'Codex OAuth token endpoint timed out'
          : 'Codex OAuth token endpoint unreachable',
        null,
        null,
        true,
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
        isTransientTokenStatus(response.status),
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

/** 刷新 token（JSON 编码 — 官方 CLI 明确使用 JSON 而非 form）。 */
export async function refreshCodexToken(
  refreshToken: string,
): Promise<CodexTokenResponse> {
  return postTokenEndpoint({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CODEX_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
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
}

/** 解析 id_token JWT 中的 ChatGPT 账号 claim。 */
export function parseCodexIdToken(idToken: string | null): CodexIdTokenClaims {
  if (!idToken) {
    return { accountId: null, planType: null, email: null };
  }
  const payload = decodeJwtPayload(idToken);
  if (!payload) {
    return { accountId: null, planType: null, email: null };
  }
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
    updatedAt: new Date().toISOString(),
  };
}
