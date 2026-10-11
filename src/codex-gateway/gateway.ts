// ─── ChatGPT/Codex 订阅网关 — Hono 子应用 ──────────────────────────
//
// 挂载在主服务 CODEX_GATEWAY_ROUTE 下，处理 Claude Agent SDK 会发出的
// POST {route}/v1/messages 与 /v1/messages/count_tokens。鉴权只接受
// Runner 级临时 token（runner-tokens.ts；SDK 把它当 ANTHROPIC_API_KEY 发送，
// 落在 x-api-key 头），且请求必须来自本机回环/私网地址、不带反代转发头。
// 真实 ChatGPT token 只在网关进程内部持有，不会下发给 Runner/容器。

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { logger } from '../logger.js';
import { getProviderById } from '../runtime-config.js';
import type { ReadableStreamReadResult } from 'node:stream/web';
import {
  anthropicToResponses,
  resolveCodexModel,
  resolveGatewayReasoningEffort,
  type AnthropicRequestSubset,
  type ResponsesRequest,
} from './convert-request.js';
import { getResolvedCodexCatalog } from './model-catalog-sync.js';
import {
  ResponsesToAnthropicConverter,
  assembleAnthropicMessage,
  CodexUpstreamError,
  describeUpstreamHttpFailure,
  isInvalidEncryptedContentFailure,
  upstreamFailureStatus,
  type AnthropicErrorType,
  type AnthropicStreamEvent,
  type CodexUpstreamFailure,
} from './convert-response.js';
import {
  CodexGatewayAuthError,
  CodexReauthRequiredError,
  CodexRefreshUnavailableError,
  resolveCodexAccess,
  type CodexAccessContext,
} from './token-manager.js';
import { CodexProviderRateLimiter } from './provider-rate-limit.js';
import {
  exhaustedWindowResetAt,
  quarantineCodexProviderUntil,
  recordCodexRateLimitEvent,
  recordCodexRateLimitHeaders,
} from './rate-limit-snapshot.js';
import {
  CodexMessagesRequestSchema,
  describeCodexRequestIssue,
} from './request-validation.js';
import { CODEX_BACKEND_RESPONSES_URL } from './types.js';
import { codexRequestContext } from './request-context.js';
import {
  resolveCodexGatewayToken,
  type CodexGatewayGrant,
  type CodexGatewayVerdict,
} from './runner-tokens.js';
import { rejectNonLocalGatewaySource } from './source-guard.js';
import { estimateCodexInputTokens } from './token-estimate.js';

interface CodexGatewayEnv {
  Bindings: {
    /** Set by @hono/node-server; absent bindings fail the source check. */
    incoming?: { socket?: { remoteAddress?: string } };
  };
  Variables: { codexGatewayGrant: CodexGatewayGrant };
}

export const codexGatewayApp = new Hono<CodexGatewayEnv>();

/** Upstream response headers deadline. */
const UPSTREAM_HEADERS_TIMEOUT_MS = 30_000;
/**
 * Silence allowed between upstream stream chunks. Matches the official Codex
 * CLI's stream_idle_timeout_ms (and CLIProxyAPI's Codex executor): a long
 * reasoning phase can legitimately go quiet for minutes.
 */
const UPSTREAM_STREAM_IDLE_TIMEOUT_MS = 300_000;
/** Whole-response cap for nonstream aggregation, the Anthropic SDK default. */
const AGGREGATE_DEADLINE_MS = 600_000;
const AGGREGATE_EVENT_BYTES_LIMIT = 32 * 1024 * 1024;
/** Bounded, time-limited read of an upstream error body. */
const ERROR_BODY_LIMIT_BYTES = 64 * 1024;
const ERROR_BODY_TIMEOUT_MS = 5_000;
/**
 * Streams hold back the handshake (message_start/ping and content blocks that
 * have no content yet) until content starts, so a failure reported before
 * any content becomes a real HTTP status rather than 200 + event: error.
 * Bounded like CLIProxyAPI's bootstrap buffering (48 frames, 1 MiB), plus a
 * time ceiling so slow reasoning still streams.
 */
const STREAM_BOOTSTRAP_MAX_EVENTS = 48;
const STREAM_BOOTSTRAP_MAX_BYTES = 1024 * 1024;
const STREAM_BOOTSTRAP_TIMEOUT_MS = 20_000;
/**
 * A released stream sends `event: ping` after this much downstream silence.
 * Claude Code's idle watchdog for custom base URLs counts pings as chunks, so
 * a long upstream reasoning phase does not trip it (magpie keepaliveEvery).
 */
const STREAM_KEEPALIVE_INTERVAL_MS = 15_000;
/**
 * Official HTTP retry policy (model-provider-info request_max_retries and
 * codex-client retry.rs): 5xx and transport failures retry up to four times
 * with 200 ms exponential backoff, honoring Retry-After; 429 is not retried.
 * Retries end once they would push the exchange past the window.
 */
const UPSTREAM_MAX_RETRIES = 4;
const UPSTREAM_RETRY_BASE_DELAY_MS = 200;
const UPSTREAM_RETRY_WINDOW_MS = 60_000;
/** Follow-up requests folded into one message for end_turn: false. */
const MAX_FOLLOW_UPS = 4;

const PING_EVENT: AnthropicStreamEvent = {
  event: 'ping',
  data: { type: 'ping' },
};

function sseEncode(event: AnthropicStreamEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/** The upstream stream stayed silent past its idle deadline. */
class UpstreamStallError extends Error {
  constructor() {
    super('Upstream Codex stream stalled');
    this.name = 'UpstreamStallError';
  }
}

/** The upstream broke a local framing bound; a retry would break it again. */
class UpstreamFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamFramingError';
  }
}

