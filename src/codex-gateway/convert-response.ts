// Ported from CLIProxyAPI a2976eb8; see docs/licenses/CLIProxyAPI-MIT.txt.
// Responses SSE -> Anthropic Messages SSE, shared by streaming and aggregation.
// Item/content identities remain separate while output blocks are serialized for
// Claude SDK. Tool arguments hydrate from deltas and authoritative snapshots;
// reasoning retains summary boundaries and a replayable final signature.
// Completion normalizes usage and stop metadata exactly once. Failures and
// premature EOF remain errors rather than successful partial answers. A
// response the backend ends with end_turn: false (or interrupts) can be
// continued by a follow-up request into the same Anthropic message, as the
// official Codex turn loop does with needs_follow_up.

import { encodeReasoningSignature } from './reasoning-signature.js';
import {
  buildCodexToolNameMap,
  shortenCodexCallId,
} from './convert-request.js';

type Json = Record<string, unknown>;

export interface ResponseConversionOptions {
  /** Original Anthropic tools, used to restore names shortened upstream. */
  tools?: Array<Json>;
  /**
   * Local input estimate for message_start. Claude Code keeps it until a
   * message_delta reports a positive count, so partial replies carry a size.
   */
  inputTokenEstimate?: number;
  /**
   * Upstream responses that may continue this message when the backend asks
   * for a follow-up (`end_turn: false`, or an `interrupted` incomplete).
   */
  maxFollowUps?: number;
}

type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'tool_use'
  | 'stop_sequence'
  | 'pause_turn'
  | 'refusal'
  | 'model_context_window_exceeded';

interface ResponseUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens?: number;
  output_tokens_details?: { thinking_tokens: number };
}

interface OutputBlock {
  type:
    | 'text'
    | 'thinking'
    | 'tool_use'
    | 'server_tool_use'
    | 'web_search_tool_result';
  index: number | null;
  text: string;
  emitted: string;
  done: boolean;
  closed: boolean;
  item: OutputItem;
  name?: string;
  callId?: string;
  initialEmptyDelta?: boolean;
  /** Upstream marked the call's arguments final (arguments.done/item done). */
  argumentsFinal?: boolean;
  /** Started downstream, then cut by a truncated response: close as is. */
  truncated?: boolean;
  parts?: Map<number, string>;
  currentPart?: number;
  data?: Json;
}

interface OutputItem {
  type: string;
  id: string | null;
  anonymous: boolean;
  done: boolean;
  blocks: Map<number, OutputBlock>;
  tool?: OutputBlock;
  thinking?: OutputBlock;
  signature?: string;
  fallbackSignature?: string;
}

function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function indexValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function responseUsage(response: Json): ResponseUsage {
  const usage = object(response.usage);
  const details = object(usage.input_tokens_details);
  const total = tokens(usage.input_tokens);
  const cached = Math.min(total, tokens(details.cached_tokens));
  const created = Math.min(
    total - cached,
    tokens(details.cache_write_tokens) || tokens(details.cache_creation_tokens),
  );
  const output = tokens(usage.output_tokens);
  const thinking = object(usage.output_tokens_details).reasoning_tokens;
  return {
    input_tokens: Math.max(0, total - cached - created),
    output_tokens: output,
    cache_read_input_tokens: cached,
    ...(created ? { cache_creation_input_tokens: created } : {}),
    ...(typeof thinking === 'number' &&
    Number.isFinite(thinking) &&
    thinking >= 0
      ? {
          output_tokens_details: {
            thinking_tokens: Math.min(output, tokens(thinking)),
          },
        }
      : {}),
  };
}

function addUsage(a: ResponseUsage, b: ResponseUsage): ResponseUsage {
  const created =
    (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0);
  const thinking =
    a.output_tokens_details || b.output_tokens_details
      ? (a.output_tokens_details?.thinking_tokens ?? 0) +
        (b.output_tokens_details?.thinking_tokens ?? 0)
      : undefined;
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens:
      a.cache_read_input_tokens + b.cache_read_input_tokens,
    ...(created ? { cache_creation_input_tokens: created } : {}),
    ...(thinking !== undefined
      ? { output_tokens_details: { thinking_tokens: thinking } }
      : {}),
  };
}

function incompleteReason(response: Json): string {
  return (asString(object(response.incomplete_details).reason) ?? '')
    .trim()
    .toLowerCase();
}

function isTruncation(reason: string): boolean {
  return reason === 'max_output_tokens' || reason === 'max_tokens';
}

function stopReason(
  response: Json,
  incomplete: boolean,
  hasToolUse: boolean,
  refused: boolean,
): StopReason {
  // A truncated turn is not a tool_use success even when calls were
  // delivered: the truncation reason wins, as on Anthropic.
  if (incomplete && isTruncation(incompleteReason(response)))
    return 'max_tokens';
  if (hasToolUse) return 'tool_use';
  if (refused) return 'refusal';
  const sequence = asString(response.stop_sequence);
  const reason =
    asString(response.stop_reason) ||
    asString(object(response.incomplete_details).reason);
  if (sequence && (!reason || reason === 'stop')) return 'stop_sequence';
  switch (reason) {
    case 'max_tokens':
    case 'max_output_tokens':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
    case 'refusal':
    case 'model_context_window_exceeded':
      return reason;
    default:
      return incomplete && !reason ? 'max_tokens' : 'end_turn';
  }
}

