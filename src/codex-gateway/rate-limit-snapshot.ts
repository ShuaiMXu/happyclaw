// ─── ChatGPT/Codex 订阅网关 — 上游用量窗口快照 ─────────────────────
//
// 官方 Codex CLI（codex-api/src/rate_limits.rs）从每个响应的 x-codex-* 头
// 读取主/次用量窗口、credits 与生效中的限额族，用来显示剩余额度。网关按
// provider 在内存中保留最近一次快照（按 limitId 合并），供设置页通过
// GET /api/config/claude/providers/:id/usage 读取；服务重启后清空。
// 用量窗口被拒（usage_limit_reached）且能确定重置时间时，同时把 provider
// 隔离到重置时刻，provider 池不会再把请求派给注定被拒的账号。

import { logger } from '../logger.js';
import { providerPool } from '../provider-pool.js';

export interface CodexRateLimitWindow {
  /** Share of the window already used, 0..100. */
  usedPercent: number;
  windowMinutes: number | null;
  /** Window reset, Unix epoch seconds. */
  resetsAt: number | null;
}

export interface CodexCreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface CodexRateLimitSnapshot {
  /** Metered limit family, e.g. `codex` or `codex_other`. */
  limitId: string;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  credits: CodexCreditsSnapshot | null;
}

/** Body of the usage route for a Codex provider. */
export interface CodexProviderRateLimits {
  kind: 'codex_rate_limits';
  /** Last upstream response that carried rate-limit data, epoch ms. */
  observedAt: number | null;
  /** `x-codex-active-limit`: the limit family this account is metered on. */
  activeLimit: string | null;
  /** `x-codex-rate-limit-reached-type` of the latest rejected request. */
  rateLimitReachedType: string | null;
  limits: CodexRateLimitSnapshot[];
}

interface StoredRateLimits {
  observedAt: number;
  activeLimit: string | null;
  rateLimitReachedType: string | null;
  limits: Map<string, CodexRateLimitSnapshot>;
}

const MAX_TRACKED_PROVIDERS = 256;
const MAX_LIMIT_FAMILIES = 16;
const MAX_TEXT_LENGTH = 100;
const REACHED_TYPES = new Set([
  'rate_limit_reached',
  'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached',
]);

const snapshots = new Map<string, StoredRateLimits>();

function headerText(headers: Headers, name: string): string | null {
  const value = headers.get(name)?.trim();
  return value && value.length <= MAX_TEXT_LENGTH ? value : null;
}

