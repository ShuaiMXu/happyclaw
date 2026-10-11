// ─── ChatGPT/Codex 订阅网关 — 官方客户端的请求上下文 ─────────────────
//
// 每个发往 chatgpt.com/backend-api/codex/responses 的请求，都按官方 Codex CLI
// 0.162.1 的方式携带身份、会话、turn 与缓存信息（codex-api endpoint/responses.rs、
// requests/headers.rs，core client.rs、responses_metadata.rs）。
//
// Claude Code 的会话身份（x-claude-code-session-id，或 metadata.user_id 中的
// session）对应官方 session；session + agent 对应 thread。所有派生 ID 都限定在
// provider/账号内，不同账号之间不会共享缓存键、turn 状态或 cookie。
//
// Claude execution identity follows CLIProxyAPI a2976eb8 (MIT; see
// docs/licenses/CLIProxyAPI-MIT.txt).

import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

import { codexBackendClientHeaders } from './client-identity.js';
import {
  isCodexBackgroundRequest,
  type AnthropicRequestSubset,
  serializeCodexResponsesRequest,
  type ResponsesRequest,
} from './convert-request.js';
import { codexInstallationId } from './installation-id.js';
import {
  codexCookieHeader,
  codexTransportScope,
  recordCodexTurnState,
  resolveCodexTurn,
  storeCodexResponseCookies,
  type CodexTurnBoundary,
} from './transport-state.js';

const UUID_OID_NAMESPACE = Buffer.from(
  '6ba7b8129dad11d180b400c04fd430c8',
  'hex',
);

/**
 * `x-codex-beta-features` the official client sends by default is just
 * `remote_compaction_v2` (session/mod.rs build_model_client_beta_features_header:
 * every experimental feature is off by default). It advertises that the client
 * runs remote compaction and handles `compaction` output items. HappyClaw lets
 * Claude Code compact locally and cannot replay compaction items, so it
 * advertises nothing and the header is omitted, as official does for an empty
 * list.
 */
export const CODEX_BETA_FEATURES: readonly string[] = [];

/**
 * Claude Code's background calls (haiku tier: titles, summaries, command
 * checks) take the shape of the official client's own utility call, the TUI's
 * hidden title thread (tui/src/app/thread_title.rs): a separate root thread
 * with thread_source `thread_title` and no `x-openai-subagent` (that header's
 * official values name reviewers, compaction, memory jobs and spawned agents).
 * The thread is stable per conversation thread, and its prompt cache key is
 * `thread_title:{conversation thread}`, the official internal sub-request
 * form (client.rs prompt_cache_key), so background calls share a cache
 * without joining the conversation's.
 */
export const CODEX_BACKGROUND_SOURCE = 'thread_title';

function identityPart(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (
    !trimmed ||
    Buffer.byteLength(trimmed) > 1024 ||
    /[\x00-\x1f\x7f]/.test(trimmed)
  )
    return;
  return trimmed;
}

function metadataSession(request: unknown): string | undefined {
  if (!request || typeof request !== 'object') return;
  const metadata = (request as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    return;
  const userId = (metadata as Record<string, unknown>).user_id;
  if (typeof userId !== 'string' || Buffer.byteLength(userId) > 8192) return;
  const suffix = /_session_([a-f0-9-]+)$/.exec(userId);
  if (suffix) return identityPart(suffix[1]);
  if (userId.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(userId);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return identityPart((parsed as Record<string, unknown>).session_id);
    } catch {
      // Opaque metadata is optional and never echoed or logged.
    }
  }
}

function uuidV5(identity: string): string {
  const bytes = createHash('sha1')
    .update(UUID_OID_NAMESPACE)
    .update(identity)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? '')
    .digest('hex');
}

function messagesOf(request: unknown): unknown[] {
  const messages =
    request && typeof request === 'object'
      ? (request as Record<string, unknown>).messages
      : undefined;
  return Array.isArray(messages) ? messages : [];
}

