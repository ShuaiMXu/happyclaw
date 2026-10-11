// 第三方 Anthropic 兼容端点的「测试连接」：用与 Runner 相同的认证头和自定义
// Header 直接调一次 POST {base}/v1/messages（max_tokens 很小），在保存前就暴露
// 端点、密钥、认证方式和模型名的配置错误，而不是等到真实对话里才失败。
// 结果只回传状态码、耗时和脱敏后的错误摘要，绝不回传密钥。

import { createRequire } from 'node:module';

import type { ProviderAuthMode } from './runtime-config.js';

const require = createRequire(import.meta.url);

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ERROR_EXCERPT = 300;
/** Model probed when a pass-through relay leaves the provider model empty. */
export const PASS_THROUGH_PROBE_MODEL = 'claude-haiku-5-5';

export interface ProviderConnectivityInput {
  baseUrl: string;
  token: string;
  authMode: ProviderAuthMode;
  model: string;
  customHeaders?: string;
}

export interface ProviderConnectivityProbe {
  model: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  /** Redacted upstream error excerpt; absent on success. */
  message?: string;
  /** What to check next, in the admin's language. */
  hint?: string;
}

function claudeCodeUserAgent(): string {
  // Some coding-plan endpoints only admit coding agents, so probe with the
  // same User-Agent family the bundled Claude Code sends.
  try {
    const pkg = require('@anthropic-ai/claude-agent-sdk/package.json') as {
      claudeCodeVersion?: string;
    };
    if (pkg.claudeCodeVersion) {
      return `claude-cli/${pkg.claudeCodeVersion} (external, sdk-ts)`;
    }
  } catch {
    // Fall through to a version-less agent string.
  }
  return 'claude-cli (external, sdk-ts)';
}

/** `Name: value` lines, as Claude Code reads ANTHROPIC_CUSTOM_HEADERS. */
export function parseCustomHeaders(
  raw: string | undefined,
): [string, string][] {
  if (!raw) return [];
  const headers: [string, string][] = [];
  for (const line of raw.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) headers.push([name, value]);
  }
  return headers;
}

/** Same URL Claude Code builds: the SDK appends `/v1/messages` to the base. */
export function buildMessagesUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/v1/messages`;
}

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join('***');
  }
  // Long opaque tokens that might be echoed back by a gateway.
  out = out.replace(/\b(sk|ak|key|tok)[-_][A-Za-z0-9_-]{12,}\b/gi, '***');
  return out.length > MAX_ERROR_EXCERPT
    ? `${out.slice(0, MAX_ERROR_EXCERPT)}…`
    : out;
}

function upstreamMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown; type?: unknown } | string;
      message?: unknown;
      msg?: unknown;
    };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error && typeof parsed.error.message === 'string') {
      return parsed.error.message;
    }
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.msg === 'string') return parsed.msg;
  } catch {
    // Not JSON; use the raw text.
  }
  return body.trim();
}

export function hintForStatus(
  status: number | null,
  message: string,
  authMode: ProviderAuthMode,
): string | undefined {
  if (status === null) {
    return /abort|timeout/i.test(message)
      ? '请求超时：检查端点是否可达，或网络是否需要代理'
      : '无法连接端点：检查地址、端口和网络连通性';
  }
  if (status === 401 || status === 403) {
    const other = authMode === 'bearer' ? 'x-api-key' : 'Bearer';
    return `认证失败：检查 API 密钥是否正确，或把认证方式切换为 ${other} 再试`;
  }
  if (status === 404) {
    return /model/i.test(message)
      ? '模型不存在：检查模型名称是否为该端点支持的值'
      : '路径不存在：端点通常填到 /anthropic 这一级，不要以 /v1 或 /v1/messages 结尾';
  }
  if (status === 400 && /model/i.test(message)) {
    return '请求被拒绝：检查模型名称是否为该端点支持的值';
  }
  if (status === 429) return '已触发限流或额度用尽，稍后再试';
  if (status >= 500) return '端点服务端错误，稍后再试或联系服务商';
  return undefined;
}

export async function probeProviderModel(
  input: ProviderConnectivityInput,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ProviderConnectivityProbe> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // Claude Code strips the [1m] suffix before calling the API.
  const model =
    input.model.replace(/\[1m\]$/i, '').trim() || PASS_THROUGH_PROBE_MODEL;
  const token = input.token.replace(/^Bearer\s+/i, '');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'user-agent': claudeCodeUserAgent(),
  };
  for (const [name, value] of parseCustomHeaders(input.customHeaders)) {
    headers[name.toLowerCase()] = value;
  }
  if (input.authMode === 'x-api-key') headers['x-api-key'] = token;
  else headers.authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const startedAt = Date.now();
  try {
    const res = await fetchImpl(buildMessagesUrl(input.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (res.ok) {
      await res.body?.cancel().catch(() => {});
      return { model, ok: true, status: res.status, latencyMs };
    }
    const message = redact(upstreamMessage(await res.text().catch(() => '')), [
      token,
    ]);
    return {
      model,
      ok: false,
      status: res.status,
      latencyMs,
      message: message || `HTTP ${res.status}`,
      hint: hintForStatus(res.status, message, input.authMode),
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const message = redact(
      controller.signal.aborted ? `timeout: ${raw}` : raw,
      [token],
    );
    return {
      model,
      ok: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      message,
      hint: hintForStatus(null, message, input.authMode),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe the provider model and, when Haiku is mapped to a different model
 * (background calls such as titles use it), that model too.
 */
export async function testProviderConnectivity(
  input: ProviderConnectivityInput & { haikuModel?: string },
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ ok: boolean; probes: ProviderConnectivityProbe[] }> {
  const models = [input.model];
  const haiku = input.haikuModel?.trim();
  if (haiku && haiku !== input.model.trim()) models.push(haiku);
  const probes = await Promise.all(
    models.map((model) => probeProviderModel({ ...input, model }, options)),
  );
  return { ok: probes.every((probe) => probe.ok), probes };
}
