/**
 * Host-owned Claude OAuth refresh.
 *
 * Anthropic rotates the refresh token on every refresh, so two holders of the
 * same refresh token can never both succeed: the loser receives invalid_grant
 * and the provider is dead until someone logs in again. HappyClaw therefore
 * owns refresh on the host:
 *
 * - One in-flight exchange per provider (single-flight); concurrent callers
 *   join it instead of spending the same refresh token twice.
 * - Credentials are renewed ahead of expiry (CLAUDE_OAUTH_REFRESH_LEAD_MS with
 *   a stable per-provider jitter), well before Claude Code's own 5-minute
 *   threshold, so a runner started from fresh credentials does not refresh
 *   them itself while another runner holds the same token.
 * - A rotation is persisted with the provider credential CAS, then fanned out
 *   to the session credential files bound to the provider.
 * - invalid_grant and other 400/401 rejections are terminal: the provider is
 *   marked as needing a new login and is not retried until its credentials
 *   change. 429, 5xx and network failures back off exponentially.
 */
import { createHash } from 'node:crypto';

import {
  classifyClaudeRefreshFailure,
  claudeOAuthErrorCode,
  claudeOAuthRefreshScopes,
  claudeOAuthTokenHeaders,
  buildClaudeRefreshBody,
  CLAUDE_OAUTH_TOKEN_URL,
  extractClaudeOAuthAccount,
  parseClaudeExpiresIn,
  parseClaudeTokenScopes,
  parseRetryAfterMs,
} from './claude-oauth.js';
import { logger } from './logger.js';
import { updateProviderSessionCredentials } from './provider-session-credentials.js';
import {
  buildClaudeAiOauthPayload,
  getProviderById,
  markProviderOAuthRefreshFailureIfCurrent,
  providerToConfig,
  updateProviderOAuthCredentialsIfCurrent,
  type ClaudeOAuthCredentials,
  type ClaudeOAuthRefreshError,
} from './runtime-config.js';

/**
 * Median lead time before access-token expiry at which a credential becomes
 * due. Anthropic issues roughly eight-hour access tokens; renewing 45 minutes
 * early (±15 minutes of stable per-provider jitter, so providers imported
 * together do not renew in lockstep) keeps a runner's whole lifetime clear of
 * Claude Code's own 5-minute refresh threshold.
 */
export const CLAUDE_OAUTH_REFRESH_LEAD_MS = 45 * 60_000;
export const CLAUDE_OAUTH_REFRESH_JITTER_MS = 15 * 60_000;
const TOKEN_REFRESH_TIMEOUT_MS = 30_000;
const BACKOFF_INITIAL_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;

/** Stable renewal lead for one provider, in [lead - jitter, lead + jitter]. */
export function claudeOAuthRefreshLeadMs(providerId: string): number {
  const digest = createHash('sha256').update(providerId).digest();
  const spanSeconds = (2 * CLAUDE_OAUTH_REFRESH_JITTER_MS) / 1000 + 1;
  const offsetSeconds = digest.readUInt32BE(0) % spanSeconds;
  return (
    CLAUDE_OAUTH_REFRESH_LEAD_MS -
    CLAUDE_OAUTH_REFRESH_JITTER_MS +
    offsetSeconds * 1000
  );
}

export function isClaudeOAuthRefreshDue(
  providerId: string,
  credentials: Pick<ClaudeOAuthCredentials, 'expiresAt'>,
  now = Date.now(),
): boolean {
  return credentials.expiresAt - now <= claudeOAuthRefreshLeadMs(providerId);
}

export type ClaudeOAuthRefreshOutcome =
  | { status: 'refreshed'; credentials: ClaudeOAuthCredentials }
  /** Not inside the renewal window and not forced. */
  | { status: 'not_due' }
  /** The provider's credentials changed during the exchange; re-read them. */
  | { status: 'superseded' }
  | { status: 'no_credentials' }
  | { status: 'needs_relogin'; error: ClaudeOAuthRefreshError }
  | { status: 'backoff'; retryAt: number; message: string }
  | { status: 'failed'; terminal: boolean; message: string };

interface TransientBackoff {
  fingerprint: string;
  failures: number;
  retryAt: number;
  message: string;
}

const inFlightRefreshes = new Map<string, Promise<ClaudeOAuthRefreshOutcome>>();
const transientBackoff = new Map<string, TransientBackoff>();
const rotationListeners = new Set<(providerId: string) => void>();

/**
 * Observe host-side rotations, e.g. to drop cached usage or retire runners
 * still holding the previous token in memory. Returns an unsubscribe.
 */
export function onClaudeOAuthCredentialsRefreshed(
  listener: (providerId: string) => void,
): () => void {
  rotationListeners.add(listener);
  return () => rotationListeners.delete(listener);
}