// Authenticate before allocating counters or reading a request body. Windows
// are keyed by runner grant, so a busy runner cannot starve the others that
// share its provider.
const providerRateLimiter = new CodexProviderRateLimiter();
const requestBodyLimit = bodyLimit({
  maxSize: 32 * 1024 * 1024,
  onError: (c) =>
    c.json(
      {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Payload too large' },
      },
      413,
    ),
});

function errorResponse(
  c: Context<CodexGatewayEnv>,
  status: number,
  type: AnthropicErrorType,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return c.json(
    { type: 'error', error: { type, message } },
    (status >= 400 && status < 600 ? status : 502) as ContentfulStatusCode,
    headers,
  );
}

function grantLogContext(grant: CodexGatewayGrant): Record<string, unknown> {
  return {
    providerId: grant.providerId,
    runnerGrant: grant.id,
    runnerKind: grant.owner.kind,
    groupFolder: grant.owner.groupFolder ?? null,
    agentId: grant.owner.agentId ?? null,
  };
}

/** 成功代理请求的轻量审计日志：只记模型与 token 用量，不记消息内容。 */
function logGatewaySuccess(
  grant: CodexGatewayGrant,
  model: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
  },
  extra: Record<string, unknown> = {},
): void {
  logger.info(
    {
      ...grantLogContext(grant),
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens,
      ...extra,
    },
    'Codex gateway: request proxied',
  );
}

/** Upstream request identifiers worth a log line on failures (api_bridge.rs). */
function upstreamTrace(headers: Headers | undefined): Record<string, string> {
  const trace: Record<string, string> = {};
  const requestId =
    headers?.get('x-request-id') ?? headers?.get('x-oai-request-id');
  const cfRay = headers?.get('cf-ray');
  if (requestId) trace.upstreamRequestId = requestId.slice(0, 128);
  if (cfRay) trace.cfRay = cfRay.slice(0, 128);
  return trace;
}

function extractGatewayToken(headers: Headers): string | null {
  const apiKey = headers.get('x-api-key');
  if (apiKey) return apiKey.trim();
  const auth = headers.get('authorization');
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }
  return null;
}

function upstreamRetryHeaders(headers: Headers): Record<string, string> {
  const retryAfter = headers.get('retry-after')?.trim();
  if (
    retryAfter &&
    retryAfter.length <= 128 &&
    (/^\d+(?:\.\d+)?$/.test(retryAfter) ||
      (/GMT$/.test(retryAfter) && Number.isFinite(Date.parse(retryAfter))))
  ) {
    return { 'Retry-After': retryAfter };
  }
  return {};
}

/** Retry-After as a delay: delay-seconds or an HTTP date (RetryAfter::from_header). */
function upstreamRetryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after')?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** codex-client retry.rs backoff(): base · 2^(attempt-1), ±10% jitter. */
function retryBackoffMs(attempt: number): number {
  return Math.round(
    UPSTREAM_RETRY_BASE_DELAY_MS *
      2 ** (attempt - 1) *
      (0.9 + Math.random() * 0.2),
  );
}

function delayUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Retry hints for a classified failure. Limits that only clear after more
 * than a minute (usage windows, plans without Codex) are surfaced at once:
 * x-should-retry: false stops Claude Code's own retry loop from re-sending
 * the request to an upstream that will refuse it again.
 */
function failureHeaders(
  failure: Pick<CodexUpstreamFailure, 'retryAfterSeconds' | 'noRetry'>,
  upstreamHeaders?: Headers,
): Record<string, string> {
  const headers = upstreamHeaders ? upstreamRetryHeaders(upstreamHeaders) : {};
  if (failure.retryAfterSeconds !== undefined) {
    headers['Retry-After'] = String(
      Math.max(1, Math.ceil(failure.retryAfterSeconds)),
    );
  }
  if (failure.noRetry || (failure.retryAfterSeconds ?? 0) > 60) {
    headers['x-should-retry'] = 'false';
  }
  return headers;
}

/**
 * A failure the gateway answers: a real HTTP status while nothing reached the
 * client, an `event: error` once the stream is released.
 */
interface GatewayFailure {
  failure: CodexUpstreamFailure;
  headers: Record<string, string>;
  verdict: CodexGatewayVerdict;
  trace?: Record<string, string>;
}

function isGatewayFailure(value: object): value is GatewayFailure {
  return 'failure' in value;
}

function upstreamGatewayFailure(
  failure: CodexUpstreamFailure,
  upstreamHeaders?: Headers,
): GatewayFailure {
  return {
    failure,
    headers: failureHeaders(failure, upstreamHeaders),
    verdict: 'upstream_failure',
    trace: upstreamTrace(upstreamHeaders),
  };
}

function failureResponse(
  c: Context<CodexGatewayEnv>,
  { failure, headers }: GatewayFailure,
): Response {
  return errorResponse(
    c,
    upstreamFailureStatus(failure),
    failure.type,
    failure.message,
    headers,
  );
}

/**
 * Resolve upstream access for a grant, mapping token-manager failures to
 * Anthropic errors: a dead refresh grant is an authentication error telling
 * the user to log in again; a refresh in backoff is a retryable 503.
 */