/**
 * A request whose last user message carries new user content starts a turn;
 * a message that returns tool results continues it, even when Claude Code
 * attaches reminders or queued input next to the results (the official client
 * also folds input that arrives mid-turn into the running turn).
 */
export function codexTurnBoundary(request: unknown): CodexTurnBoundary {
  const messages = messagesOf(request);
  const last = messages.at(-1) as Record<string, unknown> | undefined;
  if (!last || typeof last !== 'object' || last.role !== 'user')
    return { startsTurn: false, fingerprint: '' };
  const content = last.content;
  const returnsToolResults =
    Array.isArray(content) &&
    content.some(
      (block) =>
        !!block &&
        typeof block === 'object' &&
        (block as Record<string, unknown>).type === 'tool_result',
    );
  if (returnsToolResults) return { startsTurn: false, fingerprint: '' };
  return {
    startsTurn: true,
    fingerprint: digest([messages.length, content]),
  };
}

export interface CodexRequestIdentity {
  /** Official session id: one Claude Code session, or a background thread. */
  sessionId: string;
  /** Official thread id: the session's main agent, a sub-agent, or a background thread. */
  threadId: string;
  promptCacheKey: string;
  /** `session-id` header: the cache-affinity key (client.rs responses_session_id). */
  responsesSessionId: string;
  background: boolean;
  /** The Claude Code agent this thread belongs to ("main" for the session). */
  agentId: string;
}

/**
 * Derive the request's session/thread identity. Without an SDK session id
 * the identity falls back to the caller's scope (the runner grant) plus the
 * conversation's opening, so it is still deterministic for every request of
 * that conversation.
 */
export function codexRequestIdentity(
  incomingHeaders: Headers,
  request: unknown,
  scope: {
    providerId: string;
    accountId: string | null;
    fallbackScope: string;
  },
): CodexRequestIdentity {
  const claudeSession =
    identityPart(incomingHeaders.get('x-claude-code-session-id')) ??
    metadataSession(request);
  const agentId =
    identityPart(incomingHeaders.get('x-claude-code-agent-id')) ?? 'main';
  const sessionSeed = claudeSession
    ? ['claude-code', claudeSession]
    : [
        'fallback',
        scope.fallbackScope,
        digest([
          (request as Record<string, unknown> | null)?.system ?? null,
          messagesOf(request)[0] ?? null,
        ]),
      ];
  const sessionId = uuidV5(
    JSON.stringify([
      'happyclaw:codex:session',
      scope.providerId,
      scope.accountId,
      ...sessionSeed,
    ]),
  );
  const conversationThreadId =
    agentId === 'main'
      ? sessionId
      : uuidV5(
          JSON.stringify([
            'happyclaw:codex:thread',
            scope.providerId,
            scope.accountId,
            ...sessionSeed,
            agentId,
          ]),
        );
  if (
    request &&
    typeof request === 'object' &&
    isCodexBackgroundRequest(request as AnthropicRequestSubset)
  ) {
    const threadId = uuidV5(
      JSON.stringify([
        'happyclaw:codex:internal',
        CODEX_BACKGROUND_SOURCE,
        conversationThreadId,
      ]),
    );
    const promptCacheKey = `${CODEX_BACKGROUND_SOURCE}:${conversationThreadId}`;
    // A root thread of its own: it is its own session, and its session-id
    // header is its cache key (client.rs responses_session_id).
    return {
      sessionId: threadId,
      threadId,
      promptCacheKey,
      responsesSessionId: promptCacheKey,
      background: true,
      agentId,
    };
  }
  // Each Claude Code agent keeps its own cache key, so parallel sub-agents do
  // not crowd one cache shard; the main agent's key is the session id.
  return {
    sessionId,
    threadId: conversationThreadId,
    promptCacheKey: conversationThreadId,
    responsesSessionId: conversationThreadId,
    background: false,
    agentId,
  };
}

