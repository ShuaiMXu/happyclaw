// ─── ChatGPT/Codex 订阅 — 网关侧 token 管理 ────────────────────────
//
// 网关按 Runner 级临时 token 解析出的 provider ID 取上游凭据，按需刷新
// access_token。刷新沿用 Claude OAuth 的 CAS（compare-and-swap）落盘模式：
// 只在 provider 仍持有发起刷新时的那份凭据快照时才写回，避免与并发的 admin
// 修改互相覆盖。并发刷新做单飞（in-flight promise 复用）：上游会轮换
// refresh_token，同一时刻只允许一个网络刷新，其余请求共享同一结果，避免
// 输家拿到 invalid_grant 造成假 401。
//
// 刷新失败分两类（与官方 login/src/auth/manager.rs 一致）：refresh_token 被拒
// （401、400 + invalid_grant、refresh_token_expired/reused/invalidated）落盘为
// reauth_required，凭据更换前不再刷新；其余失败（网络、5xx/429、Cloudflare 403
// 等其他 4xx）是瞬时失败，按指数退避，退避期间仍在有效期内的 access_token 继续使用。

import { timingSafeEqual } from 'node:crypto';
import { logger } from '../logger.js';
import {
  getProviders,
  setProviderCodexOAuthRefreshErrorIfCurrent,
  updateProviderCodexOAuthCredentialsIfCurrent,
  type UnifiedProvider,
} from '../runtime-config.js';
import {
  buildCodexCredentials,
  CodexOAuthTokenError,
  describeCodexRefreshRejection,
  refreshCodexToken,
} from './oauth.js';
import {
  CODEX_TOKEN_REFRESH_MARGIN_MS,
  type CodexOAuthCredentials,
  type CodexOAuthRefreshErrorState,
} from './types.js';

export class CodexGatewayAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexGatewayAuthError';
  }
}

/** The refresh grant is gone: only a new ChatGPT login can recover. */
export class CodexReauthRequiredError extends CodexGatewayAuthError {
  constructor(readonly reason: string) {
    super(
      `ChatGPT 订阅登录已失效：${reason}。请在「模型配置」中重新登录 ChatGPT。`,
    );
    this.name = 'CodexReauthRequiredError';
  }
}

/** A refresh failed transiently and is backing off; retry later. */
export class CodexRefreshUnavailableError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('ChatGPT 令牌刷新暂时失败，网关会自动重试，请稍后再发送。');
    this.name = 'CodexRefreshUnavailableError';
  }
}

/** First transient failure waits 30s, doubling up to CLIProxyAPI's 5 minutes. */
const TRANSIENT_REFRESH_BACKOFF_BASE_MS = 30_000;
const TRANSIENT_REFRESH_BACKOFF_MAX_MS = 5 * 60_000;