async function resolveAccessOrFailure(
  grant: CodexGatewayGrant,
  rejectedAccessToken?: string,
): Promise<CodexAccessContext | GatewayFailure> {
  try {
    return await resolveCodexAccess(
      grant.providerId,
      rejectedAccessToken ? { rejectedAccessToken } : {},
    );
  } catch (err) {
    if (err instanceof CodexRefreshUnavailableError) {
      return {
        failure: {
          type: 'api_error',
          code: null,
          message: err.message,
          status: 503,
        },
        headers: {
          'Retry-After': String(
            Math.max(1, Math.ceil(err.retryAfterMs / 1000)),
          ),
        },
        verdict: 'local_transient',
      };
    }
    if (err instanceof CodexReauthRequiredError) {
      logger.warn(
        grantLogContext(grant),
        'Codex gateway: ChatGPT login must be renewed',
      );
      return {
        failure: {
          type: 'authentication_error',
          code: null,
          message: err.message,
          status: 401,
          noRetry: true,
        },
        headers: { 'x-should-retry': 'false' },
        verdict: 'reauth_required',
      };
    }
    logger.warn(
      { ...grantLogContext(grant), err },
      'Codex gateway: auth failed',
    );
    return {
      failure: {
        type: 'authentication_error',
        code: null,
        message:
          err instanceof CodexGatewayAuthError
            ? err.message
            : 'Codex authentication failed',
        status: 401,
      },
      headers: {},
      verdict: 'upstream_failure',
    };
  }
}

/** Read at most ERROR_BODY_LIMIT_BYTES of an error body, then drop the rest. */
async function readBoundedErrorBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = setTimeout(() => {
    void reader.cancel().catch(() => {});
  }, ERROR_BODY_TIMEOUT_MS);
  try {
    while (size < ERROR_BODY_LIMIT_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    // A stalled or reset error body still classifies from what arrived.
  } finally {
    clearTimeout(deadline);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks)
    .subarray(0, ERROR_BODY_LIMIT_BYTES)
    .toString('utf8');
}

const UPSTREAM_EVENT_LIMIT = 8 * 1024 * 1024;
const TERMINAL_EVENT_TYPES = new Set([
  'response.completed',
  'response.done',
  'response.incomplete',
  'response.failed',
  'error',
]);

/**
 * Parse bounded SSE frames across arbitrary UTF-8 chunks and line endings.
 * A frame whose data is not a JSON event object is skipped and reported to
 * `onInvalidFrame`, as the official client logs and skips it.
 */
async function* iterateUpstreamEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onInvalidFrame: () => void,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let lineParts: string[] = [];
  let lineBytes = 0;
  let skipLf = false;
  let eventName = '';
  let dataParts: string[] = [];
  let eventBytes = 0;
  let terminalSeen = false;
  let reachedEof = false;
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();

  const flush = function* (): Generator<Record<string, unknown>> {
    const data = dataParts.join('\n');
    const name = eventName;
    const hasData = dataParts.length > 0;
    // Even a comment-only/event-only frame resets its event name.
    eventName = '';
    dataParts = [];
    eventBytes = 0;
    // Empty data frames are valid keepalives, not malformed JSON events.
    if (!hasData || !data.trim()) return;
    if (data.trim() === '[DONE]') {
      // The sentinel ends framing, but never replaces a Responses terminal.
      terminalSeen = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      // SyntaxError messages can quote private upstream data; the frame is
      // only counted, never logged.
      onInvalidFrame();
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      onInvalidFrame();
      return;
    }
    const event = parsed as Record<string, unknown>;
    if (event.type === undefined && name) event.type = name;
    if (event.type !== undefined && typeof event.type !== 'string') {
      onInvalidFrame();
      return;
    }
    terminalSeen = TERMINAL_EVENT_TYPES.has(String(event.type));
    yield event;
  };

  const consumeLine = function* (
    line: string,
  ): Generator<Record<string, unknown>> {
    if (line === '') {
      yield* flush();
      return;
    }
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      eventName = value;
    } else if (field === 'data') {
      eventBytes += Buffer.byteLength(value) + (dataParts.length ? 1 : 0);
      if (eventBytes > UPSTREAM_EVENT_LIMIT) {
        throw new UpstreamFramingError(
          'Upstream Codex SSE event exceeds size limit',
        );
      }
      dataParts.push(value);
    }
  };

  const consumeText = function* (
    text: string,
  ): Generator<Record<string, unknown>> {
    let start = 0;
    const endings = /[\r\n]/g;
    for (let match; (match = endings.exec(text)); ) {
      if (skipLf && match.index === start && match[0] === '\n') {
        skipLf = false;
        start = match.index + 1;
        continue;
      }
      skipLf = false;
      const part = text.slice(start, match.index);
      lineBytes += Buffer.byteLength(part);
      if (lineBytes > UPSTREAM_EVENT_LIMIT) {
        throw new UpstreamFramingError(
          'Upstream Codex SSE line exceeds size limit',
        );
      }
      lineParts.push(part);
      const line = lineParts.join('');
      lineParts = [];
      lineBytes = 0;
      start = match.index + 1;
      skipLf = match[0] === '\r';
      yield* consumeLine(line);
      if (terminalSeen) return;
    }
    if (start < text.length) {
      skipLf = false;
      const part = text.slice(start);
      lineBytes += Buffer.byteLength(part);
      if (lineBytes > UPSTREAM_EVENT_LIMIT) {
        throw new UpstreamFramingError(
          'Upstream Codex SSE line exceeds size limit',
        );
      }
      lineParts.push(part);
    }
  };

  try {
    for (;;) {
      signal.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Reject before cancelling: the cancel also settles the pending
          // read, and the race must report a stall rather than an EOF.
          reject(new UpstreamStallError());
          void reader.cancel().catch(() => {});
        }, UPSTREAM_STREAM_IDLE_TIMEOUT_MS);
      });
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([reader.read(), timeout]);
      } finally {
        clearTimeout(timer);
      }
      signal.throwIfAborted();
      const { value, done } = result;
      if (done) {
        reachedEof = true;
        break;
      }
      yield* consumeText(decoder.decode(value, { stream: true }));
      // A semantic terminal is authoritative even if the peer keeps the HTTP
      // body open. Do not wait for EOF or append a timeout after message_stop.
      if (terminalSeen) return;
    }
    // 上游兼容性：EOF 时保留未被空行终止的最后一行。上游可能不发结尾
    // 空行——丢掉它会把成功的 response.completed 误判成断流失败。
    yield* consumeText(decoder.decode());
    if (lineParts.length) yield* consumeLine(lineParts.join(''));
    yield* flush();
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!reachedEof) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Anthropic events that carry no content yet. Holding them back keeps a real
 * HTTP status available, so an announced but still empty reasoning, text or
 * tool block does not end the handshake (CLIProxyAPI bootstrap buffering).
 */
