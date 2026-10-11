// ─── ChatGPT/Codex 订阅网关 — 官方客户端身份 ─────────────────────────
//
// 网关对上游的每个请求都以同一个官方 Codex CLI 版本的身份发出。版本号、
// originator 与 User-Agent 必须彼此一致，并且不低于目录里模型要求的
// minimal_client_version，否则后端可以识别出矛盾或按版本拒绝。升级时以
// openai/codex 的发布版本为准，同时核对 models.json 的 minimal_client_version。

/** Version of the official Codex CLI whose client behavior this gateway mirrors. */
export const CODEX_CLIENT_VERSION = '0.162.1';

/** `originator` the official interactive client (codex-tui) sends. */
export const CODEX_ORIGINATOR = 'codex-tui';