export interface AnthropicStreamEvent {
  event: string;
  data: Json;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export type AnthropicErrorType =
  | 'invalid_request_error'
  | 'rate_limit_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'overloaded_error'
  | 'api_error';

export interface CodexUpstreamFailure {
  type: AnthropicErrorType;
  code: string | null;
  message: string;
  status?: number;
  /** Seconds until the upstream says the request may succeed again. */
  retryAfterSeconds?: number;
  /**
   * The client must surface this instead of retrying: a usage limit hours
   * away or a plan that does not include Codex will not clear on a retry.
   */
  noRetry?: boolean;
  /** usage_limit_reached: the account's usage window is exhausted. */
  usageLimitReached?: boolean;
  /** When the exhausted window resets, Unix epoch seconds, if known. */
  resetsAt?: number;
}

// Classification follows the official client (codex-api responses_error.rs
// and api_bridge.rs): quota and policy verdicts are terminal, slow_down is a
// rate limit rather than an overload, and only rate limits read a retry delay
// out of the message text.
const RATE_LIMIT_CODES = new Set(['rate_limit_exceeded', 'slow_down']);
const USAGE_LIMIT_CODES = new Set(['usage_limit_reached']);
const QUOTA_CODES = new Set([
  'insufficient_quota',
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
]);
/** Official fallback text for policy rejections that arrive without a message. */
const POLICY_FALLBACK_MESSAGES: ReadonlyMap<string, string> = new Map([
  [
    'cyber_policy',
    'This request has been flagged for possible cybersecurity risk.',
  ],
  ['bio_policy', 'This content was flagged for possible biological risk.'],
  [
    'misalignment_policy_violation',
    'This request was blocked due to a misalignment policy violation.',
  ],
  ['invalid_prompt', 'Invalid request.'],
]);
const OVERLOADED_CODES = new Set([
  'server_is_overloaded',
  'server_overloaded',
  'overloaded',
]);
const CONTEXT_LENGTH_CODES = new Set([
  'context_length_exceeded',
  'context_too_large',
]);

const HTTP_STATUS_BY_ERROR_TYPE: Readonly<Record<AnthropicErrorType, number>> =
  {
    invalid_request_error: 400,
    rate_limit_error: 429,
    authentication_error: 401,
    permission_error: 403,
    not_found_error: 404,
    overloaded_error: 529,
    api_error: 502,
  };

const UPSTREAM_DETAIL_LIMIT = 500;

/**
 * Upstream error text may echo request content or credentials. Keep a bounded,
 * single-line excerpt with bearer tokens, API keys, JWTs and long opaque
 * strings redacted; it is returned to the runner that sent the request.
 */
export function sanitizeUpstreamText(
  value: string,
  limit = UPSTREAM_DETAIL_LIMIT,
): string {
  const cleaned = value
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
      '[redacted]',
    )
    .replace(/\b(?:sk|rt|hcgw)[-_][A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/[A-Za-z0-9+/_=-]{40,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned;
}

function positiveSeconds(value: unknown): number | undefined {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())
        ? Number(value)
        : NaN;
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function formatResetDelay(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  return `${Math.round(hours / 24)} 天`;
}

/** usage_limit_reached carries resets_at (epoch seconds) or resets_in_seconds. */
function usageLimitRetry(
  nested: Json,
  now: number,
): { retryAfterSeconds?: number; resetsAt?: number } {
  const resetsAt = positiveSeconds(nested.resets_at);
  if (resetsAt !== undefined && resetsAt * 1000 > now) {
    return {
      retryAfterSeconds: Math.max(1, Math.ceil((resetsAt * 1000 - now) / 1000)),
      resetsAt: resetsAt * 1000,
    };
  }
  const resetsIn = positiveSeconds(nested.resets_in_seconds);
  if (resetsIn !== undefined) {
    return {
      retryAfterSeconds: Math.ceil(resetsIn),
      resetsAt: now + Math.ceil(resetsIn) * 1000,
    };
  }
  return {};
}

/** `Retry-After` inside a streamed error (`error.headers`), as seconds. */
function errorHeadersRetryAfter(nested: Json, now: number): number | undefined {
  const headers = object(nested.headers);
  const name = Object.keys(headers).find(
    (key) => key.toLowerCase() === 'retry-after',
  );
  const raw = name === undefined ? undefined : headers[name];
  const value = asString(Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return positiveSeconds(value);
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? positiveSeconds((date - now) / 1000)
    : undefined;
}

/** responses_error.rs try_parse_retry_delay: "try again in 1.5s" / "500ms". */
function messageRetryAfter(message: string): number | undefined {
  const match = /try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)/i.exec(
    message,
  );
  if (!match) return undefined;
  const value = Number(match[1]);
  return positiveSeconds(
    match[2].toLowerCase() === 'ms' ? value / 1000 : value,
  );
}

function isContextLengthMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('context window') ||
    lower.includes('context length') ||
    lower.includes('context_length') ||
    lower.includes('maximum context') ||
    lower.includes('too many tokens')
  );
}

/**
 * 把上游失败翻译成 Anthropic 错误类型与 HTTP 状态。类型决定客户端是否重试：
 * SDK 对 api_error 会反复重试，而安全策略拒绝（invalid_prompt、cyber_policy
 * 等）或额度耗尽重试同一请求并不会改变判定，必须以不可重试的错误暴露真实原因。
 * SSE 终止事件与非 2xx HTTP 响应体共用这一套映射，分类对齐官方 Codex CLI。
 */
export function describeUpstreamFailure(
  raw: Json,
  options: { httpStatus?: number; now?: number } = {},
): CodexUpstreamFailure {
  // response.failed 的详情在 response.error 下；裸 error 事件在 error 下，
  // 少数旧形态直接放在顶层 code/message。
  const response = object(raw.response);
  const error = response.error ?? raw.error;
  const nested = object(error);
  const code = asString(nested.code) ?? asString(raw.code);
  const normalizedCode = code?.trim().toLowerCase() ?? '';
  const upstreamType = (asString(nested.type) ?? asString(raw.error_type) ?? '')
    .trim()
    .toLowerCase();
  const declaredStatus = [nested.status_code, nested.status].find(
    (value) =>
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 400 &&
      value <= 599,
  ) as number | undefined;
  const httpStatus =
    options.httpStatus !== undefined &&
    options.httpStatus >= 400 &&
    options.httpStatus <= 599
      ? options.httpStatus
      : undefined;
  const status = declaredStatus ?? httpStatus;
  const upstreamMessage =
    asString(nested.message) ?? asString(error) ?? asString(raw.message);
  const detail = sanitizeUpstreamText(
    upstreamMessage ?? 'Upstream Codex request failed',
  );
  const now = options.now ?? Date.now();
  const isCode = (codes: Set<string>) =>
    codes.has(normalizedCode) || codes.has(upstreamType);
  const headerRetry = errorHeadersRetryAfter(nested, now);

  // Plan/quota verdicts first: Codex sends them with error.type, not code.
  if (isCode(USAGE_LIMIT_CODES)) {
    const retry = usageLimitRetry(nested, now);
    const reset =
      retry.resetsAt !== undefined && retry.retryAfterSeconds !== undefined
        ? `，将于 ${new Date(retry.resetsAt).toISOString()} 重置（约 ${formatResetDelay(retry.retryAfterSeconds)}后）`
        : '';
    return {
      type: 'rate_limit_error',
      code: code ?? 'usage_limit_reached',
      message: `ChatGPT 订阅的 Codex 用量已达上限（usage_limit_reached）${reset}。${detail}`,
      status: 429,
      noRetry: true,
      usageLimitReached: true,
      ...(retry.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: retry.retryAfterSeconds }
        : {}),
      ...(retry.resetsAt !== undefined
        ? { resetsAt: Math.ceil(retry.resetsAt / 1000) }
        : {}),
    };
  }
  if (
    normalizedCode === 'usage_not_included' ||
    upstreamType === 'usage_not_included'
  ) {
    return {
      type: 'permission_error',
      code: code ?? 'usage_not_included',
      message: `当前 ChatGPT 套餐不包含 Codex 用量（usage_not_included），请升级套餐或改用其他模型配置。${detail}`,
      status: 403,
      noRetry: true,
    };
  }
  if (isCode(QUOTA_CODES)) {
    const quotaCode = code ?? upstreamType;
    return {
      type: 'rate_limit_error',
      code: quotaCode,
      message: `ChatGPT 账号的额度已用尽（${quotaCode}），重试不会恢复，请检查套餐与账单。${detail}`,
      status: 429,
      noRetry: true,
    };
  }
  const policyFallback = POLICY_FALLBACK_MESSAGES.get(normalizedCode);
  if (policyFallback !== undefined) {
    const reason = upstreamMessage?.trim()
      ? detail
      : sanitizeUpstreamText(policyFallback);
    return {
      type: 'invalid_request_error',
      code,
      message: `Codex 上游安全策略拒绝了本次请求（${normalizedCode}）：${reason}`,
      status: 400,
      noRetry: true,
    };
  }
  if (
    isCode(OVERLOADED_CODES) ||
    upstreamType === 'service_unavailable_error' ||
    upstreamType === 'overloaded_error' ||
    status === 529
  ) {
    return {
      type: 'overloaded_error',
      code,
      message: code
        ? `Codex upstream overloaded (${code}): ${detail}`
        : `Codex upstream overloaded: ${detail}`,
      status: 529,
      ...(headerRetry !== undefined ? { retryAfterSeconds: headerRetry } : {}),
    };
  }
  if (RATE_LIMIT_CODES.has(normalizedCode)) {
    const retryAfterSeconds = headerRetry ?? messageRetryAfter(detail);
    return {
      type: 'rate_limit_error',
      code,
      message: `Codex upstream rate limited (${code}): ${detail}`,
      status: 429,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
  }
  if (
    isCode(CONTEXT_LENGTH_CODES) ||
    status === 413 ||
    ((upstreamType === '' || upstreamType === 'invalid_request_error') &&
      isContextLengthMessage(detail))
  ) {
    // Claude Code recognises "prompt is too long" (case-insensitive) on a 400
    // and compacts the conversation instead of failing the turn.
    return {
      type: 'invalid_request_error',
      code,
      message: `Prompt is too long: Codex upstream rejected the request${code ? ` (${code})` : ''}: ${detail}`,
      status: status === 413 ? 413 : 400,
    };
  }

  let type: AnthropicErrorType = 'api_error';
  if (upstreamType.includes('rate_limit') || status === 429) {
    type = 'rate_limit_error';
  } else if (
    upstreamType === 'invalid_request_error' ||
    upstreamType === 'invalid_request' ||
    upstreamType === 'bad_request_error' ||
    // Resending the same ciphertext fails identically; the gateway strips it.
    normalizedCode === 'invalid_encrypted_content' ||
    status === 400 ||
    status === 422
  ) {
    type = 'invalid_request_error';
  } else if (
    upstreamType === 'authentication_error' ||
    normalizedCode === 'invalid_api_key' ||
    normalizedCode === 'unauthorized' ||
    status === 401
  ) {
    type = 'authentication_error';
  } else if (
    upstreamType === 'permission_error' ||
    normalizedCode === 'forbidden' ||
    normalizedCode === 'permission_denied' ||
    status === 403
  ) {
    type = 'permission_error';
  } else if (
    upstreamType === 'not_found_error' ||
    normalizedCode === 'not_found' ||
    normalizedCode === 'model_not_found' ||
    status === 404
  ) {
    type = 'not_found_error';
  }

  return {
    type,
    code,
    message: code ? `Codex upstream error (${code}): ${detail}` : detail,
    ...(status ? { status } : {}),
    // Anything else is retryable upstream advice (ApiError::Retryable).
    ...(headerRetry !== undefined ? { retryAfterSeconds: headerRetry } : {}),
  };
}

/**
 * The upstream could not verify replayed reasoning ciphertext, typically
 * sealed by another account. Stripping the reasoning items lets the same
 * conversation continue (magpie affinity.go foreignReasoning).
 */
export function isInvalidEncryptedContentFailure(
  failure: Pick<CodexUpstreamFailure, 'code' | 'message'>,
): boolean {
  return (
    failure.code?.trim().toLowerCase() === 'invalid_encrypted_content' ||
    /invalid_encrypted_content|encrypted[ _]content.{0,80}could not be (verified|decrypted)|could not (decrypt|verify).{0,40}encrypted[ _]content/i.test(
      failure.message,
    )
  );
}

/**
 * Classify a non-2xx upstream HTTP response from its bounded body. ChatGPT
 * answers with `{error: {...}}`, `{detail: ...}` or plain text.
 */
export function describeUpstreamHttpFailure(
  status: number,
  bodyText: string,
  now = Date.now(),
): CodexUpstreamFailure {
  let body: unknown;
  try {
    body = bodyText.trim() ? JSON.parse(bodyText) : undefined;
  } catch {
    body = undefined;
  }
  const record = object(body);
  const text = bodyText.trim();
  // Plain-text bodies ("Unauthorized") are informative; HTML error pages from
  // an edge proxy are not, and would only crowd the message.
  const plainText =
    body === undefined && text && !text.startsWith('<') ? text : undefined;
  const error =
    record.error ??
    record.detail ??
    (typeof body === 'string' ? body : undefined) ??
    plainText ??
    `Upstream Codex backend returned ${status}`;
  const failure = describeUpstreamFailure(
    { error, ...(record.code !== undefined ? { code: record.code } : {}) },
    { httpStatus: status, now },
  );
  return { ...failure, status: failure.status ?? status };
}

export class CodexUpstreamError extends Error {
  readonly errorType: AnthropicErrorType;
  readonly code: string | null;
  readonly status: number;
  readonly retryAfterSeconds?: number;
  readonly noRetry: boolean;