function headerValue(value: string | null | undefined): value is string {
  return !!value && value.length <= 4096 && /^[\x20-\x7e]+$/.test(value);
}

/**
 * core/src/responses_metadata.rs CodexTurnMetadataPayload, in field order,
 * limited to what HappyClaw knows. Every value is ASCII, so the JSON is the
 * official to_ascii_json_string form.
 */
function turnMetadataJson(fields: {
  installationId: string;
  identity: CodexRequestIdentity;
  turnId: string;
  windowId: string;
  turnStartedAtMs: number;
  model: string;
  reasoningEffort?: string;
}): string {
  const { identity } = fields;
  const root = identity.background || identity.agentId === 'main';
  return JSON.stringify({
    installation_id: fields.installationId,
    session_id: identity.sessionId,
    thread_id: identity.threadId,
    // AgentPath::root for a root thread; a sub-agent's path is unknown.
    ...(identity.background || identity.agentId === 'main'
      ? { agent_name: '/root' }
      : {}),
    turn_id: fields.turnId,
    window_id: fields.windowId,
    window_number: 0,
    request_kind: 'turn',
    // A root thread's turn is its own root turn; a sub-agent's root turn
    // belongs to the parent, which this request cannot see.
    ...(root ? { root_turn_id: fields.turnId } : {}),
    thread_source: identity.background
      ? CODEX_BACKGROUND_SOURCE
      : identity.agentId === 'main'
        ? 'user'
        : 'subagent',
    turn_started_at_unix_ms: fields.turnStartedAtMs,
    model: fields.model,
    ...(fields.reasoningEffort
      ? { reasoning_effort: fields.reasoningEffort }
      : {}),
  });
}

/**
 * The final upstream body: the converted request plus the gateway's cache key
 * and client metadata, serialized, then compressed like the official
 * client's default for ChatGPT auth (features EnableRequestCompression,
 * http-client request.rs: zstd level 3). Node without zlib zstd support
 * sends the body uncompressed.
 */
export function encodeCodexUpstreamBody(
  request: object,
  extras: { promptCacheKey: string; clientMetadata: Record<string, string> },
): { body: string | Uint8Array; contentEncoding?: 'zstd' } {
  // Official field order (model, stream, service_tier first, then the body,
  // prompt_cache_key before text, client_metadata last).
  const json = serializeCodexResponsesRequest(request as ResponsesRequest, {
    promptCacheKey: extras.promptCacheKey,
    clientMetadata: extras.clientMetadata,
  });
  if (typeof zlib.zstdCompressSync !== 'function') return { body: json };
  return {
    body: zlib.zstdCompressSync(Buffer.from(json), {
      params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
    }),
    contentEncoding: 'zstd',
  };
}

/**
 * Responses Lite is decided per request by the converter: every lite request
 * carries `reasoning.context: "all_turns"` and a classic one never does
 * (e.g. a request with hosted web search stays classic on a lite model).
 */
export function isCodexResponsesLiteRequest(request: object): boolean {
  const reasoning = (request as { reasoning?: unknown }).reasoning;
  return (
    !!reasoning &&
    typeof reasoning === 'object' &&
    (reasoning as Record<string, unknown>).context === 'all_turns'
  );
}

export interface CodexUpstreamAccess {
  providerId: string;
  accessToken: string;
  accountId: string | null;
  isFedramp?: boolean;
}

export interface CodexUpstreamRequest {
  headers: Record<string, string>;
  body: string | Uint8Array;
  identity: CodexRequestIdentity;
  turnId: string;
  /** Capture turn state and infrastructure cookies from the response. */
  observe(response: Response): void;
}

/**
 * Build one upstream attempt. Turn resolution is idempotent per request, so a
 * retry of the same request (401 refresh, transient retry) stays in its turn
 * and replays the turn state captured by an earlier attempt.
 */
