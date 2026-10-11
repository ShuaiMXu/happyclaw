// ─── ChatGPT/Codex 订阅 — 登录结果落到 provider 的决策 ─────────────────
//
// OAuth 回调路由的纯函数部分：解析用户粘贴的回调内容；新建 provider 的默认
// 模型与推理力度；对已有 provider 重新授权时判断账号是否变化、是否是从其他
// 类型转换过来、模型与内部网关标识如何处理。

import {
  CODEX_DEFAULT_MODEL,
  resolveCodexDefaultEffort,
  type CodexModelCatalogEntry,
} from './model-catalog.js';
import {
  CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
  CODEX_OAUTH_CALLBACK_ORIGINS,
  type CodexOAuthCredentials,
} from './types.js';

export type CodexCallbackParams =
  | { kind: 'code'; code: string; state: string | null }
  | {
      kind: 'error';
      error: string;
      description: string | null;
      state: string | null;
    };

/** OAuth error fields are shown back to the admin: keep them short, one line. */
function callbackText(value: string | null, limit: number): string | null {
  if (!value) return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned;
}

function fromSearchParams(params: URLSearchParams): CodexCallbackParams | null {
  const state = params.get('state');
  const error = callbackText(params.get('error'), 64);
  if (error) {
    return {
      kind: 'error',
      error,
      description: callbackText(params.get('error_description'), 200),
      state,
    };
  }
  const code = params.get('code');
  return code ? { kind: 'code', code, state } : null;
}

/**
 * 粘贴回来的可能是完整跳转失败的 URL、它的 query 部分，或裸 code。
 * URL 只接受官方回调地址（localhost / 127.0.0.1 的 1455 端口）；其他来源一律
 * 拒绝，防止把任意第三方 URL 里的参数误当授权码（纵深防御：伪造 code 本身也会
 * 因 PKCE 校验失败）。授权页带回的 error= 也解析出来，给出明确提示。
 */
export function extractCodexCallbackParams(
  input: string,
): CodexCallbackParams | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let url: URL | null = null;
  try {
    url = new URL(trimmed);
  } catch {
    url = null;
  }
  if (url) {
    if (!CODEX_OAUTH_CALLBACK_ORIGINS.includes(url.origin)) return null;
    return fromSearchParams(url.searchParams);
  }
  if (/(?:^|[?&])(?:code|error)=/.test(trimmed)) {
    return fromSearchParams(
      new URLSearchParams(trimmed.slice(trimmed.indexOf('?') + 1)),
    );
  }
  return { kind: 'code', code: trimmed, state: null };
}

/** Default model and effort for a freshly created ChatGPT provider. */
export function codexProviderCreationDefaults(
  catalog: readonly CodexModelCatalogEntry[],
): { anthropicModel: string; customEnv: Record<string, string> } {
  return {
    anthropicModel: CODEX_DEFAULT_MODEL,
    customEnv: {
      CODEX_REASONING_EFFORT: resolveCodexDefaultEffort(
        catalog,
        CODEX_DEFAULT_MODEL,
      ),
    },
  };
}

/**
 * Whether a login replaces the ChatGPT account behind a provider. Encrypted
 * reasoning from one account cannot be replayed to another, so a change must
 * invalidate the provider's sessions. Without an account ID on both sides,
 * fall back to the e-mail; unknown identity on either side counts as changed.
 */
export function codexAccountChanged(
  previous: CodexOAuthCredentials | null | undefined,
  next: CodexOAuthCredentials,
): boolean {
  if (!previous) return true;
  if (previous.accountId || next.accountId) {
    return previous.accountId !== next.accountId;
  }
  return !previous.email || previous.email !== next.email;
}

export interface CodexReauthorizationPlan {
  /** The provider was not a ChatGPT provider before this login. */
  converted: boolean;
  accountChanged: boolean;
  /** Model to store; unchanged unless a conversion needs a Codex model. */
  anthropicModel: string;
  /** Replacement customEnv, or undefined to keep it as is. */
  customEnv?: Record<string, string>;
  /**
   * Generate a fresh internal gateway identifier. A converted provider's old
   * anthropicAuthToken was a real third-party secret, not an identifier.
   */
  rotateGatewayIdentifier: boolean;
}

export function planCodexReauthorization(
  previous: {
    anthropicBaseUrl: string;
    anthropicAuthToken: string;
    anthropicModel: string;
    customEnv: Record<string, string>;
    codexOAuthCredentials: CodexOAuthCredentials | null;
  },
  credentials: CodexOAuthCredentials,
  catalog: readonly CodexModelCatalogEntry[],
): CodexReauthorizationPlan {
  const converted =
    previous.anthropicBaseUrl !== CODEX_GATEWAY_BASE_URL_PLACEHOLDER ||
    !previous.codexOAuthCredentials;
  const accountChanged =
    converted ||
    codexAccountChanged(previous.codexOAuthCredentials, credentials);
  if (!converted) {
    return {
      converted,
      accountChanged,
      anthropicModel: previous.anthropicModel,
      rotateGatewayIdentifier: !previous.anthropicAuthToken,
    };
  }
  const anthropicModel = catalog.some(
    (entry) => entry.value === previous.anthropicModel,
  )
    ? previous.anthropicModel
    : CODEX_DEFAULT_MODEL;
  const customEnv = previous.customEnv?.CODEX_REASONING_EFFORT?.trim()
    ? undefined
    : {
        ...previous.customEnv,
        CODEX_REASONING_EFFORT: resolveCodexDefaultEffort(
          catalog,
          anthropicModel,
        ),
      };
  return {
    converted,
    accountChanged,
    anthropicModel,
    ...(customEnv ? { customEnv } : {}),
    rotateGatewayIdentifier: true,
  };
}