  constructor(failure: CodexUpstreamFailure) {
    super(failure.message);
    this.name = 'CodexUpstreamError';
    this.errorType = failure.type;
    this.code = failure.code;
    this.status = failure.status ?? HTTP_STATUS_BY_ERROR_TYPE[failure.type];
    this.retryAfterSeconds = failure.retryAfterSeconds;
    this.noRetry = failure.noRetry === true;
  }
}

/** HTTP status for a failure reported inside an SSE stream. */
export function upstreamFailureStatus(failure: CodexUpstreamFailure): number {
  return failure.status ?? HTTP_STATUS_BY_ERROR_TYPE[failure.type];
}

/** Namespace Responses Lite puts every client function in. */
const DEFAULT_FUNCTION_NAMESPACE = 'functions';

/** Prefixed item IDs survive replay, like the official client's history. */
function replayItemId(value: unknown): string | undefined {
  const id = asString(value);
  const separator = id?.indexOf('_') ?? -1;
  return id && separator > 0 && separator < id.length - 1 ? id : undefined;
}

/**
 * One completed output item as the official client replays it from its
 * history (codex-protocol ResponseItem): with store: false the follow-up
 * request must carry every earlier item again, including encrypted reasoning.
 */
function replayOutputItem(item: Json): Json | null {
  const type = asString(item.type);
  if (!type) return null;
  const id = replayItemId(item.id);
  switch (type) {
    case 'message':
      return {
        type,
        ...(id ? { id } : {}),
        role: asString(item.role) ?? 'assistant',
        content: Array.isArray(item.content) ? item.content : [],
        ...(asString(item.status) ? { status: item.status } : {}),
        ...(asString(item.phase) ? { phase: item.phase } : {}),
      };
    case 'reasoning':
      return {
        type,
        ...(id ? { id } : {}),
        summary: Array.isArray(item.summary) ? item.summary : [],
        // Raw reasoning text is replayed only when present (official serde).
        ...(Array.isArray(item.content) &&
        item.content.some((part) => object(part).type === 'reasoning_text')
          ? { content: item.content }
          : {}),
        encrypted_content: asString(item.encrypted_content),
      };
    default: {
      const replay: Json = { ...item };
      if (id) replay.id = id;
      else delete replay.id;
      return replay;
    }
  }
}

export class ResponsesToAnthropicConverter {
  private blockIndex = 0;
  private readonly aliases = new Map<string, OutputItem>();
  private readonly lastItems = new Map<string, OutputItem>();
  private readonly items = new Set<OutputItem>();
  private readonly toolQueue: OutputBlock[] = [];
  private readonly contentQueue: OutputBlock[] = [];
  private active: OutputBlock | null = null;
  private hasToolUse = false;
  /** Any function call in the current upstream response, started or not. */
  private responseHasToolCall = false;
  private truncatedToolUse = false;
  private refused = false;
  private sawMeaningfulOutput = false;
  private completedOutputItems = 0;
  private usage: ResponseUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
  };
  /** Usage of earlier upstream responses folded into this message. */
  private priorUsage: ResponseUsage | null = null;
  /** Completed output items of the current response, for follow-up replay. */
  private outputItems: Json[] = [];
  private followUpItems: Json[] | null = null;
  private followUpsLeft: number;
  private readonly inputTokenEstimate: number;
  private messageStarted = false;
  private finished = false;
  private failure: CodexUpstreamFailure | null = null;
  private readonly originalToolNames: Map<string, string>;

