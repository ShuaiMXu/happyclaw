// ─── ChatGPT/Codex 订阅网关 — 每账号的传输状态 ─────────────────────
//
// 官方客户端在一个 turn 内复用两类上游状态：
// - x-codex-turn-state（codex-api/src/sse/responses.rs）：本 turn 第一次响应
//   带回的粘性路由令牌，同一 turn 的后续请求原样回放；新 turn 从空开始。
// - ChatGPT 基础设施 cookie（http-client/src/chatgpt_cloudflare_cookies.rs）：
//   只保留 Cloudflare 与 __oailb 路由 cookie，任何账号/会话 cookie 都不存。
// 官方是单账号进程，cookie 罐进程全局；HappyClaw 同进程服务多个账号，两类状态
// 都按 provider + 账号隔离，绝不跨账号共享。全部只在内存中，有 TTL 与条数上限。

import { randomBytes } from 'node:crypto';

/** A tool loop can sit between requests while tools run; idle turns expire. */
const TURN_IDLE_TTL_MS = 60 * 60_000;
const MAX_TURNS = 4096;
const MAX_JARS = 1024;
const MAX_COOKIES_PER_JAR = 32;
const MAX_COOKIE_VALUE_BYTES = 4096;
const MAX_TURN_STATE_BYTES = 8192;
/** Cookies without an expiry still leave an idle jar after a day. */
const JAR_IDLE_TTL_MS = 24 * 60 * 60_000;
const COOKIE_HOST = 'chatgpt.com';
const COOKIE_REQUEST_PATH = '/backend-api/codex/responses';

/** Isolation boundary: one ChatGPT authorization of one provider. */
export function codexTransportScope(
  providerId: string,
  accountId: string | null,
): string {
  return JSON.stringify([providerId, accountId]);
}

// ─── Turn state ───────────────────────────────────────────────────

export interface CodexTurnBoundary {
  /** The request's last user message carries new user content. */
  startsTurn: boolean;
  /** Identifies the request that opened the turn, so its retries stay in it. */
  fingerprint: string;
}

export interface CodexTurn {
  turnId: string;
  startedAtMs: number;
  /** The sticky routing token captured earlier in this turn. */
  turnState?: string;
}

interface TurnRecord extends CodexTurn {
  fingerprint: string;
  expiresAt: number;
}

const turns = new Map<string, TurnRecord>();

function turnKey(scope: string, threadId: string): string {
  return `${scope}\n${threadId}`;
}

/** Map preserves insertion order: re-inserting makes it the newest entry. */
function touch<T>(map: Map<string, T>, key: string, value: T, max: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value!);
}

