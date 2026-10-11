// ─── ChatGPT/Codex 订阅网关 — 共享类型 ───────────────────────────
//
// 网关把 Anthropic Messages API 翻译成 ChatGPT 订阅后端
// (chatgpt.com/backend-api/codex/responses，OpenAI Responses API 方言)，
// 让 Claude Agent SDK 通过 ANTHROPIC_BASE_URL 直接使用 ChatGPT 订阅额度。

/** 存储在 provider secrets 中的 Codex OAuth 凭据（AES-256-GCM 加密落盘）。 */
export interface CodexOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  /** epoch ms；由 expires_in 换算。 */
  expiresAt: number;
  /** id_token JWT `https://api.openai.com/auth.chatgpt_account_id`；用于选择上游账号。 */
  accountId: string | null;
  /** id_token JWT `https://api.openai.com/auth.chatgpt_plan_type` claim（plus/pro/...）。 */
  planType: string | null;
  email: string | null;
  /**
   * id_token `auth.chatgpt_account_is_fedramp`; requests then carry
   * `X-OpenAI-Fedramp: true` (model-provider bearer_auth_provider.rs).
   * Absent on credentials saved before this field existed.
   */
  isFedramp?: boolean;
  updatedAt: string;
}

/**
 * 最近一次上游 token 刷新失败的状态，落在 provider 的非机密配置里（不进 secrets）。
 * 分类与官方 login/src/auth/manager.rs 一致：
 * - reauth_required：401、400 + invalid_grant，或 refresh_token_expired /
 *   refresh_token_reused / refresh_token_invalidated，只有重新登录 ChatGPT 才能
 *   恢复；凭据更换前不再发起刷新。
 * - transient：其余一切失败——网络、超时、5xx/429，以及其他 4xx（例如
 *   Cloudflare 的 403），按退避自动重试。
 * 凭据写入（重新登录、刷新成功、清除）时一并清掉。
 */
export interface CodexOAuthRefreshErrorState {
  kind: 'reauth_required' | 'transient';
  /** 已脱敏、有长度上限的原因描述，可直接展示给管理员。 */
  message: string;
  /** ISO 时间。 */
  at: string;
  /** reauth_required 时：上游已经拒绝了当前 access_token，凭据彻底不可用。 */
  accessTokenRejected?: boolean;
}

/**
 * ChatGPT 订阅型 provider 的 anthropicBaseUrl 存储占位值。
 * 保留 http(s) 形式以通过 URL 校验并复用第三方 endpoint 的运行时默认值；
 * 在 env 构建时按执行模式改写为实际网关地址（127.0.0.1 / host.docker.internal）。
 */
export const CODEX_GATEWAY_BASE_URL_PLACEHOLDER =
  'http://happyclaw-codex-gateway.internal';

/** 网关挂载路径（主服务内）。 */
export const CODEX_GATEWAY_ROUTE = '/gateway/chatgpt';

/** Codex OAuth 的 OpenAI 官方 CLI 公共客户端参数（openai/codex 官方确认允许第三方使用）。 */
export const CODEX_OAUTH_AUTHORIZE_URL =
  'https://auth.openai.com/oauth/authorize';
export const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
/** login/src/auth/manager.rs REVOKE_TOKEN_URL. */
export const CODEX_OAUTH_REVOKE_URL = 'https://auth.openai.com/oauth/revoke';
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';
/** 用户粘贴回调 URL 时接受的来源：浏览器可能把 localhost 解析/改写成 127.0.0.1。 */
export const CODEX_OAUTH_CALLBACK_ORIGINS: readonly string[] = [
  'http://localhost:1455',
  'http://127.0.0.1:1455',
];
export const CODEX_OAUTH_SCOPES =
  'openid profile email offline_access api.connectors.read api.connectors.invoke';

/** ChatGPT 订阅后端。 */
export const CODEX_BACKEND_RESPONSES_URL =
  'https://chatgpt.com/backend-api/codex/responses';

/** OAuth 流程在内存中的有效期。 */
export const CODEX_OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;

/** 上游 access_token 提前刷新余量。 */
export const CODEX_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