  constructor(
    private model: string,
    options: ResponseConversionOptions = {},
  ) {
    this.originalToolNames = new Map(
      [...buildCodexToolNameMap(options.tools)].map(([original, short]) => [
        short,
        original,
      ]),
    );
    this.inputTokenEstimate = tokens(options.inputTokenEstimate);
    this.followUpsLeft = tokens(options.maxFollowUps);
  }

  /**
   * Output items to replay when the backend asked for a follow-up: the
   * message stays open and the next upstream response continues it.
   */
  pendingFollowUp(): Json[] | null {
    return this.followUpItems ? [...this.followUpItems] : null;
  }

  /** Continue the open message with the next upstream response. */
  beginFollowUp(): void {
    if (!this.followUpItems) return;
    this.followUpItems = null;
    this.finished = false;
    this.aliases.clear();
    this.lastItems.clear();
    this.items.clear();
    this.toolQueue.length = 0;
    this.contentQueue.length = 0;
    this.active = null;
    this.outputItems = [];
    this.responseHasToolCall = false;
  }

  /** End the message with a failure the caller observed itself. */
  fail(failure: CodexUpstreamFailure): AnthropicStreamEvent[] {
    if (this.finished && !this.followUpItems) return [];
    this.followUpItems = null;
    this.finished = true;
    this.failure = { ...failure };
    return [
      {
        event: 'error',
        data: {
          type: 'error',
          error: { type: failure.type, message: failure.message },
        },
      },
    ];
  }

  handleEvent(raw: Json): AnthropicStreamEvent[] {
    if (this.finished) return [];
    const type = asString(raw.type) ?? '';
    if (type === 'error' || type === 'response.failed')
      return this.handleFailure(raw);
    if (
      type === 'response.completed' ||
      type === 'response.incomplete' ||
      type === 'response.done'
    ) {
      const response = object(raw.response);
      if (response.status === 'failed' || response.error)
        return this.handleFailure(raw);
      if (
        response.status != null &&
        response.status !== 'completed' &&
        response.status !== 'incomplete'
      )
        return this.handleFailure({
          code: 'invalid_terminal_status',
          message: 'Upstream Codex terminated before completing the response',
        });
      return this.handleCompleted(
        raw,
        type === 'response.incomplete' || response.status === 'incomplete',
      );
    }
    if (type === 'response.created' || type === 'response.in_progress')
      return this.ensureMessageStarted(raw);
    const supported = new Set([
      'response.output_item.added',
      'response.output_item.done',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.content_part.added',
      'response.content_part.done',
      'response.output_text.delta',
      'response.output_text.done',
      'response.refusal.delta',
      'response.refusal.done',
      'response.reasoning_summary_part.added',
      'response.reasoning_summary_part.done',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done',
      'response.reasoning_text.delta',
      'response.reasoning_text.done',
    ]);
    if (!supported.has(type)) return [];
    if (
      type === 'response.output_item.done' &&
      raw.item &&
      typeof raw.item === 'object' &&
      !Array.isArray(raw.item)
    ) {
      this.completedOutputItems++;
      if (this.followUpsLeft > 0) this.outputItems.push(raw.item as Json);
    }
    if (
      type.startsWith('response.refusal.') ||
      object(raw.part).type === 'refusal'
    )
      this.refused = true;
    if (
      [
        'response.output_text.delta',
        'response.reasoning_text.delta',
        'response.reasoning_summary_text.delta',
        'response.function_call_arguments.delta',
      ].includes(type) &&
      asString(raw.delta)?.trim()
    )
      this.sawMeaningfulOutput = true;
    const events = this.ensureMessageStarted(raw);
    if (
      type === 'response.output_item.added' ||
      type === 'response.output_item.done'
    ) {
      this.updateItem(raw, object(raw.item), type.endsWith('.done'), events);
    } else if (type.startsWith('response.function_call_arguments.')) {
      const item = this.itemFor(raw, {}, 'function_call');
      const block = this.toolFor(item);
      if (!block.closed) {
        if (type.endsWith('.delta')) block.text += asString(raw.delta) ?? '';
        else {
          this.setSnapshot(block, asString(raw.arguments) ?? '');
          this.validateToolArguments(block);
          block.argumentsFinal = true;
        }
      }
    } else if (type.startsWith('response.reasoning_')) {
      this.updateThinking(raw, type, events);
    } else {
      const item = this.itemFor(raw, {}, 'message');
      const part = object(raw.part);
      if (
        type.includes('content_part') &&
        part.type !== 'output_text' &&
        part.type !== 'refusal'
      )
        return events;
      const block = this.textFor(item, indexValue(raw.content_index) ?? 0);
      if (!block.closed) {
        if (type.endsWith('.delta')) block.text += asString(raw.delta) ?? '';
        else
          this.setSnapshot(
            block,
            asString(raw.text) ??
              asString(raw.refusal) ??
              asString(part.text) ??
              asString(part.refusal) ??
              '',
          );
        if (type.endsWith('.done')) block.done = true;
      }
    }
    events.push(...this.flush());
    return events;
  }