function isHandshakeEvent({ event, data }: AnthropicStreamEvent): boolean {
  if (event === 'message_start' || event === 'ping') return true;
  if (event === 'content_block_start') {
    const block = (data.content_block ?? {}) as Record<string, unknown>;
    if (block.type === 'thinking') return !block.thinking;
    if (block.type === 'text') return !block.text;
    return block.type === 'tool_use';
  }
  if (event === 'content_block_delta') {
    const delta = (data.delta ?? {}) as Record<string, unknown>;
    return (
      (delta.type === 'input_json_delta' && !delta.partial_json) ||
      (delta.type === 'text_delta' && !delta.text) ||
      (delta.type === 'thinking_delta' && !delta.thinking)
    );
  }
  return false;
}

/** Source checks, then a live runner token. Runs before any body is read. */
async function authenticateRunner(
  c: Context<CodexGatewayEnv>,
  next: () => Promise<void>,
): Promise<Response | void> {
  const sourceRejection = rejectNonLocalGatewaySource(
    c.req.raw.headers,
    c.env?.incoming?.socket?.remoteAddress,
  );
  if (sourceRejection) {
    return errorResponse(c, 403, 'permission_error', sourceRejection);
  }
  const gatewayToken = extractGatewayToken(c.req.raw.headers);
  if (!gatewayToken) {
    return errorResponse(c, 401, 'authentication_error', 'Missing API key');
  }
  const grant = resolveCodexGatewayToken(gatewayToken);
  if (!grant) {
    return errorResponse(
      c,
      401,
      'authentication_error',
      'Unknown or expired Codex gateway token',
    );
  }
  c.set('codexGatewayGrant', grant);
  await next();
}

async function limitRunnerRate(
  c: Context<CodexGatewayEnv>,
  next: () => Promise<void>,
): Promise<Response | void> {
  const grant = c.get('codexGatewayGrant');
  if (providerRateLimiter.isLimited(grant.id)) {
    // A throttle HappyClaw applies to itself is no verdict on the account;
    // the host reads this verdict to keep the provider out of quarantine.
    grant.lastVerdict = 'local_transient';
    logger.warn(
      grantLogContext(grant),
      'Codex gateway: runner rate limit exceeded',
    );
    return errorResponse(
      c,
      429,
      'rate_limit_error',
      'HappyClaw Codex gateway local rate limit exceeded for this runner, retry later',
      {
        'Retry-After': String(
          Math.max(
            1,
            Math.ceil(providerRateLimiter.retryAfterMs(grant.id) / 1000),
          ),
        ),
      },
    );
  }
  await next();
}

async function parseMessagesRequest(
  c: Context<CodexGatewayEnv>,
): Promise<AnthropicRequestSubset | Response> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return errorResponse(c, 400, 'invalid_request_error', 'Invalid JSON body');
  }
  const validation = CodexMessagesRequestSchema.safeParse(raw);
  if (!validation.success) {
    return errorResponse(
      c,
      400,
      'invalid_request_error',
      describeCodexRequestIssue(validation.error),
    );
  }
  return validation.data;
}

// Claude Code calls this for context accounting. The Codex backend has no
// equivalent, so estimate locally (see token-estimate.ts); no upstream call.
codexGatewayApp.post(
  '/v1/messages/count_tokens',
  authenticateRunner,
  requestBodyLimit,
  async (c) => {
    const parsed = await parseMessagesRequest(c);
    if (parsed instanceof Response) return parsed;
    const grant = c.get('codexGatewayGrant');
    const provider = getProviderById(grant.providerId);
    const model = resolveCodexModel(
      parsed.model,
      resolveCodexModel(undefined, provider?.anthropicModel || ''),
    );
    const converted = anthropicToResponses(parsed, { targetModel: model });
    return c.json({ input_tokens: estimateCodexInputTokens(converted) });
  },
);