export function buildCodexUpstreamRequest(input: {
  incomingHeaders: Headers;
  anthropicRequest: unknown;
  responsesRequest: { model: string; service_tier?: unknown };
  access: CodexUpstreamAccess;
  /** Deterministic scope for requests without an SDK session id. */
  fallbackScope: string;
}): CodexUpstreamRequest {
  const { access, responsesRequest } = input;
  const scope = codexTransportScope(access.providerId, access.accountId);
  const identity = codexRequestIdentity(
    input.incomingHeaders,
    input.anthropicRequest,
    {
      providerId: access.providerId,
      accountId: access.accountId,
      fallbackScope: input.fallbackScope,
    },
  );
  const turn = resolveCodexTurn(
    scope,
    identity.threadId,
    codexTurnBoundary(input.anthropicRequest),
  );
  const installationId = codexInstallationId();
  const windowId = `${identity.threadId}:0`;
  const reasoningEffort = (
    responsesRequest as { reasoning?: { effort?: unknown } }
  ).reasoning?.effort;
  const turnMetadata = turnMetadataJson({
    installationId,
    identity,
    turnId: turn.turnId,
    windowId,
    turnStartedAtMs: turn.startedAtMs,
    model: responsesRequest.model,
    reasoningEffort:
      typeof reasoningEffort === 'string' ? reasoningEffort : undefined,
  });
  const rootThread = identity.background || identity.agentId === 'main';

  const encoded = encodeCodexUpstreamBody(responsesRequest, {
    promptCacheKey: identity.promptCacheKey,
    clientMetadata: {
      'x-codex-installation-id': installationId,
      session_id: identity.sessionId,
      thread_id: identity.threadId,
      'x-codex-window-id': windowId,
      turn_id: turn.turnId,
      'x-codex-turn-metadata': turnMetadata,
      ...(rootThread ? { root_turn_id: turn.turnId } : {}),
    },
  });

  const model = responsesRequest.model;
  const tier =
    typeof responsesRequest.service_tier === 'string'
      ? responsesRequest.service_tier
      : undefined;
  const routingHint = `model=${model}${tier ? `;tier=${tier}` : ''}`;
  const cookie = codexCookieHeader(scope);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${access.accessToken}`,
    ...(headerValue(access.accountId)
      ? { 'ChatGPT-Account-ID': access.accountId }
      : {}),
    ...(access.isFedramp ? { 'X-OpenAI-Fedramp': 'true' } : {}),
    ...codexBackendClientHeaders(),
    'Content-Type': 'application/json',
    ...(encoded.contentEncoding
      ? { 'Content-Encoding': encoded.contentEncoding }
      : {}),
    Accept: 'text/event-stream',
    ...(CODEX_BETA_FEATURES.length
      ? { 'x-codex-beta-features': CODEX_BETA_FEATURES.join(',') }
      : {}),
    ...(turn.turnState ? { 'x-codex-turn-state': turn.turnState } : {}),
    'x-codex-window-id': windowId,
    'x-codex-turn-metadata': turnMetadata,
    ...(isCodexResponsesLiteRequest(responsesRequest)
      ? { 'x-openai-internal-codex-responses-lite': 'true' }
      : {}),
    'x-client-request-id': identity.threadId,
    'session-id': identity.responsesSessionId,
    'thread-id': identity.threadId,
    // Request model strings are opaque until the upstream validates them.
    // Never turn an oversized/non-ASCII body field into an invalid header.
    ...(headerValue(routingHint) && model.length <= 1024
      ? { 'x-codex-routing-hint': routingHint }
      : {}),
    ...(cookie ? { Cookie: cookie } : {}),
  };

  return {
    headers,
    body: encoded.body,
    identity,
    turnId: turn.turnId,
    observe(response) {
      storeCodexResponseCookies(scope, response.headers);
      if (response.ok)
        recordCodexTurnState(
          scope,
          identity.threadId,
          turn.turnId,
          response.headers,
        );
    },
  };
}