  finish(): AnthropicStreamEvent[] {
    if (this.finished) return [];
    return this.handleFailure({
      message: 'Upstream Codex stream ended before completion',
    });
  }

  private ensureMessageStarted(raw: Json): AnthropicStreamEvent[] {
    if (this.messageStarted) return [];
    this.messageStarted = true;
    const response = object(raw.response);
    this.model = asString(response.model) ?? this.model;
    return [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: asString(response.id) ?? `msg_${Date.now().toString(36)}`,
            type: 'message',
            role: 'assistant',
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: this.inputTokenEstimate, output_tokens: 0 },
          },
        },
      },
      { event: 'ping', data: { type: 'ping' } },
    ];
  }

  private itemFor(raw: Json, item: Json, type: string): OutputItem {
    const keys: string[] = [];
    for (const id of [asString(item.id), asString(raw.item_id)])
      if (id) keys.push(`item:${id}`);
    if (type === 'web_search_call') {
      for (const id of [
        asString(raw.id),
        asString(item.output_item_id),
        asString(raw.output_item_id),
        asString(item.call_id),
        asString(raw.call_id),
        asString(item.item_id),
      ])
        if (id) keys.push(`item:${id}`);
    }
    if (type === 'function_call') {
      for (const id of [asString(item.call_id), asString(raw.call_id)])
        if (id) keys.push(`call:${id}`);
    }
    const outputIndex =
      indexValue(raw.output_index) ?? indexValue(item.output_index);
    if (outputIndex !== null) keys.push(`output:${outputIndex}`);
    let found = keys
      .map((key) => this.aliases.get(key))
      .find((value) => value?.type === type);
    const previous = this.lastItems.get(type);
    if (
      !found &&
      previous &&
      ((!keys.length &&
        (!previous.done || raw.type !== 'response.output_item.added')) ||
        (previous.anonymous &&
          (!previous.done ||
            (raw.type === undefined &&
              type === 'reasoning' &&
              previous.thinking &&
              !previous.thinking.closed))))
    )
      found = previous;
    if (!found) {
      found = {
        type,
        id: null,
        anonymous: !keys.length,
        done: false,
        blocks: new Map(),
      };
      this.items.add(found);
    }
    found.id = asString(item.id) || asString(raw.item_id) || found.id;
    for (const key of keys) this.aliases.set(key, found);
    if (keys.length) found.anonymous = false;
    this.lastItems.set(type, found);
    return found;
  }

  private blockFor(item: OutputItem, type: OutputBlock['type']): OutputBlock {
    return {
      item,
      type,
      index: null,
      text: '',
      emitted: '',
      done: false,
      closed: false,
    };
  }

  /**
   * The original Anthropic name of a function call. Responses Lite calls
   * carry the default `functions` namespace beside an unqualified name
   * (official ToolName::with_default_namespace); the namespace is dropped,
   * as is a `functions.`/`functions__` qualification of the name itself.
   */
  private restoreToolName(item: Json): string | null {
    let name = asString(item.name);
    if (!name) return null;
    const namespace = asString(item.namespace) || DEFAULT_FUNCTION_NAMESPACE;
    if (!this.originalToolNames.has(name))
      for (const separator of ['.', '__']) {
        const prefix = `${namespace}${separator}`;
        if (name.startsWith(prefix) && name.length > prefix.length) {
          name = name.slice(prefix.length);
          break;
        }
      }
    return this.originalToolNames.get(name) ?? name;
  }

  private toolFor(item: OutputItem): OutputBlock {
    this.responseHasToolCall = true;
    if (!item.tool) {
      item.tool = this.blockFor(item, 'tool_use');
      this.toolQueue.push(item.tool);
    }
    return item.tool;
  }

  private textFor(item: OutputItem, partIndex: number): OutputBlock {
    let block = item.blocks.get(partIndex);
    if (!block) {
      block = this.blockFor(item, 'text');
      item.blocks.set(partIndex, block);
      this.contentQueue.push(block);
    }
    return block;
  }

  private thinkingFor(item: OutputItem): OutputBlock {
    if (!item.thinking) {
      item.thinking = {
        ...this.blockFor(item, 'thinking'),
        parts: new Map(),
        currentPart: 0,
      };
      this.contentQueue.push(item.thinking);
    }
    return item.thinking;
  }

  private setSnapshot(block: OutputBlock, snapshot: string): void {
    if (!snapshot || block.closed) return;
    if (
      !snapshot.trim() &&
      block.type === 'tool_use' &&
      block.text.trim() === '{}'
    )
      return;
    if (snapshot.startsWith(block.text)) block.text = snapshot;
    else if (!block.emitted) block.text = snapshot;
    // A complete snapshot may not retract bytes already delivered to the SDK.
    else if (snapshot !== block.text)
      this.failConversion(
        'invalid_stream',
        'Upstream Codex changed content after streaming it',
      );
  }

  private failConversion(code: string, message: string): never {
    this.finished = true;
    this.failure = { type: 'api_error', code, message };
    throw new CodexUpstreamError(this.failure);
  }

  private validateToolArguments(block: OutputBlock): void {
    if (!block.text.trim()) {
      // Preserve an already streamed whitespace prefix while completing it
      // as an empty object. An absent arguments field uses the initial {}.
      if (block.text) block.text += '{}';
      return;
    }
    let input: unknown;
    try {
      input = JSON.parse(block.text);
    } catch {
      this.failConversion(
        'invalid_tool_arguments',
        'Upstream Codex tool arguments must be a JSON object',
      );
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      this.failConversion(
        'invalid_tool_arguments',
        'Upstream Codex tool arguments must be a JSON object',
      );
    }
  }

  private updateItem(
    raw: Json,
    data: Json,
    done: boolean,
    events: AnthropicStreamEvent[],
  ): void {
    const type = asString(data.type) ?? '';
    if (
      !['message', 'reasoning', 'function_call', 'web_search_call'].includes(
        type,
      )
    )
      return;
    const item = this.itemFor(raw, data, type);
    if (
      item.done &&
      type !== 'function_call' &&
      !(type === 'reasoning' && !item.thinking?.closed)
    )
      return;
    if (type === 'function_call') {
      const block = this.toolFor(item);
      if (block.closed) return;
      const name = this.restoreToolName(data);
      if (name) {
        block.name = name;
        block.initialEmptyDelta = !done;
      }
      block.callId = asString(data.call_id) || block.callId || item.id || '';
      this.setSnapshot(block, asString(data.arguments) ?? '');
      block.done = done;
      if (done) block.argumentsFinal = true;
      // A pending tool must not close reasoning before its final signature.
      // Its buffered arguments are released after the preceding block's done.
    } else if (type === 'reasoning') {
      const signature = asString(data.encrypted_content);
      // Added cipher snapshots cannot close a block. Keep the reference
      // fallback only until terminal confirms no authoritative cipher exists.
      if (signature && done) item.signature = signature;
      else if (signature) item.fallbackSignature = signature;
      const block = this.thinkingFor(item);
      if (!block.closed && done) {
        const parts = Array.isArray(data.summary)
          ? data.summary
          : Array.isArray(data.content)
            ? data.content
            : [];
        parts.forEach((part, index) => {
          const value = object(part);
          const text =
            asString(value.text) ?? (typeof part === 'string' ? part : '');
          if (text) this.setThinkingPart(block, index, text, false);
        });
        // Only the done frame's cipher is authoritative. With a summary-only
        // done, retain the open block for terminal output to hydrate its cipher.
        block.done = !!signature;
      }
    } else if (type === 'message' && done) {
      const parts = Array.isArray(data.content) ? data.content : [];
      parts.forEach((part, index) => {
        const value = object(part);
        if (value.type !== 'output_text' && value.type !== 'refusal') return;
        if (value.type === 'refusal') this.refused = true;
        const block = this.textFor(item, index);
        this.setSnapshot(
          block,
          asString(value.text) ?? asString(value.refusal) ?? '',
        );
        block.done = true;
      });
      for (const block of item.blocks.values()) block.done = true;
      // Legacy streams may omit the message item identity on text deltas.
      if (
        !parts.length &&
        this.active?.type === 'text' &&
        this.active.item.anonymous
      )
        this.active.done = true;
    } else if (type === 'web_search_call' && done) {
      this.webSearch(item, raw, data);
    }
    item.done = done;
    events.push(...this.flush());
  }

  private setThinkingPart(
    block: OutputBlock,
    index: number,
    text: string,
    delta: boolean,
  ): void {
    if (block.closed) return;
    const parts = block.parts!;
    const previous = parts.get(index) ?? '';
    parts.set(index, delta ? previous + text : text || previous);
    this.setSnapshot(
      block,
      [...parts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, value]) => value)
        .join('\n\n'),
    );
  }

  private updateThinking(
    raw: Json,
    type: string,
    _events: AnthropicStreamEvent[],
  ): void {
    const item = this.itemFor(raw, {}, 'reasoning');
    const block = this.thinkingFor(item);
    if (block.closed) return;
    let part = indexValue(raw.summary_index) ?? indexValue(raw.content_index);
    if (type === 'response.reasoning_summary_part.added') {
      part ??= block.parts!.size ? (block.currentPart ?? 0) + 1 : 0;
      block.currentPart = part;
      if (!block.parts!.has(part)) this.setThinkingPart(block, part, '', false);
    } else {
      part ??= block.currentPart ?? 0;
      block.currentPart = part;
      const value =
        asString(raw.delta) ??
        asString(raw.text) ??
        asString(object(raw.part).text) ??
        '';
      this.setThinkingPart(block, part, value, type.endsWith('.delta'));
    }
  }

  private webSearch(item: OutputItem, raw: Json, data: Json): void {
    const action = object(data.action);
    const query =
      [
        action.query,
        object(raw.action).query,
        data.query,
        raw.query,
        object(data.input).query,
        object(raw.input).query,
      ]
        .map((value) => asString(value)?.trim())
        .find(Boolean) || '';
    const source = [
      data.results,
      raw.results,
      action.sources,
      object(raw.action).sources,
    ].find(Array.isArray);
    const content = Array.isArray(source)
      ? source.flatMap((result) => {
          const value = object(result);
          const url = asString(value.url)?.trim();
          return url
            ? [
                {
                  type: 'web_search_result',
                  url,
                  title: asString(value.title)?.trim() || url,
                  page_age: null,
                },
              ]
            : [];
        })
      : [];
    if (!query && !content.length && !data.action) return;
    const id =
      [
        data.id,
        raw.id,
        data.output_item_id,
        raw.output_item_id,
        data.call_id,
        raw.call_id,
        item.id,
        data.item_id,
        raw.item_id,
      ]
        .map((value) => asString(value)?.trim())
        .find(Boolean) ||
      `web_search_${this.blockIndex + this.contentQueue.length}`;
    const use = this.blockFor(item, 'server_tool_use');
    use.data = { type: 'server_tool_use', id, name: 'web_search', input: {} };
    use.text = query ? JSON.stringify({ query }) : '';
    use.done = true;
    const result = this.blockFor(item, 'web_search_tool_result');
    result.data = { type: 'web_search_tool_result', tool_use_id: id, content };
    result.done = true;
    this.contentQueue.push(use, result);
  }

  private flush(): AnthropicStreamEvent[] {
    const events: AnthropicStreamEvent[] = [];
    for (;;) {
      if (this.active) {
        const block = this.active;
        if (block.type === 'tool_use' && block.done && !block.truncated)
          this.validateToolArguments(block);
        if (block.text.length > block.emitted.length) {
          const value = block.text.slice(block.emitted.length);
          block.emitted = block.text;
          const delta =
            block.type === 'thinking'
              ? { type: 'thinking_delta', thinking: value }
              : block.type === 'text'
                ? { type: 'text_delta', text: value }
                : { type: 'input_json_delta', partial_json: value };
          events.push({
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: block.index, delta },
          });
        }
        if (!block.done) return events;
        if (block.type === 'thinking' && block.item.signature) {
          const signature = encodeReasoningSignature({
            id: block.item.id,
            encryptedContent: block.item.signature,
          });
          if (signature)
            events.push({
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: block.index,
                delta: { type: 'signature_delta', signature },
              },
            });
        }
        events.push({
          event: 'content_block_stop',
          data: { type: 'content_block_stop', index: block.index },
        });
        block.closed = true;
        this.active = null;
      }
      while (this.toolQueue[0]?.closed) this.toolQueue.shift();
      while (this.contentQueue[0]?.closed) this.contentQueue.shift();
      const tool = this.toolQueue[0];
      const block = tool?.name ? tool : this.contentQueue[0];
      if (!block) return events;
      block.index = this.blockIndex++;
      this.active = block;
      if (block.type === 'tool_use') this.hasToolUse = true;
      const content =
        block.type === 'tool_use'
          ? {
              type: 'tool_use',
              id: shortenCodexCallId(block.callId || ''),
              name: block.name,
              input: {},
            }
          : block.type === 'thinking'
            ? { type: 'thinking', thinking: '' }
            : block.type === 'text'
              ? { type: 'text', text: '' }
              : block.data;
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: block.index,
          content_block: content,
        },
      });
      if (block.type === 'tool_use' && block.initialEmptyDelta)
        events.push({
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: block.index,
            delta: { type: 'input_json_delta', partial_json: '' },
          },
        });
    }
  }

  private handleCompleted(
    raw: Json,
    incomplete: boolean,
  ): AnthropicStreamEvent[] {
    const response = object(raw.response);
    const output = Array.isArray(response.output) ? response.output : [];
    // Official needs_follow_up: the backend ended this response but not the
    // turn. Tool calls end the message instead; the client runs them.
    const canFollowUp =
      this.followUpsLeft > 0 &&
      (incomplete
        ? incompleteReason(response) === 'interrupted'
        : response.end_turn === false);
    if (
      !canFollowUp &&
      incomplete &&
      raw.type === 'response.incomplete' &&
      !output.length &&
      !this.completedOutputItems &&
      !this.sawMeaningfulOutput &&
      object(response.usage).output_tokens === 0
    )
      return this.handleFailure({
        message:
          'Upstream Codex terminated with an empty incomplete response (0 output tokens)',
      });
    const events = this.ensureMessageStarted(raw);
    // Hydrate every pending call before draining. Its existing aliases take
    // precedence over a terminal-array position that may omit earlier items.
    output.forEach((value, index) => {
      const item = object(value);
      if (item.type === 'function_call') {
        const existingKeys = [
          asString(item.id) ? `item:${item.id}` : '',
          asString(item.call_id) ? `call:${item.call_id}` : '',
          `output:${indexValue(item.output_index) ?? index}`,
        ];
        const existing = existingKeys
          .map((key) => this.aliases.get(key))
          .find((target) => target?.type === 'function_call');
        if (!existing) return;
        const target = this.itemFor(
          { output_index: indexValue(item.output_index) ?? index },
          item,
          'function_call',
        );
        const block = this.toolFor(target);
        if (block.closed) return;
        const name = this.restoreToolName(item);
        if (name) block.name = name;
        block.callId =
          asString(item.call_id) || block.callId || target.id || '';
        this.setSnapshot(block, asString(item.arguments) ?? '');
        block.done = true;
      }
    });
    for (const block of this.toolQueue) block.done = true;
    // Complete content snapshots fill only bytes not already emitted.
    output.forEach((value, index) => {
      const item = object(value);
      this.updateItem(
        { output_index: indexValue(item.output_index) ?? index },
        item,
        true,
        events,
      );
    });
    for (const item of this.items) {
      for (const block of item.blocks.values()) block.done = true;
      if (item.thinking) {
        item.signature ||= item.fallbackSignature;
        item.thinking.done = true;
      }
    }
    if (this.active) this.active.done = true;
    for (const block of this.toolQueue) if (!block.name) block.closed = true;
    // A truncated response can cut a call mid-arguments. A call not yet
    // started downstream is dropped; one already streaming is closed as is
    // and the message ends with max_tokens, never as a runnable tool_use.
    if (incomplete)
      for (const block of this.toolQueue) {
        if (block.closed || this.toolArgumentsComplete(block)) continue;
        if (block.index === null) block.closed = true;
        else {
          block.truncated = true;
          this.truncatedToolUse = true;
        }
      }
    events.push(...this.flush());
    this.finished = true;
    const usage = responseUsage(response);
    if (canFollowUp && !this.responseHasToolCall) {
      this.followUpsLeft -= 1;
      this.priorUsage = this.priorUsage
        ? addUsage(this.priorUsage, usage)
        : usage;
      const items = this.outputItems.length
        ? this.outputItems
        : output.map(object);
      this.followUpItems = items.flatMap((item) => {
        const replay = replayOutputItem(item);
        return replay ? [replay] : [];
      });
      return events;
    }
    this.usage = this.finalUsage(usage);
    let reason = stopReason(
      response,
      incomplete,
      this.hasToolUse && !this.truncatedToolUse,
      this.refused,
    );
    if (this.truncatedToolUse && reason === 'end_turn') reason = 'max_tokens';
    events.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: {
          stop_reason: reason,
          stop_sequence: asString(response.stop_sequence) || null,
        },
        usage: { ...this.usage },
      },
    });
    events.push({ event: 'message_stop', data: { type: 'message_stop' } });
    return events;
  }

  private toolArgumentsComplete(block: OutputBlock): boolean {
    if (!block.text.trim()) return block.argumentsFinal === true;
    try {
      const input: unknown = JSON.parse(block.text);
      return !!input && typeof input === 'object' && !Array.isArray(input);
    } catch {
      return false;
    }
  }

  /**
   * Usage of every upstream response in this message. Claude Code keeps the
   * message_start input estimate whenever message_delta reports 0 uncached
   * input (a fully cached prompt); one cached token moves into input_tokens
   * so the total it keeps stays exact.
   */
  private finalUsage(last: ResponseUsage): ResponseUsage {
    const usage = this.priorUsage ? addUsage(this.priorUsage, last) : last;
    if (usage.input_tokens > 0 || this.inputTokenEstimate === 0) return usage;
    if (usage.cache_read_input_tokens > 0) {
      usage.cache_read_input_tokens -= 1;
      usage.input_tokens = 1;
    } else if (usage.cache_creation_input_tokens) {
      usage.cache_creation_input_tokens -= 1;
      usage.input_tokens = 1;
      if (!usage.cache_creation_input_tokens)
        delete usage.cache_creation_input_tokens;
    }
    return usage;
  }

  private handleFailure(raw: Json): AnthropicStreamEvent[] {
    if (this.finished) return [];
    this.finished = true;
    this.failure = describeUpstreamFailure(raw);
    return [
      {
        event: 'error',
        data: {
          type: 'error',
          error: { type: this.failure.type, message: this.failure.message },
        },
      },
    ];
  }

  getFailure(): CodexUpstreamFailure | null {
    return this.failure ? { ...this.failure } : null;
  }
  getUsage(): ResponseUsage {
    return structuredClone(this.usage);
  }
}