/** 常数时间比较 bearer token，长度不同直接不等（长度本身不是机密）。 */
function isSameSecret(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Map a provider's stored gateway identifier back to the provider at runner
 * launch. The identifier is never accepted as a gateway credential.
 */
export function findCodexProviderByGatewayIdentifier(
  identifier: string,
): UnifiedProvider | null {
  if (!identifier) return null;
  return (
    getProviders().find(
      (candidate) =>
        !!candidate.codexOAuthCredentials &&
        typeof candidate.anthropicAuthToken === 'string' &&
        candidate.anthropicAuthToken.length > 0 &&
        isSameSecret(candidate.anthropicAuthToken, identifier),
    ) ?? null
  );
}

/**
 * The provider a runner grant points at. `enabled` is deliberately not
 * required: grants are minted only for launches that legitimately selected
 * this provider (an Agent may pin a disabled model configuration), and toggling
 * a provider retires its runners — and with them their grants.
 */
export function resolveCodexProvider(providerId: string): UnifiedProvider {
  const provider = getProviders().find(
    (candidate) =>
      candidate.id === providerId && !!candidate.codexOAuthCredentials,
  );
  if (!provider) {
    throw new CodexGatewayAuthError(
      'Codex provider was removed or its ChatGPT login was cleared',
    );
  }
  return provider;
}

/** One rotating-token exchange per provider; callers always re-read after it. */
const inFlightRefreshes = new Map<string, Promise<void>>();

interface RefreshBackoff {
  refreshToken: string;
  failures: number;
  until: number;
}
/** In-memory only, and keyed to the refresh token it was observed with. */
const refreshBackoffs = new Map<string, RefreshBackoff>();

function sameCredentials(
  a: CodexOAuthCredentials,
  b: CodexOAuthCredentials | null | undefined,
): boolean {
  return (
    !!b &&
    a.accessToken === b.accessToken &&
    a.refreshToken === b.refreshToken &&
    a.expiresAt === b.expiresAt &&
    a.accountId === b.accountId
  );
}

function activeBackoff(
  providerId: string,
  credentials: CodexOAuthCredentials,
  now = Date.now(),
): RefreshBackoff | null {
  const backoff = refreshBackoffs.get(providerId);
  if (!backoff) return null;
  if (backoff.refreshToken !== credentials.refreshToken) {
    // New credentials (re-login or admin edit) start with a clean slate.
    refreshBackoffs.delete(providerId);
    return null;
  }
  return backoff.until > now ? backoff : null;
}

function describeRefreshFailure(err: unknown): CodexOAuthRefreshErrorState {
  const at = new Date().toISOString();
  if (err instanceof CodexOAuthTokenError && !err.transient) {
    return {
      kind: 'reauth_required',
      message: describeCodexRefreshRejection(err.code, err.status),
      at,
    };
  }
  const detail =
    err instanceof CodexOAuthTokenError
      ? err.status
        ? `${err.code ? `${err.code}, ` : ''}HTTP ${err.status}`
        : err.message.includes('timed out')
          ? '超时'
          : '网络不可达'
      : '内部错误';
  return { kind: 'transient', message: `令牌刷新暂时失败（${detail}）`, at };
}

function persistRefreshError(
  providerId: string,
  credentials: CodexOAuthCredentials,
  state: CodexOAuthRefreshErrorState,
): void {
  try {
    setProviderCodexOAuthRefreshErrorIfCurrent(providerId, credentials, state);
  } catch (err) {
    logger.warn(
      { providerId, err },
      'Codex gateway: failed to persist token refresh state',
    );
  }
}

/**
 * Performs the network refresh and, exactly once per failed exchange, records
 * its classification: concurrent waiters share this promise and must not
 * escalate the backoff once each.
 */
async function performRefresh(
  providerId: string,
  credentials: CodexOAuthCredentials,
): Promise<void> {
  let refreshed: CodexOAuthCredentials;
  try {
    const tokenResponse = await refreshCodexToken(credentials.refreshToken);
    refreshed = buildCodexCredentials(tokenResponse, credentials);
  } catch (err) {
    const state = describeRefreshFailure(err);
    if (state.kind === 'transient') {
      const previous = refreshBackoffs.get(providerId);
      const failures =
        previous?.refreshToken === credentials.refreshToken
          ? previous.failures + 1
          : 1;
      refreshBackoffs.set(providerId, {
        refreshToken: credentials.refreshToken,
        failures,
        until:
          Date.now() +
          Math.min(
            TRANSIENT_REFRESH_BACKOFF_BASE_MS * 2 ** (failures - 1),
            TRANSIENT_REFRESH_BACKOFF_MAX_MS,
          ),
      });
    }
    persistRefreshError(providerId, credentials, state);
    logger.warn(
      { providerId, kind: state.kind, reason: state.message },
      'Codex gateway: failed to refresh upstream access token',
    );
    throw err;
  }
  refreshBackoffs.delete(providerId);
  // A CAS loser must not return its old credential object to other waiters:
  // getProviders() creates separate snapshots, so object identity is irrelevant.
  updateProviderCodexOAuthCredentialsIfCurrent(
    providerId,
    credentials,
    refreshed,
  );
}

export interface CodexAccessContext {
  providerId: string;
  accessToken: string;
  accountId: string | null;
  /** Requests for a FedRAMP account carry `X-OpenAI-Fedramp: true`. */
  isFedramp: boolean;
}

export interface ResolveCodexAccessOptions {
  /**
   * The access token upstream just answered 401 for. A matching current token
   * is refreshed even before its recorded expiry; a different current token
   * means a concurrent request already replaced it.
   */
  rejectedAccessToken?: string;
}

function accessContext(
  providerId: string,
  credentials: CodexOAuthCredentials,
): CodexAccessContext {
  return {
    providerId,
    accessToken: credentials.accessToken,
    accountId: credentials.accountId,
    isFedramp: credentials.isFedramp === true,
  };
}

/** Resolve a usable upstream access token for the provider a runner grant names. */
export async function resolveCodexAccess(
  providerId: string,
  options: ResolveCodexAccessOptions = {},
): Promise<CodexAccessContext> {
  // Recheck the persisted credentials after every await: an admin may delete,
  // re-authorize or clear the provider while a refresh is in flight.
  for (let attempt = 0; attempt <= 3; attempt++) {
    const provider = resolveCodexProvider(providerId);
    const credentials = provider.codexOAuthCredentials!;
    const now = Date.now();
    const rejected =
      !!options.rejectedAccessToken &&
      credentials.accessToken === options.rejectedAccessToken;
    const expired = now >= credentials.expiresAt;
    const refreshError = provider.codexOAuthLastRefreshError ?? null;

    if (refreshError?.kind === 'reauth_required') {
      // No refresh until the credentials change. The access token keeps
      // serving only while it is unexpired and upstream still accepts it.
      if (rejected && !refreshError.accessTokenRejected) {
        persistRefreshError(providerId, credentials, {
          ...refreshError,
          accessTokenRejected: true,
        });
      }
      if (rejected || expired || refreshError.accessTokenRejected) {
        throw new CodexReauthRequiredError(refreshError.message);
      }
      return accessContext(providerId, credentials);
    }
    if (
      !rejected &&
      now < credentials.expiresAt - CODEX_TOKEN_REFRESH_MARGIN_MS
    )
      return accessContext(providerId, credentials);

    const backoff = activeBackoff(providerId, credentials, now);
    if (backoff) {
      if (!rejected && !expired) return accessContext(providerId, credentials);
      throw new CodexRefreshUnavailableError(backoff.until - now);
    }
    if (attempt === 3) {
      throw new CodexGatewayAuthError(
        'Codex OAuth credentials changed concurrently during refresh',
      );
    }
    if (!credentials.refreshToken) {
      const state: CodexOAuthRefreshErrorState = {
        kind: 'reauth_required',
        message: '凭据缺少 refresh_token',
        at: new Date().toISOString(),
        ...(rejected || expired ? { accessTokenRejected: true } : {}),
      };
      persistRefreshError(providerId, credentials, state);
      throw new CodexReauthRequiredError(state.message);
    }
    let inFlight = inFlightRefreshes.get(provider.id);
    if (!inFlight) {
      inFlight = performRefresh(provider.id, credentials).finally(() => {
        inFlightRefreshes.delete(provider.id);
      });
      inFlightRefreshes.set(provider.id, inFlight);
    }
    try {
      await inFlight;
    } catch (err) {
      const latest = resolveCodexProvider(providerId);
      if (!sameCredentials(credentials, latest.codexOAuthCredentials)) continue;
      const state = describeRefreshFailure(err);
      if (state.kind === 'reauth_required') {
        if (rejected || expired) {
          persistRefreshError(providerId, credentials, {
            ...(latest.codexOAuthLastRefreshError ?? state),
            accessTokenRejected: true,
          });
        }
        if (rejected || expired)
          throw new CodexReauthRequiredError(state.message);
        return accessContext(providerId, credentials);
      }
      if (!rejected && !expired) return accessContext(providerId, credentials);
      const retryAfterMs = Math.max(
        1000,
        (refreshBackoffs.get(providerId)?.until ?? Date.now()) - Date.now(),
      );
      throw new CodexRefreshUnavailableError(retryAfterMs);
    }
  }
  throw new CodexGatewayAuthError('Codex OAuth refresh failed');
}

/** Test hook: forget in-memory refresh backoff state. */
export function resetCodexTokenManagerForTests(): void {
  inFlightRefreshes.clear();
  refreshBackoffs.clear();
}
