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
} from './convert-request.js';
import { getResolvedCodexCatalog } from './model-catalog-sync.js';
import {
  ResponsesToAnthropicConverter,
  aggregateResponsesStream,
  CodexUpstreamError,
  describeUpstreamHttpFailure,
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
  CodexMessagesRequestSchema,
  describeCodexRequestIssue,
} from './request-validation.js';
import { CODEX_BACKEND_RESPONSES_URL } from './types.js';
import { codexRequestContext } from './request-context.js';
import {
  resolveCodexGatewayToken,
  type CodexGatewayGrant,
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
/** Bounded, time-limited read of an upstream error body. */
const ERROR_BODY_LIMIT_BYTES = 64 * 1024;
const ERROR_BODY_TIMEOUT_MS = 5_000;
/**
 * Streams hold back the handshake (message_start/ping) until content starts,
 * so a failure reported before any content becomes a real HTTP status rather
 * than 200 + event: error. Bounded like CLIProxyAPI's bootstrap buffering
 * (48 frames, 1 MiB), plus a time ceiling so slow reasoning still streams.
 */
const STREAM_BOOTSTRAP_MAX_EVENTS = 48;
const STREAM_BOOTSTRAP_MAX_BYTES = 1024 * 1024;
const STREAM_BOOTSTRAP_TIMEOUT_MS = 20_000;

function sseEncode(event: AnthropicStreamEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
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
): void {
  logger.info(
    {
      ...grantLogContext(grant),
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens,
    },
    'Codex gateway: request proxied',
  );
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

function failureResponse(
  c: Context<CodexGatewayEnv>,
  failure: CodexUpstreamFailure,
  upstreamHeaders?: Headers,
): Response {
  return errorResponse(
    c,
    upstreamFailureStatus(failure),
    failure.type,
    failure.message,
    failureHeaders(failure, upstreamHeaders),
  );
}

/**
 * Resolve upstream access for a grant, mapping token-manager failures to
 * Anthropic errors: a dead refresh grant is an authentication error telling
 * the user to log in again; a refresh in backoff is a retryable 503.
 */
async function resolveAccessOrResponse(
  c: Context<CodexGatewayEnv>,
  grant: CodexGatewayGrant,
  rejectedAccessToken?: string,
): Promise<CodexAccessContext | Response> {
  try {
    return await resolveCodexAccess(
      grant.providerId,
      rejectedAccessToken ? { rejectedAccessToken } : {},
    );
  } catch (err) {
    if (err instanceof CodexRefreshUnavailableError) {
      grant.lastVerdict = 'local_transient';
      return errorResponse(c, 503, 'api_error', err.message, {
        'Retry-After': String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))),
      });
    }
    if (err instanceof CodexReauthRequiredError) {
      grant.lastVerdict = 'reauth_required';
      logger.warn(
        grantLogContext(grant),
        'Codex gateway: ChatGPT login must be renewed',
      );
      return errorResponse(c, 401, 'authentication_error', err.message, {
        'x-should-retry': 'false',
      });
    }
    grant.lastVerdict = 'upstream_failure';
    logger.warn(
      { ...grantLogContext(grant), err },
      'Codex gateway: auth failed',
    );
    return errorResponse(
      c,
      401,
      'authentication_error',
      err instanceof CodexGatewayAuthError
        ? err.message
        : 'Codex authentication failed',
    );
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

/** Parse bounded SSE frames across arbitrary UTF-8 chunks and line endings. */
async function* iterateUpstreamEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
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
      // SyntaxError messages can quote private upstream data. Keep the error
      // generic and fail the request instead of silently dropping output.
      throw new Error('Upstream Codex SSE contains invalid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Upstream Codex SSE event is not an object');
    }
    const event = parsed as Record<string, unknown>;
    if (event.type === undefined && name) event.type = name;
    if (event.type !== undefined && typeof event.type !== 'string') {
      throw new Error('Upstream Codex SSE event has an invalid type');
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
        throw new Error('Upstream Codex SSE event exceeds size limit');
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
        throw new Error('Upstream Codex SSE line exceeds size limit');
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
        throw new Error('Upstream Codex SSE line exceeds size limit');
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
          void reader.cancel().catch(() => {});
          reject(new Error('Upstream Codex stream stalled'));
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

    const resolvedAccess = await resolveAccessOrResponse(c, grant);
    if (resolvedAccess instanceof Response) return resolvedAccess;
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

    const controller = new AbortController();
    let clientCancelled = false;
    const onClientAbort = () => {
      clientCancelled = true;
      controller.abort();
    };
    c.req.raw.signal.addEventListener('abort', onClientAbort, { once: true });
    if (c.req.raw.signal.aborted) onClientAbort();
    const cleanup = () =>
      c.req.raw.signal.removeEventListener('abort', onClientAbort);

    const sendUpstream = async (
      current: CodexAccessContext,
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
            ...responsesRequest,
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
    const upstreamUnreachable = (err: unknown): Response => {
      cleanup();
      grant.lastVerdict = 'upstream_failure';
      logger.warn(
        { ...logContext, err },
        'Codex gateway: upstream request failed',
      );
      return errorResponse(
        c,
        502,
        'api_error',
        'Upstream Codex request failed',
      );
    };

    let upstream: Response;
    try {
      upstream = await sendUpstream(access);
    } catch (err) {
      return upstreamUnreachable(err);
    }

    // An access token can be revoked before its recorded expiry. Refresh once
    // (single-flight, shared with concurrent requests) and retry once.
    if (upstream.status === 401) {
      await upstream.body?.cancel().catch(() => {});
      const refreshed = await resolveAccessOrResponse(
        c,
        grant,
        access.accessToken,
      );
      if (refreshed instanceof Response) {
        cleanup();
        return refreshed;
      }
      access = refreshed;
      try {
        upstream = await sendUpstream(access);
      } catch (err) {
        return upstreamUnreachable(err);
      }
    }

    if (!upstream.ok || !upstream.body) {
      const bodyText = await readBoundedErrorBody(upstream);
      cleanup();
      const failure: CodexUpstreamFailure =
        upstream.status === 401
          ? {
              type: 'authentication_error',
              code: null,
              message:
                'ChatGPT 拒绝了刚刷新的访问令牌，账号可能已被停用或登出。请在「模型配置」中重新登录 ChatGPT。',
              status: 401,
            }
          : describeUpstreamHttpFailure(upstream.status, bodyText);
      grant.lastVerdict = 'upstream_failure';
      logger.warn(
        {
          ...logContext,
          status: upstream.status,
          code: failure.code,
          errorType: failure.type,
        },
        'Codex gateway: upstream rejected request',
      );
      return failureResponse(c, failure, upstream.headers);
    }

    const conversionOptions = { tools: anthropicRequest.tools };
    const converter = new ResponsesToAnthropicConverter(
      responsesRequest.model,
      conversionOptions,
    );

    if (!wantsStream) {
      const events: Record<string, unknown>[] = [];
      let eventBytes = 0;
      // 非流式聚合需要一个整体上限：空闲超时只限制块间间隔，慢滴上游可以
      // 无限拖住请求和 events 数组。上限对齐 Anthropic SDK 客户端默认 10 分钟。
      const deadline = setTimeout(
        () => controller.abort(),
        AGGREGATE_DEADLINE_MS,
      );
      try {
        for await (const event of iterateUpstreamEvents(
          upstream.body,
          controller.signal,
        )) {
          eventBytes += Buffer.byteLength(JSON.stringify(event));
          if (eventBytes > 32 * 1024 * 1024) {
            throw new Error(
              'Upstream Codex response exceeds aggregation limit',
            );
          }
          events.push(event);
        }
        const aggregated = aggregateResponsesStream(
          events,
          responsesRequest.model,
          conversionOptions,
        );
        grant.lastVerdict = 'ok';
        logGatewaySuccess(grant, responsesRequest.model, aggregated.usage);
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
        grant.lastVerdict = 'upstream_failure';
        if (err instanceof CodexUpstreamError) {
          logger.warn(
            { ...logContext, code: err.code, errorType: err.errorType },
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
        const timedOut = err instanceof Error && err.name === 'AbortError';
        logger.warn(
          { ...logContext, err },
          'Codex gateway: upstream stream failed',
        );
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

    let streamCancelled = false;
    let upstreamFinished = false;
    const upstreamEvents = iterateUpstreamEvents(
      upstream.body,
      controller.signal,
    );
    // A read started during bootstrap may still be pending when its time
    // budget ends; the stream must continue from that same read.
    let pendingRead: Promise<IteratorResult<Record<string, unknown>>> | null =
      null;
    const nextUpstreamEvent = () => (pendingRead ??= upstreamEvents.next());
    const pendingEvents: AnthropicStreamEvent[] = [];
    const consumeUpstream = (
      next: IteratorResult<Record<string, unknown>>,
    ): void => {
      pendingRead = null;
      if (next.done) {
        upstreamFinished = true;
        pendingEvents.push(...converter.finish());
        const failure = converter.getFailure();
        if (failure) {
          grant.lastVerdict = 'upstream_failure';
          logger.warn(
            { ...logContext, code: failure.code, errorType: failure.type },
            'Codex gateway: upstream reported failure',
          );
        } else {
          grant.lastVerdict = 'ok';
          logGatewaySuccess(
            grant,
            responsesRequest.model,
            converter.getUsage(),
          );
        }
      } else {
        pendingEvents.push(...converter.handleEvent(next.value));
      }
    };

    const bootstrapDeadline = Date.now() + STREAM_BOOTSTRAP_TIMEOUT_MS;
    let bootstrapEvents = 0;
    let bootstrapBytes = 0;
    try {
      while (
        !upstreamFinished &&
        !pendingEvents.some(
          ({ event }) => event !== 'message_start' && event !== 'ping',
        ) &&
        bootstrapEvents < STREAM_BOOTSTRAP_MAX_EVENTS &&
        bootstrapBytes < STREAM_BOOTSTRAP_MAX_BYTES
      ) {
        const remaining = bootstrapDeadline - Date.now();
        if (remaining <= 0) break;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const next = await Promise.race([
          nextUpstreamEvent(),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), remaining);
          }),
        ]).finally(() => clearTimeout(timer));
        if (!next) break;
        consumeUpstream(next);
        bootstrapEvents += 1;
        if (!next.done)
          bootstrapBytes += Buffer.byteLength(JSON.stringify(next.value));
        // Nothing has reached the client yet: report the real status.
        const failure = converter.getFailure();
        if (failure) {
          controller.abort();
          await upstreamEvents.return(undefined).catch(() => {});
          cleanup();
          return failureResponse(c, failure, upstream.headers);
        }
      }
    } catch (err) {
      controller.abort();
      await upstreamEvents.return(undefined).catch(() => {});
      cleanup();
      grant.lastVerdict = 'upstream_failure';
      if (err instanceof CodexUpstreamError) {
        return errorResponse(
          c,
          err.status,
          err.errorType,
          err.message,
          failureHeaders(err, upstream.headers),
        );
      }
      const timedOut =
        err instanceof Error && err.message === 'Upstream Codex stream stalled';
      if (!clientCancelled)
        logger.warn(
          { ...logContext, err },
          'Codex gateway: upstream stream failed before content',
        );
      return errorResponse(
        c,
        timedOut ? 504 : 502,
        'api_error',
        timedOut
          ? 'Upstream Codex stream timed out'
          : 'Upstream Codex stream failed',
      );
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controllerStream) {
        try {
          // Consume upstream only when downstream has room; a slow/disconnected
          // client cannot leave an unbounded queue of translated SSE chunks.
          while (!pendingEvents.length && !upstreamFinished) {
            consumeUpstream(await nextUpstreamEvent());
          }
          if (streamCancelled) return;
          if (clientCancelled) {
            cleanup();
            controllerStream.close();
            return;
          }
          const event = pendingEvents.shift();
          if (event) {
            controllerStream.enqueue(encoder.encode(sseEncode(event)));
          } else {
            cleanup();
            controllerStream.close();
          }
        } catch (err) {
          controller.abort();
          await upstreamEvents.return(undefined).catch(() => {});
          if (!streamCancelled) {
            if (!clientCancelled) {
              grant.lastVerdict = 'upstream_failure';
              logger.warn(
                { ...logContext, err },
                'Codex gateway: stream translation failed',
              );
              controllerStream.enqueue(
                encoder.encode(
                  sseEncode({
                    event: 'error',
                    data: {
                      type: 'error',
                      error: {
                        type: 'api_error',
                        message: 'Codex gateway stream failed',
                      },
                    },
                  }),
                ),
              );
            }
            controllerStream.close();
          }
          cleanup();
        }
      },
      async cancel() {
        streamCancelled = true;
        clientCancelled = true;
        controller.abort();
        cleanup();
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