// ─── 非流式聚合：Codex backend 强制 stream=true，客户端若要非流式
// ─── 响应，由网关聚合完整事件后组装 Anthropic Messages JSON。 ──────

export interface AggregatedAnthropicMessage {
  id: string;
  model: string;
  content: Array<Json>;
  stopReason: StopReason;
  stopSequence?: string | null;
  usage: ResponseUsage;
}

/**
 * 用与流式完全相同的翻译逻辑（converter → Anthropic SSE 事件）聚合出
 * 完整消息：逐块拼装 text/thinking/tool_use 内容与 stop_reason。
 * 上游失败或断流未到 response.completed 时抛错（事件流含 error），
 * 由网关转换为 502，绝不返回截断的部分内容冒充成功。
 */
export function aggregateResponsesStream(
  events: Array<Json>,
  fallbackModel: string,
  options: ResponseConversionOptions = {},
): AggregatedAnthropicMessage {
  const converter = new ResponsesToAnthropicConverter(fallbackModel, options);
  const anthropicEvents: AnthropicStreamEvent[] = [];
  for (const event of events) {
    anthropicEvents.push(...converter.handleEvent(event));
  }
  anthropicEvents.push(...converter.finish());
  return assembleAnthropicMessage(anthropicEvents, converter, fallbackModel);
}