function headerNumber(headers: Headers, name: string): number | null {
  const value = headerText(headers, name);
  if (value === null || !/^[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(value))
    return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function headerInteger(headers: Headers, name: string): number | null {
  const value = headerText(headers, name);
  return value !== null && /^[-+]?\d+$/.test(value) ? Number(value) : null;
}

function headerBoolean(headers: Headers, name: string): boolean | null {
  const value = headerText(headers, name)?.toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return null;
}

/** rate_limits.rs normalize_limit_id. */
function normalizeLimitId(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, '_');
}

function parseWindow(
  headers: Headers,
  prefix: string,
  window: 'primary' | 'secondary',
): CodexRateLimitWindow | null {
  const usedPercent = headerNumber(headers, `${prefix}-${window}-used-percent`);
  if (usedPercent === null) return null;
  const windowMinutes = headerInteger(
    headers,
    `${prefix}-${window}-window-minutes`,
  );
  const resetsAt = headerInteger(headers, `${prefix}-${window}-reset-at`);
  // A zero window with neither a length nor a reset carries no information.
  const hasData =
    usedPercent !== 0 ||
    (windowMinutes !== null && windowMinutes !== 0) ||
    resetsAt !== null;
  return hasData ? { usedPercent, windowMinutes, resetsAt } : null;
}

function parseCredits(headers: Headers): CodexCreditsSnapshot | null {
  const hasCredits = headerBoolean(headers, 'x-codex-credits-has-credits');
  const unlimited = headerBoolean(headers, 'x-codex-credits-unlimited');
  if (hasCredits === null || unlimited === null) return null;
  return {
    hasCredits,
    unlimited,
    balance: headerText(headers, 'x-codex-credits-balance'),
  };
}

/** rate_limits.rs parse_rate_limit_for_limit. */
function parseLimit(
  headers: Headers,
  limitId: string | null,
): CodexRateLimitSnapshot {
  const normalized = (limitId?.trim() || 'codex')
    .toLowerCase()
    .replace(/_/g, '-');
  const prefix = `x-${normalized}`;
  return {
    limitId: normalizeLimitId(normalized),
    limitName: headerText(headers, `${prefix}-limit-name`),
    primary: parseWindow(headers, prefix, 'primary'),
    secondary: parseWindow(headers, prefix, 'secondary'),
    credits: parseCredits(headers),
  };
}

function hasLimitData(snapshot: CodexRateLimitSnapshot): boolean {
  return !!(snapshot.primary || snapshot.secondary || snapshot.credits);
}

/**
 * rate_limits.rs parse_all_rate_limits: the default `codex` family plus every
 * other family announced by an `x-<id>-primary-used-percent` header. Families
 * without any window or credits data are left out.
 */
export function parseCodexRateLimitHeaders(
  headers: Headers,
): CodexRateLimitSnapshot[] {
  const limits = [parseLimit(headers, null)];
  const ids = new Set<string>();
  headers.forEach((_value, name) => {
    const match = /^x-(.+)-primary-used-percent$/.exec(name.toLowerCase());
    if (match && normalizeLimitId(match[1]) !== 'codex')
      ids.add(normalizeLimitId(match[1]));
  });
  for (const id of [...ids].sort().slice(0, MAX_LIMIT_FAMILIES))
    limits.push(parseLimit(headers, id));
  return limits.filter(hasLimitData);
}

function storedFor(providerId: string, now: number): StoredRateLimits {
  let stored = snapshots.get(providerId);
  if (stored) {
    // Re-insert so the map stays ordered by last observation.
    snapshots.delete(providerId);
  } else {
    stored = {
      observedAt: now,
      activeLimit: null,
      rateLimitReachedType: null,
      limits: new Map(),
    };
  }
  snapshots.set(providerId, stored);
  while (snapshots.size > MAX_TRACKED_PROVIDERS)
    snapshots.delete(snapshots.keys().next().value!);
  return stored;
}

/**
 * Record the rate-limit headers of one upstream response. A successful
 * response clears the rejection type; headers without limit data leave the
 * previous snapshot in place.
 */
export function recordCodexRateLimitHeaders(
  providerId: string,
  headers: Headers,
  options: { ok: boolean; now?: number },
): void {
  const now = options.now ?? Date.now();
  const limits = parseCodexRateLimitHeaders(headers);
  const activeLimit = headerText(headers, 'x-codex-active-limit');
  const reachedType = headerText(
    headers,
    'x-codex-rate-limit-reached-type',
  )?.toLowerCase();
  const rejected =
    !options.ok && reachedType && REACHED_TYPES.has(reachedType)
      ? reachedType
      : null;
  const existing = snapshots.get(providerId);
  if (!limits.length && !activeLimit && !rejected) {
    if (options.ok && existing) existing.rateLimitReachedType = null;
    return;
  }
  const stored = storedFor(providerId, now);
  stored.observedAt = now;
  if (activeLimit) stored.activeLimit = normalizeLimitId(activeLimit);
  stored.rateLimitReachedType = options.ok ? null : (rejected ?? null);
  for (const limit of limits) stored.limits.set(limit.limitId, limit);
}

function eventWindow(value: unknown): CodexRateLimitWindow | null {
  if (!value || typeof value !== 'object') return null;
  const window = value as Record<string, unknown>;
  const usedPercent = window.used_percent;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent))
    return null;
  const integer = (field: unknown) =>
    typeof field === 'number' && Number.isInteger(field) ? field : null;
  return {
    usedPercent,
    windowMinutes: integer(window.window_minutes),
    resetsAt: integer(window.reset_at),
  };
}