function credentialFingerprint(credentials: ClaudeOAuthCredentials): string {
  return createHash('sha256')
    .update(`${credentials.refreshToken}\n${credentials.accessToken}`)
    .digest('hex');
}

/** Test seam: forget backoff state. */
export function resetClaudeOAuthRefreshStateForTest(): void {
  transientBackoff.clear();
  inFlightRefreshes.clear();
}

/**
 * Refresh one provider's Claude OAuth credentials. Without `force` it only
 * acts inside the renewal window; `force` is for a 401 from a still-unexpired
 * token. Never throws.
 */
export function refreshClaudeProviderOAuth(
  providerId: string,
  options: { force?: boolean } = {},
): Promise<ClaudeOAuthRefreshOutcome> {
  const inFlight = inFlightRefreshes.get(providerId);
  if (inFlight) {
    if (!options.force) return inFlight;
    // A forced caller saw the token rejected; a joined window check that
    // found it fresh does not answer that.
    return inFlight.then((outcome) =>
      outcome.status === 'not_due'
        ? refreshClaudeProviderOAuth(providerId, options)
        : outcome,
    );
  }
  const promise = runRefresh(providerId, options.force === true)
    .catch((err): ClaudeOAuthRefreshOutcome => {
      logger.warn({ err, providerId }, 'Claude OAuth refresh crashed');
      return {
        status: 'failed',
        terminal: false,
        message: err instanceof Error ? err.message : 'OAuth refresh failed',
      };
    })
    .finally(() => {
      if (inFlightRefreshes.get(providerId) === promise) {
        inFlightRefreshes.delete(providerId);
      }
    });
  inFlightRefreshes.set(providerId, promise);
  return promise;
}

async function runRefresh(
  providerId: string,
  force: boolean,
): Promise<ClaudeOAuthRefreshOutcome> {
  const provider = getProviderById(providerId);
  // The CAS compares against the payload Claude Code sees, so scopes are the
  // defaulted ones for credentials imported without scopes.
  const expected = provider
    ? buildClaudeAiOauthPayload(providerToConfig(provider))
    : null;
  if (!provider || !expected) return { status: 'no_credentials' };
  if (provider.claudeOAuthLastRefreshError) {
    return {
      status: 'needs_relogin',
      error: provider.claudeOAuthLastRefreshError,
    };
  }
  if (!force && !isClaudeOAuthRefreshDue(providerId, expected)) {
    return { status: 'not_due' };
  }
  const fingerprint = credentialFingerprint(expected);
  const backoff = transientBackoff.get(providerId);
  if (backoff && backoff.fingerprint === fingerprint) {
    if (backoff.retryAt > Date.now()) {
      return {
        status: 'backoff',
        retryAt: backoff.retryAt,
        message: backoff.message,
      };
    }
  } else if (backoff) {
    transientBackoff.delete(providerId);
  }

  const plan = claudeOAuthRefreshScopes(expected);
  let exchange = await exchangeRefreshToken(expected.refreshToken, plan.scope);
  // Like Claude Code: a rebuilt scope rejected as invalid_scope is retried
  // once with the stored scope. That rejection did not spend the token.
  if (
    !exchange.ok &&
    plan.fallbackScope &&
    exchange.status === 400 &&
    claudeOAuthErrorCode(exchange.body) === 'invalid_scope'
  ) {
    exchange = await exchangeRefreshToken(
      expected.refreshToken,
      plan.fallbackScope,
    );
  }

  if (!exchange.ok) {
    if (exchange.status === null) {
      return recordTransientFailure(
        providerId,
        fingerprint,
        `OAuth token refresh failed: ${exchange.body}`,
        null,
      );
    }
    const failure = classifyClaudeRefreshFailure(
      exchange.status,
      exchange.body,
    );
    const message = `OAuth token refresh returned ${exchange.status}${
      failure.code ? ` (${failure.code})` : ''
    }`;
    if (failure.terminal) {
      return recordTerminalFailure(providerId, expected, {
        kind: failure.kind,
        message,
        at: Date.now(),
      });
    }
    return recordTransientFailure(
      providerId,
      fingerprint,
      message,
      exchange.retryAfterMs,
    );
  }

  const raw = exchange.data;
  const accessToken =
    typeof raw.access_token === 'string' ? raw.access_token.trim() : '';
  if (!accessToken) {
    return recordTransientFailure(
      providerId,
      fingerprint,
      'OAuth token refresh returned no access_token',
      null,
    );
  }
  const account = extractClaudeOAuthAccount(raw);
  const knownAccount = provider.claudeOAuthAccount?.accountUuid;
  if (
    knownAccount &&
    account?.accountUuid &&
    knownAccount !== account.accountUuid
  ) {
    // The old refresh token is spent either way; storing another account's
    // grant under this provider would silently move every session over.
    return recordTerminalFailure(providerId, expected, {
      kind: 'account_mismatch',
      message: 'OAuth refresh returned a different Claude account',
      at: Date.now(),
    });
  }
  const refreshToken =
    typeof raw.refresh_token === 'string' && raw.refresh_token.trim()
      ? raw.refresh_token.trim()
      : expected.refreshToken;
  const refreshed: ClaudeOAuthCredentials = {
    ...expected,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + parseClaudeExpiresIn(raw.expires_in) * 1000,
    scopes: parseClaudeTokenScopes(raw.scope) ?? expected.scopes,
  };

  let persisted = false;
  try {
    persisted = updateProviderOAuthCredentialsIfCurrent(
      providerId,
      expected,
      refreshed,
      { account },
    );
  } catch {
    persisted = false;
  }
  if (!persisted) {
    logger.warn(
      { providerId },
      'Claude OAuth refresh superseded by a concurrent credential change',
    );
    return { status: 'superseded' };
  }
  transientBackoff.delete(providerId);
  logger.info({ providerId }, 'Refreshed Claude OAuth credentials on host');

  const updated = getProviderById(providerId);
  if (updated) {
    try {
      updateProviderSessionCredentials(providerId, providerToConfig(updated));
    } catch (err) {
      logger.warn(
        { err, providerId },
        'Failed to project refreshed OAuth credentials into sessions',
      );
    }
  }
  for (const listener of rotationListeners) {
    try {
      listener(providerId);
    } catch (err) {
      logger.warn({ err, providerId }, 'Claude OAuth rotation listener failed');
    }
  }
  return { status: 'refreshed', credentials: refreshed };
}