/**
 * Assemble the Anthropic events one converter produced — possibly across
 * several upstream follow-up responses — into a nonstream message.
 */
export function assembleAnthropicMessage(
  anthropicEvents: AnthropicStreamEvent[],
  converter: ResponsesToAnthropicConverter,
  fallbackModel: string,
): AggregatedAnthropicMessage {
  if (anthropicEvents.some(({ event }) => event === 'error')) {
    throw new CodexUpstreamError(
      converter.getFailure() ?? {
        type: 'api_error',
        code: null,
        message: 'Upstream Codex stream ended before completion',
      },
    );
  }

  let id = `msg_${Date.now().toString(36)}`;
  let model = fallbackModel;
  let stopReason: AggregatedAnthropicMessage['stopReason'] = 'end_turn';
  let stopSequence: string | null = null;
  const blocks = new Map<number, { block: Json; jsonParts: string[] }>();

  for (const { event, data } of anthropicEvents) {
    switch (event) {
      case 'message_start': {
        const message = (data.message ?? {}) as Json;
        if (typeof message.id === 'string' && message.id) id = message.id;
        if (typeof message.model === 'string' && message.model) {
          model = message.model;
        }
        break;
      }
      case 'content_block_start': {
        const index = typeof data.index === 'number' ? data.index : blocks.size;
        const contentBlock = (data.content_block ?? {}) as Json;
        const type = asString(contentBlock.type);
        const block: Json = { ...contentBlock, type };
        if (type === 'text') block.text = '';
        if (type === 'thinking') {
          block.thinking = '';
          block.signature = '';
        }
        if (type === 'tool_use' || type === 'server_tool_use') {
          if (typeof contentBlock.id === 'string') block.id = contentBlock.id;
          if (typeof contentBlock.name === 'string') {
            block.name = contentBlock.name;
          }
          block.input = {};
        }
        blocks.set(index, { block, jsonParts: [] });
        break;
      }
      case 'content_block_delta': {
        const acc =
          typeof data.index === 'number' ? blocks.get(data.index) : undefined;
        if (!acc) break;
        const delta = (data.delta ?? {}) as Json;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          acc.block.text = `${asString(acc.block.text) ?? ''}${delta.text}`;
        } else if (
          delta.type === 'thinking_delta' &&
          typeof delta.thinking === 'string'
        ) {
          acc.block.thinking = `${asString(acc.block.thinking) ?? ''}${delta.thinking}`;
        } else if (
          delta.type === 'signature_delta' &&
          typeof delta.signature === 'string'
        ) {
          acc.block.signature = delta.signature;
        } else if (
          delta.type === 'input_json_delta' &&
          typeof delta.partial_json === 'string'
        ) {
          acc.jsonParts.push(delta.partial_json);
        }
        break;
      }
      case 'message_delta': {
        const delta = (data.delta ?? {}) as Json;
        if (
          delta.stop_reason === 'tool_use' ||
          delta.stop_reason === 'max_tokens' ||
          delta.stop_reason === 'end_turn' ||
          delta.stop_reason === 'stop_sequence' ||
          delta.stop_reason === 'pause_turn' ||
          delta.stop_reason === 'refusal' ||
          delta.stop_reason === 'model_context_window_exceeded'
        ) {
          stopReason = delta.stop_reason;
        }
        stopSequence = asString(delta.stop_sequence);
        break;
      }
      default:
        break;
    }
  }

  const content = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([, acc]) => {
      if (
        (acc.block.type === 'tool_use' ||
          acc.block.type === 'server_tool_use') &&
        acc.jsonParts.length > 0
      ) {
        try {
          const argumentsJson = acc.jsonParts.join('');
          const input: unknown = argumentsJson.trim()
            ? JSON.parse(argumentsJson)
            : {};
          if (!input || typeof input !== 'object' || Array.isArray(input))
            throw new Error();
          acc.block.input = input as Json;
        } catch {
          // A call cut by max_output_tokens is dropped, never run partially.
          if (stopReason === 'max_tokens') return [];
          throw new CodexUpstreamError({
            type: 'api_error',
            code: 'invalid_tool_arguments',
            message: 'Upstream Codex tool arguments must be a JSON object',
          });
        }
      }
      return [acc.block];
    })
    .filter((block) => {
      // 丢弃上游断流留下的空块；空 thinking 但有签名的保留（回放仍需签名）。
      if (block.type === 'text') return asString(block.text) !== '';
      if (block.type === 'thinking') {
        return asString(block.thinking) !== '' || asString(block.signature);
      }
      return true;
    });

  return {
    id,
    model,
    content,
    stopReason,
    stopSequence,
    usage: converter.getUsage(),
  };
}