/** rate_limits.rs parse_rate_limit_event: an in-band `codex.rate_limits` frame. */
export function recordCodexRateLimitEvent(
  providerId: string,
  event: Record<string, unknown>,
  now = Date.now(),
): void {
  if (event.type !== 'codex.rate_limits') return;
  const details =
    event.rate_limits && typeof event.rate_limits === 'object'
      ? (event.rate_limits as Record<string, unknown>)
      : {};
  const credits =
    event.credits && typeof event.credits === 'object'
      ? (event.credits as Record<string, unknown>)
      : null;
  const name =
    typeof event.metered_limit_name === 'string'
      ? event.metered_limit_name
      : typeof event.limit_name === 'string'
        ? event.limit_name
        : 'codex';
  const snapshot: CodexRateLimitSnapshot = {
    limitId: normalizeLimitId(name).slice(0, MAX_TEXT_LENGTH) || 'codex',
    limitName: null,
    primary: eventWindow(details.primary),
    secondary: eventWindow(details.secondary),
    credits:
      credits &&
      typeof credits.has_credits === 'boolean' &&
      typeof credits.unlimited === 'boolean'
        ? {
            hasCredits: credits.has_credits,
            unlimited: credits.unlimited,
            balance:
              typeof credits.balance === 'string'
                ? credits.balance.slice(0, MAX_TEXT_LENGTH)
                : null,
          }
        : null,
  };
  if (!hasLimitData(snapshot)) return;
  const stored = storedFor(providerId, now);
  stored.observedAt = now;
  if (
    !stored.limits.has(snapshot.limitId) &&
    stored.limits.size >= MAX_LIMIT_FAMILIES
  )
    return;
  stored.limits.set(snapshot.limitId, snapshot);
}

export function getCodexProviderRateLimits(
  providerId: string,
): CodexProviderRateLimits {
  const stored = snapshots.get(providerId);
  return {
    kind: 'codex_rate_limits',
    observedAt: stored?.observedAt ?? null,
    activeLimit: stored?.activeLimit ?? null,
    rateLimitReachedType: stored?.rateLimitReachedType ?? null,
    limits: stored
      ? [...stored.limits.values()].map((limit) => ({ ...limit }))
      : [],
  };
}

/** Test/credential-change hook. */
export function clearCodexProviderRateLimits(providerId?: string): void {
  if (providerId === undefined) snapshots.clear();
  else snapshots.delete(providerId);
}

/**
 * Reset of the exhausted window, epoch seconds: the active family's (or any
 * family's) window that reports 100% used. Used when usage_limit_reached
 * arrives without its own resets_at.
 */
export function exhaustedWindowResetAt(providerId: string): number | null {
  const stored = snapshots.get(providerId);
  if (!stored) return null;
  const active = stored.activeLimit
    ? stored.limits.get(stored.activeLimit)
    : undefined;
  const families = active ? [active] : [...stored.limits.values()];
  let reset: number | null = null;
  for (const family of families)
    for (const window of [family.primary, family.secondary])
      if (window && window.usedPercent >= 100 && window.resetsAt !== null)
        reset = Math.max(reset ?? 0, window.resetsAt);
  return reset;
}

/**
 * The account's usage window is exhausted until `resetsAt` (epoch seconds):
 * quarantine the provider so the pool stops routing turns to it until then.
 */
export function quarantineCodexProviderUntil(
  providerId: string,
  resetsAt: number,
  now = Date.now(),
): void {
  if (!Number.isFinite(resetsAt) || resetsAt * 1000 <= now) return;
  providerPool.reportFailure(providerId, true, resetsAt * 1000);
  logger.warn(
    { providerId, resetsAt: new Date(resetsAt * 1000).toISOString() },
    'Codex gateway: usage limit reached; provider quarantined until reset',
  );
}