codexGatewayApp.post(
  '/v1/messages',
  authenticateRunner,
  limitRunnerRate,
  requestBodyLimit,
  async (c) => {
    const parsed = await parseMessagesRequest(c);
    if (parsed instanceof Response) return parsed;
    const anthropicRequest = parsed;
    const wantsStream = (parsed as { stream?: boolean }).stream !== false;
    const grant = c.get('codexGatewayGrant');
    const logContext = grantLogContext(grant);

    const resolvedAccess = await resolveAccessOrFailure(grant);
    if (isGatewayFailure(resolvedAccess)) {
      grant.lastVerdict = resolvedAccess.verdict;
      return failureResponse(c, resolvedAccess);
    }
    let access = resolvedAccess;

    const provider = getProviderById(access.providerId);
    const targetModel = resolveCodexModel(
      undefined,
      provider?.anthropicModel || '',
    );
    const requestModel = resolveCodexModel(anthropicRequest.model, targetModel);
    const responsesRequest = anthropicToResponses(anthropicRequest, {
      targetModel: requestModel,
      // 目录钳制：存量配置里被上游移除的 effort 档（如 minimal）或模型不支持
      // 的档位在请求侧归位，避免上游 400；与前端切模型归位逻辑语义一致。
      // 目录用解析后的实时目录（上游同步结果优先，baked-in 兜底）。
      reasoningEffort: resolveGatewayReasoningEffort(anthropicRequest, {
        catalog: getResolvedCodexCatalog().models,
        model: requestModel,
        providerEffort: provider?.customEnv?.CODEX_REASONING_EFFORT,
        agentEffort: grant.owner.agentEffort,
      }),
      requestTools: !!anthropicRequest.tools?.length,
    });

    // `let`: a headers-timeout abort ends one attempt; a retry renews it.
    let controller = new AbortController();
    let clientCancelled = false;
    const onClientAbort = () => {
      clientCancelled = true;
      controller.abort();
    };
    c.req.raw.signal.addEventListener('abort', onClientAbort, { once: true });
    if (c.req.raw.signal.aborted) onClientAbort();
    const cleanup = () =>
      c.req.raw.signal.removeEventListener('abort', onClientAbort);

    // `payload` defaults to the translated request. The response side passes
    // a variant whose `input` differs for reasoning-strip retries and
    // end_turn: false follow-ups; everything else stays request-side.
    const sendUpstream = async (
      current: CodexAccessContext,
      payload: ResponsesRequest = responsesRequest,
    ): Promise<Response> => {
      const requestContext = codexRequestContext(c.req.raw.headers, parsed, {
        providerId: current.providerId,
        accountId: current.accountId,
        model: responsesRequest.model,
        serviceTier: responsesRequest.service_tier,
      });
      const headersTimeout = setTimeout(
        () => controller.abort(),
        UPSTREAM_HEADERS_TIMEOUT_MS,
      );
      try {
        return await fetch(CODEX_BACKEND_RESPONSES_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${current.accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...(current.accountId
              ? { 'chatgpt-account-id': current.accountId }
              : {}),
            ...requestContext.headers,
          },
          body: JSON.stringify({
            ...payload,
            ...(requestContext.promptCacheKey
              ? { prompt_cache_key: requestContext.promptCacheKey }
              : {}),
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(headersTimeout);
      }
    };

    // ── Upstream attempts ──────────────────────────────────────────────
    /** Retry budget of the current upstream request (official per request). */
    const retryBudget = { retries: 0, startedAt: Date.now() };
    /** Nonstream aggregation passed its whole-response deadline. */
    let deadlineReached = false;
    let refreshedAfter401 = false;
    let reasoningStripped = false;
    let baseInput = responsesRequest.input;
    /** Output items of earlier responses, replayed by follow-ups. */
    const replayItems: Array<Record<string, unknown>> = [];
    const clientGone = () => new Error('Client cancelled the Codex request');

    /** Delay before the next transport/5xx retry, or null when spent. */
    const nextRetryDelay = (advisedMs?: number): number | null => {
      if (retryBudget.retries >= UPSTREAM_MAX_RETRIES) return null;
      const delay = advisedMs ?? retryBackoffMs(retryBudget.retries + 1);
      if (Date.now() - retryBudget.startedAt + delay > UPSTREAM_RETRY_WINDOW_MS)
        return null;
      retryBudget.retries += 1;
      return delay;
    };
    const waitForRetry = async (delay: number): Promise<void> => {
      await delayUnlessAborted(delay, c.req.raw.signal);
      if (clientCancelled) throw clientGone();
      if (deadlineReached) throw new UpstreamStallError();
      if (controller.signal.aborted) controller = new AbortController();
    };
    const currentPayload = (): ResponsesRequest =>
      baseInput === responsesRequest.input && !replayItems.length
        ? responsesRequest
        : { ...responsesRequest, input: [...baseInput, ...replayItems] };
    /** invalid_encrypted_content: drop replayed reasoning once and retry. */
    const stripReplayedReasoning = (): boolean => {
      if (
        reasoningStripped ||
        !baseInput.some((item) => item.type === 'reasoning')
      )
        return false;
      reasoningStripped = true;
      baseInput = baseInput.filter((item) => item.type !== 'reasoning');
      logger.warn(
        logContext,
        'Codex gateway: upstream could not verify replayed reasoning; retrying without it',
      );
      return true;
    };

    /**
     * Open one upstream response, applying the official HTTP retry policy,
     * a single forced refresh on 401 and the reasoning strip. Throws only
     * when the client went away.
     */
    const openUpstream = async (): Promise<
      { response: Response } | GatewayFailure
    > => {
      for (;;) {
        let upstream: Response;
        try {
          upstream = await sendUpstream(access, currentPayload());
        } catch (err) {
          if (clientCancelled) throw err;
          // A headers deadline aborts the shared controller or only the
          // attempt's own signal; either way the attempt timed out.
          const timedOut =
            controller.signal.aborted ||
            (err instanceof Error &&
              (err.name === 'AbortError' || err.name === 'TimeoutError'));
          const delay = nextRetryDelay();
          logger.warn(
            { ...logContext, err, timedOut, retrying: delay !== null },
            'Codex gateway: upstream request failed',
          );
          if (delay !== null) {
            await waitForRetry(delay);
            continue;
          }
          return {
            failure: {
              type: 'api_error',
              code: null,
              message: timedOut
                ? 'Upstream Codex request timed out'
                : 'Upstream Codex request failed',
              status: timedOut ? 504 : 502,
            },
            headers: {},
            verdict: 'upstream_failure',
          };
        }
        recordCodexRateLimitHeaders(access.providerId, upstream.headers, {
          ok: upstream.ok,
        });
        // An access token can be revoked before its recorded expiry. Refresh
        // once (single-flight, shared with concurrent requests) and retry.
        if (upstream.status === 401) {
          await upstream.body?.cancel().catch(() => {});
          if (!refreshedAfter401) {
            refreshedAfter401 = true;
            const refreshed = await resolveAccessOrFailure(
              grant,
              access.accessToken,
            );
            if (isGatewayFailure(refreshed)) return refreshed;
            access = refreshed;
            continue;
          }
          // The account rejected a token it just issued: retrying refreshes
          // again and again, only a new login can help.
          return {
            failure: {
              type: 'authentication_error',
              code: null,
              message:
                'ChatGPT 拒绝了刚刷新的访问令牌，账号可能已被停用或登出。请在「模型配置」中重新登录 ChatGPT。',
              status: 401,
              noRetry: true,
            },
            headers: { 'x-should-retry': 'false' },
            verdict: 'reauth_required',
            trace: upstreamTrace(upstream.headers),
          };
        }
        if (upstream.ok && upstream.body) return { response: upstream };
        const bodyText = await readBoundedErrorBody(upstream);
        const failure = describeUpstreamHttpFailure(upstream.status, bodyText);
        if (upstream.status >= 500) {
          const delay = nextRetryDelay(upstreamRetryAfterMs(upstream.headers));
          if (delay !== null) {
            logger.warn(
              {
                ...logContext,
                status: upstream.status,
                code: failure.code,
                retryInMs: delay,
                ...upstreamTrace(upstream.headers),
              },
              'Codex gateway: upstream server error; retrying',
            );
            await waitForRetry(delay);
            continue;
          }
        }
        if (
          isInvalidEncryptedContentFailure(failure) &&
          stripReplayedReasoning()
        )
          continue;
        return upstreamGatewayFailure(failure, upstream.headers);
      }
    };

    /** Record the verdict of a failed exchange, once. */
    const noteFailure = (outcome: GatewayFailure, message: string): void => {
      grant.lastVerdict = outcome.verdict;
      const { failure } = outcome;
      if (failure.usageLimitReached) {
        const resetsAt =
          failure.resetsAt ?? exhaustedWindowResetAt(access.providerId);
        if (resetsAt) quarantineCodexProviderUntil(access.providerId, resetsAt);
      }
      logger.warn(
        {
          ...logContext,
          status: upstreamFailureStatus(failure),
          code: failure.code,
          errorType: failure.type,
          ...outcome.trace,
        },
        message,
      );
    };

    let initial: { response: Response } | GatewayFailure;
    try {
      initial = await openUpstream();
    } catch {
      // The client went away while the request was being sent.
      cleanup();
      return errorResponse(
        c,
        502,
        'api_error',
        'Upstream Codex request failed',
      );
    }
    if (isGatewayFailure(initial)) {
      cleanup();
      noteFailure(initial, 'Codex gateway: upstream rejected request');
      return failureResponse(c, initial);
    }

    // ── Exchange: upstream responses → one Anthropic message ───────────
    const conversionOptions = {
      tools: anthropicRequest.tools,
      inputTokenEstimate: estimateCodexInputTokens(responsesRequest),
      maxFollowUps: MAX_FOLLOW_UPS,
    };
    let upstream = initial.response;
    // The served model (openai-model) names the message until the stream
    // reports its own.
    const newConverter = () =>
      new ResponsesToAnthropicConverter(
        upstream.headers.get('openai-model')?.trim().slice(0, 128) ||
          responsesRequest.model,
        conversionOptions,
      );
    let converter = newConverter();
    let invalidFrames = 0;
    const onInvalidFrame = () => {
      invalidFrames += 1;
      // Bounded logging: the first skipped frame and every power of two.
      if ((invalidFrames & (invalidFrames - 1)) === 0)
        logger.warn(
          { ...logContext, invalidFrames, ...upstreamTrace(upstream.headers) },
          'Codex gateway: skipped an upstream SSE frame that is not a JSON event',
        );
    };
    const attach = (response: Response) =>
      iterateUpstreamEvents(response.body!, controller.signal, onInvalidFrame);
    let upstreamEvents = attach(upstream);
    let pendingRead: Promise<IteratorResult<Record<string, unknown>>> | null =
      null;
    const pendingEvents: AnthropicStreamEvent[] = [];
    let exchangeDone = false;
    let prematureEof = false;
    /** A follow-up that could not be opened ended the message. */
    let followUpFailure: GatewayFailure | null = null;
    let followUps = 0;
    let measureEvents = true;
    let consumedEvents = 0;
    let consumedBytes = 0;

    /** Advance by one upstream event, a follow-up request, or EOF. */
    const pump = async (): Promise<void> => {
      const followUp = converter.pendingFollowUp();
      if (followUp) {
        await upstreamEvents.return(undefined).catch(() => {});
        replayItems.push(...followUp);
        followUps += 1;
        retryBudget.retries = 0;
        retryBudget.startedAt = Date.now();
        logger.info(
          { ...logContext, followUp: followUps },
          'Codex gateway: upstream ended the response but not the turn; following up',
        );
        const opened = await openUpstream();
        if (isGatewayFailure(opened)) {
          followUpFailure = opened;
          pendingEvents.push(...converter.fail(opened.failure));
          exchangeDone = true;
          return;
        }
        upstream = opened.response;
        upstreamEvents = attach(upstream);
        converter.beginFollowUp();
        return;
      }
      const next = await (pendingRead ??= upstreamEvents.next());
      pendingRead = null;
      if (next.done) {
        const tail = converter.finish();
        prematureEof = tail.length > 0;
        pendingEvents.push(...tail);
        exchangeDone = true;
        return;
      }
      if (measureEvents) {
        consumedEvents += 1;
        consumedBytes += Buffer.byteLength(JSON.stringify(next.value));
      }
      if (next.value.type === 'codex.rate_limits')
        recordCodexRateLimitEvent(access.providerId, next.value);
      pendingEvents.push(...converter.handleEvent(next.value));
    };

    // Bootstrap and the stream body share one in-flight step: a step the
    // bootstrap budget stopped waiting for is resumed, never restarted.
    let inflight: Promise<void> | null = null;
    const step = (): Promise<void> => (inflight ??= pump());
    const consumeStep = async (): Promise<void> => {
      try {
        await step();
      } finally {
        inflight = null;
      }
    };

    const exchangeFailure = (): GatewayFailure | null => {
      if (followUpFailure) return followUpFailure;
      const failure = converter.getFailure();
      return failure ? upstreamGatewayFailure(failure, upstream.headers) : null;
    };
    let settled = false;
    /** Log and record the verdict once the exchange has ended. */
    const settle = (): void => {
      if (settled) return;
      settled = true;
      const failure = exchangeFailure();
      if (failure) {
        noteFailure(failure, 'Codex gateway: upstream reported failure');
        return;
      }
      grant.lastVerdict = 'ok';
      logGatewaySuccess(grant, responsesRequest.model, converter.getUsage(), {
        ...(followUps ? { followUps } : {}),
        ...(invalidFrames ? { invalidFrames } : {}),
      });
    };

    /**
     * Nothing reached the client yet, so a failure a fresh attempt can fix
     * restarts the exchange: unverifiable replayed reasoning is stripped once
     * and a dropped stream spends the transport retry budget. Resolves to
     * true after a restart, or to the failure that now stands.
     */
    const restartBeforeContent = async (
      thrown?: unknown,
    ): Promise<true | GatewayFailure | null> => {
      let delay: number | null = null;
      if (thrown === undefined) {
        const failure = converter.getFailure();
        if (
          !followUpFailure &&
          failure &&
          isInvalidEncryptedContentFailure(failure) &&
          stripReplayedReasoning()
        )
          delay = 0;
        else if (prematureEof) delay = nextRetryDelay();
      } else if (
        !clientCancelled &&
        !controller.signal.aborted &&
        !(thrown instanceof CodexUpstreamError) &&
        !(thrown instanceof UpstreamStallError) &&
        !(thrown instanceof UpstreamFramingError)
      ) {
        delay = nextRetryDelay();
      }
      if (delay === null) return null;
      logger.warn(
        {
          ...logContext,
          retryInMs: delay,
          ...(thrown !== undefined ? { err: thrown } : {}),
          ...upstreamTrace(upstream.headers),
        },
        'Codex gateway: upstream stream failed before content; retrying',
      );
      await upstreamEvents.return(undefined).catch(() => {});
      if (delay > 0) await waitForRetry(delay);
      replayItems.length = 0;
      followUps = 0;
      const reopened = await openUpstream();
      if (isGatewayFailure(reopened)) return reopened;
      upstream = reopened.response;
      upstreamEvents = attach(upstream);
      pendingRead = null;
      converter = newConverter();
      pendingEvents.length = 0;
      exchangeDone = false;
      prematureEof = false;
      consumedEvents = 0;
      consumedBytes = 0;
      return true;
    };

    if (!wantsStream) {
      // 非流式聚合需要一个整体上限：空闲超时只限制块间间隔，慢滴上游可以
      // 无限拖住请求和 events 数组。上限对齐 Anthropic SDK 客户端默认 10 分钟。
      const deadline = setTimeout(() => {
        deadlineReached = true;
        controller.abort();
      }, AGGREGATE_DEADLINE_MS);
      try {
        for (;;) {
          try {
            while (!exchangeDone) {
              await consumeStep();
              if (consumedBytes > AGGREGATE_EVENT_BYTES_LIMIT) {
                throw new UpstreamFramingError(
                  'Upstream Codex response exceeds aggregation limit',
                );
              }
            }
          } catch (err) {
            if (deadlineReached) throw err;
            const restarted = await restartBeforeContent(err);
            if (restarted === true) continue;
            if (restarted) {
              noteFailure(
                restarted,
                'Codex gateway: upstream rejected request',
              );
              return failureResponse(c, restarted);
            }
            throw err;
          }
          const failure = exchangeFailure();
          if (!failure) break;
          const restarted = await restartBeforeContent();
          if (restarted === true) continue;
          const standing = restarted ?? failure;
          noteFailure(standing, 'Codex gateway: upstream reported failure');
          return failureResponse(c, standing);
        }
        const aggregated = assembleAnthropicMessage(
          pendingEvents,
          converter,
          responsesRequest.model,
        );
        settle();
        return c.json({
          id: aggregated.id,
          type: 'message',
          role: 'assistant',
          model: aggregated.model,
          content: aggregated.content,
          stop_reason: aggregated.stopReason,
          stop_sequence: aggregated.stopSequence ?? null,
          usage: aggregated.usage,
        });
      } catch (err) {
        controller.abort();
        await upstreamEvents.return(undefined).catch(() => {});
        if (err instanceof CodexUpstreamError) {
          noteFailure(
            upstreamGatewayFailure(
              {
                type: err.errorType,
                code: err.code,
                message: err.message,
                status: err.status,
                retryAfterSeconds: err.retryAfterSeconds,
                noRetry: err.noRetry,
              },
              upstream.headers,
            ),
            'Codex gateway: upstream reported failure',
          );
          return errorResponse(
            c,
            err.status,
            err.errorType,
            err.message,
            failureHeaders(err, upstream.headers),
          );
        }
        // The stall deadline, the aggregation deadline and a client that
        // left all end the wait: a timeout, never an upstream verdict.
        const timedOut =
          err instanceof UpstreamStallError ||
          deadlineReached ||
          clientCancelled ||
          (err instanceof Error && err.name === 'AbortError');
        if (!clientCancelled) {
          grant.lastVerdict = 'upstream_failure';
          logger.warn(
            { ...logContext, err, ...upstreamTrace(upstream.headers) },
            'Codex gateway: upstream stream failed',
          );
        }
        return errorResponse(
          c,
          timedOut ? 504 : 502,
          'api_error',
          timedOut
            ? 'Upstream Codex stream timed out'
            : 'Upstream Codex stream failed',
        );
      } finally {
        clearTimeout(deadline);
        cleanup();
      }
    }

    const bootstrapDeadline = Date.now() + STREAM_BOOTSTRAP_TIMEOUT_MS;
    /** Wait for the in-flight step up to `ms`; false when the wait ran out. */
    const stepWithin = async (ms: number): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const completed = await Promise.race([
        step().then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]).finally(() => clearTimeout(timer));
      if (completed) inflight = null;
      return completed;
    };
    try {
      while (
        !exchangeDone &&
        pendingEvents.every(isHandshakeEvent) &&
        consumedEvents < STREAM_BOOTSTRAP_MAX_EVENTS &&
        consumedBytes < STREAM_BOOTSTRAP_MAX_BYTES
      ) {
        const remaining = bootstrapDeadline - Date.now();
        if (remaining <= 0) break;
        let completed: boolean;
        try {
          completed = await stepWithin(remaining);
        } catch (err) {
          inflight = null;
          const restarted = await restartBeforeContent(err);
          if (restarted === true) continue;
          if (restarted) {
            cleanup();
            noteFailure(restarted, 'Codex gateway: upstream rejected request');
            return failureResponse(c, restarted);
          }
          throw err;
        }
        if (!completed) break;
        // Nothing has reached the client yet: report the real status.
        const failure = exchangeFailure();
        if (!failure) continue;
        const restarted = await restartBeforeContent();
        if (restarted === true) continue;
        const standing = restarted ?? failure;
        controller.abort();
        await upstreamEvents.return(undefined).catch(() => {});
        cleanup();
        noteFailure(standing, 'Codex gateway: upstream reported failure');
        return failureResponse(c, standing);
      }
    } catch (err) {
      controller.abort();
      await upstreamEvents.return(undefined).catch(() => {});
      cleanup();
      if (err instanceof CodexUpstreamError) {
        grant.lastVerdict = 'upstream_failure';
        return errorResponse(
          c,
          err.status,
          err.errorType,
          err.message,
          failureHeaders(err, upstream.headers),
        );
      }
      if (!clientCancelled) {
        grant.lastVerdict = 'upstream_failure';
        logger.warn(
          { ...logContext, err, ...upstreamTrace(upstream.headers) },
          'Codex gateway: upstream stream failed before content',
        );
      }
      const timedOut = err instanceof UpstreamStallError;
      return errorResponse(
        c,
        timedOut ? 504 : 502,
        'api_error',
        timedOut
          ? 'Upstream Codex stream timed out'
          : 'Upstream Codex stream failed',
      );
    }
    measureEvents = false;

    const encoder = new TextEncoder();
    let downstream!: ReadableStreamDefaultController<Uint8Array>;
    let streamCancelled = false;
    let streamClosed = false;
    let lastWriteAt = 0;
    let keepalive: ReturnType<typeof setTimeout> | undefined;
    const write = (event: AnthropicStreamEvent): void => {
      downstream.enqueue(encoder.encode(sseEncode(event)));
      lastWriteAt = Date.now();
      // Keepalive starts with the handshake: never a ping before message_start.
      if (event.event === 'message_start')
        armKeepalive(STREAM_KEEPALIVE_INTERVAL_MS);
    };
    const armKeepalive = (delay: number): void => {
      clearTimeout(keepalive);
      keepalive = setTimeout(() => {
        keepalive = undefined;
        if (streamClosed) return;
        const idle = Date.now() - lastWriteAt;
        if (idle < STREAM_KEEPALIVE_INTERVAL_MS) {
          armKeepalive(STREAM_KEEPALIVE_INTERVAL_MS - idle);
          return;
        }
        // A full queue means the client is not reading; it is not idle.
        if ((downstream.desiredSize ?? 0) > 0) write(PING_EVENT);
        armKeepalive(STREAM_KEEPALIVE_INTERVAL_MS);
      }, delay);
    };
    const endStream = (): void => {
      streamClosed = true;
      clearTimeout(keepalive);
      cleanup();
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controllerStream) {
        downstream = controllerStream;
      },
      async pull(controllerStream) {
        try {
          // Consume upstream only when downstream has room; a slow/disconnected
          // client cannot leave an unbounded queue of translated SSE chunks.
          while (!pendingEvents.length && !exchangeDone) await consumeStep();
          if (exchangeDone) settle();
          if (streamCancelled) return;
          if (clientCancelled) {
            endStream();
            controllerStream.close();
            return;
          }
          const event = pendingEvents.shift();
          if (event) {
            write(event);
          } else {
            endStream();
            controllerStream.close();
          }
        } catch (err) {
          controller.abort();
          await upstreamEvents.return(undefined).catch(() => {});
          if (!streamCancelled) {
            if (!clientCancelled) {
              grant.lastVerdict = 'upstream_failure';
              logger.warn(
                { ...logContext, err, ...upstreamTrace(upstream.headers) },
                'Codex gateway: stream translation failed',
              );
              controllerStream.enqueue(
                encoder.encode(
                  sseEncode({
                    event: 'error',
                    data: {
                      type: 'error',
                      error:
                        err instanceof CodexUpstreamError
                          ? { type: err.errorType, message: err.message }
                          : {
                              type: 'api_error',
                              message:
                                err instanceof UpstreamStallError
                                  ? 'Upstream Codex stream timed out'
                                  : 'Codex gateway stream failed',
                            },
                    },
                  }),
                ),
              );
            }
            controllerStream.close();
          }
          endStream();
        }
      },
      async cancel() {
        streamCancelled = true;
        clientCancelled = true;
        controller.abort();
        endStream();
        await upstreamEvents.return(undefined).catch(() => {});
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  },
);