/** UUID v7 like the official submission ids (session/mod.rs new_submission_id). */
export function uuidV7(now = Date.now()): string {
  const bytes = randomBytes(16);
  let time = now;
  for (let index = 5; index >= 0; index--) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The turn a request belongs to. A request that opens a turn gets a new turn
 * id and an empty turn state, unless it repeats the request that opened the
 * current turn (a retry). Tool-result continuations stay in the current turn;
 * one without a known turn (restart, expiry) opens a fresh one.
 */
export function resolveCodexTurn(
  scope: string,
  threadId: string,
  boundary: CodexTurnBoundary,
  now = Date.now(),
): CodexTurn {
  const key = turnKey(scope, threadId);
  let record = turns.get(key);
  if (record && record.expiresAt <= now) record = undefined;
  if (
    !record ||
    (boundary.startsTurn && record.fingerprint !== boundary.fingerprint)
  ) {
    record = {
      turnId: uuidV7(now),
      startedAtMs: now,
      fingerprint: boundary.fingerprint,
      expiresAt: 0,
    };
  }
  record.expiresAt = now + TURN_IDLE_TTL_MS;
  touch(turns, key, record, MAX_TURNS);
  return {
    turnId: record.turnId,
    startedAtMs: record.startedAtMs,
    ...(record.turnState ? { turnState: record.turnState } : {}),
  };
}

/** Capture `x-codex-turn-state` once per turn, as the official OnceLock does. */
export function recordCodexTurnState(
  scope: string,
  threadId: string,
  turnId: string,
  headers: Headers,
): void {
  const value = headers.get('x-codex-turn-state');
  if (
    !value ||
    value.length > MAX_TURN_STATE_BYTES ||
    !/^[\x20-\x7e]+$/.test(value)
  )
    return;
  const record = turns.get(turnKey(scope, threadId));
  if (record && record.turnId === turnId && !record.turnState)
    record.turnState = value;
}

// ─── Cookie jar ───────────────────────────────────────────────────

interface StoredCookie {
  value: string;
  /** Epoch ms; undefined = session cookie. */
  expiresAt?: number;
}

interface CookieJar {
  cookies: Map<string, StoredCookie>;
  expiresAt: number;
}

const jars = new Map<string, CookieJar>();

const ALLOWED_COOKIE_NAMES = new Set([
  '__cf_bm',
  '__cflb',
  '__cfruid',
  '__cfseq',
  '__cfwaitingroom',
  '__oailb',
  '_cfuvid',
  'cf_clearance',
  'cf_ob_info',
  'cf_use_ob',
]);

/** chatgpt_cloudflare_cookies.rs is_allowed_cloudflare_cookie_name. */
export function isAllowedCodexCookieName(name: string): boolean {
  return ALLOWED_COOKIE_NAMES.has(name) || name.startsWith('cf_chl_');
}

/** RFC 6265 path-match against the one path the gateway requests. */
function pathMatches(cookiePath: string): boolean {
  return (
    cookiePath === COOKIE_REQUEST_PATH ||
    (COOKIE_REQUEST_PATH.startsWith(cookiePath) &&
      (cookiePath.endsWith('/') ||
        COOKIE_REQUEST_PATH[cookiePath.length] === '/'))
  );
}

function parseSetCookie(
  header: string,
  now: number,
): { name: string; cookie: StoredCookie | null } | null {
  const [pair, ...attributes] = header.split(';');
  const separator = pair.indexOf('=');
  if (separator <= 0) return null;
  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();
  if (
    !isAllowedCodexCookieName(name) ||
    Buffer.byteLength(value) > MAX_COOKIE_VALUE_BYTES ||
    !/^[\x21-\x7e]*$/.test(value)
  )
    return null;
  let expiresAt: number | undefined;
  let maxAgeSeen = false;
  for (const attribute of attributes) {
    const [rawKey, ...rest] = attribute.split('=');
    const key = rawKey.trim().toLowerCase();
    const attributeValue = rest.join('=').trim();
    if (key === 'domain') {
      const domain = attributeValue.replace(/^\./, '').toLowerCase();
      if (
        domain &&
        domain !== COOKIE_HOST &&
        !COOKIE_HOST.endsWith(`.${domain}`)
      )
        return null;
    } else if (key === 'path') {
      // A path that does not start with "/" means the default path.
      if (attributeValue.startsWith('/') && !pathMatches(attributeValue))
        return null;
    } else if (key === 'max-age') {
      const seconds = Number(attributeValue);
      if (/^-?\d+$/.test(attributeValue)) {
        maxAgeSeen = true;
        expiresAt = now + seconds * 1000;
      }
    } else if (key === 'expires' && !maxAgeSeen) {
      const parsed = Date.parse(attributeValue);
      if (Number.isFinite(parsed)) expiresAt = parsed;
    }
  }
  // An expired or zero-lifetime cookie deletes the stored one.
  if (expiresAt !== undefined && expiresAt <= now)
    return { name, cookie: null };
  return { name, cookie: { value, ...(expiresAt ? { expiresAt } : {}) } };
}

/** Keep only allowlisted infrastructure cookies from any upstream response. */
export function storeCodexResponseCookies(
  scope: string,
  headers: Headers,
  now = Date.now(),
): void {
  const setCookies =
    typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  if (!setCookies.length) return;
  let jar = jars.get(scope);
  if (jar && jar.expiresAt <= now) jar = undefined;
  jar ??= { cookies: new Map(), expiresAt: 0 };
  for (const header of setCookies) {
    const parsed = parseSetCookie(header, now);
    if (!parsed) continue;
    if (!parsed.cookie) jar.cookies.delete(parsed.name);
    else if (
      jar.cookies.has(parsed.name) ||
      jar.cookies.size < MAX_COOKIES_PER_JAR
    )
      jar.cookies.set(parsed.name, parsed.cookie);
  }
  jar.expiresAt = now + JAR_IDLE_TTL_MS;
  if (jar.cookies.size) touch(jars, scope, jar, MAX_JARS);
  else jars.delete(scope);
}

/** The `Cookie` header for this account's next backend request, if any. */
export function codexCookieHeader(
  scope: string,
  now = Date.now(),
): string | undefined {
  const jar = jars.get(scope);
  if (!jar) return undefined;
  if (jar.expiresAt <= now) {
    jars.delete(scope);
    return undefined;
  }
  const pairs: string[] = [];
  for (const [name, cookie] of jar.cookies) {
    if (cookie.expiresAt !== undefined && cookie.expiresAt <= now)
      jar.cookies.delete(name);
    else pairs.push(`${name}=${cookie.value}`);
  }
  return pairs.length ? pairs.join('; ') : undefined;
}

/** Drop a provider's cookies and turn state (deleted, or another account). */
export function forgetCodexTransportState(providerId: string): void {
  const prefix = JSON.stringify([providerId]).slice(0, -1) + ',';
  for (const key of [...jars.keys()])
    if (key.startsWith(prefix)) jars.delete(key);
  for (const key of [...turns.keys()])
    if (key.startsWith(prefix)) turns.delete(key);
}

/** Test hook. */
export function resetCodexTransportStateForTests(): void {
  turns.clear();
  jars.clear();
}