function recordTerminalFailure(
  providerId: string,
  expected: ClaudeOAuthCredentials,
  error: ClaudeOAuthRefreshError,
): ClaudeOAuthRefreshOutcome {
  transientBackoff.delete(providerId);
  let marked = false;
  try {
    marked = markProviderOAuthRefreshFailureIfCurrent(
      providerId,
      expected,
      error,
    );
  } catch {
    marked = false;
  }
  if (!marked) {
    // A concurrent rotation or administrator update replaced the rejected
    // token; its failure says nothing about the current credential.
    return { status: 'superseded' };
  }
  logger.warn(
    { providerId, kind: error.kind, message: error.message },
    'Claude OAuth refresh rejected; provider needs a new login',
  );
  return { status: 'failed', terminal: true, message: error.message };
}

function recordTransientFailure(
  providerId: string,
  fingerprint: string,
  message: string,
  retryAfterMs: number | null,
): ClaudeOAuthRefreshOutcome {
  const previous = transientBackoff.get(providerId);
  const failures =
    previous && previous.fingerprint === fingerprint
      ? previous.failures + 1
      : 1;
  const ladder = Math.min(
    BACKOFF_INITIAL_MS * 2 ** (failures - 1),
    BACKOFF_MAX_MS,
  );
  const delay =
    retryAfterMs !== null
      ? Math.min(Math.max(retryAfterMs, 1_000), BACKOFF_MAX_MS)
      : ladder;
  transientBackoff.set(providerId, {
    fingerprint,
    failures,
    retryAt: Date.now() + delay,
    message,
  });
  logger.warn(
    { providerId, failures, retryInMs: delay, message },
    'Claude OAuth refresh failed transiently; backing off',
  );
  return { status: 'failed', terminal: false, message };
}

type RefreshExchange =
  | { ok: true; data: Record<string, unknown> }
  | {
      ok: false;
      /** null for a network failure or timeout. */
      status: number | null;
      body: string;
      retryAfterMs: number | null;
    };

async function exchangeRefreshToken(
  refreshToken: string,
  scope: string,
): Promise<RefreshExchange> {
  const controller = new AbortController();
  // The timer covers the body as well: headers alone are not a response.
  const timeout = setTimeout(
    () => controller.abort(),
    TOKEN_REFRESH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: claudeOAuthTokenHeaders(),
      body: JSON.stringify(buildClaudeRefreshBody(refreshToken, scope)),
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        body,
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
      };
    }
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      return {
        ok: false,
        status: null,
        body: 'token endpoint returned invalid JSON',
        retryAfterMs: null,
      };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return {
        ok: false,
        status: null,
        body: 'token endpoint returned a non-object body',
        retryAfterMs: null,
      };
    }
    return { ok: true, data: data as Record<string, unknown> };
  } catch (err) {
    return {
      ok: false,
      status: null,
      body: err instanceof Error ? err.message : 'network error',
      retryAfterMs: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}
