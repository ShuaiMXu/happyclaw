// ─── ChatGPT/Codex 订阅网关 — 官方客户端身份 ─────────────────────────
//
// 网关对上游的每个请求都以同一个官方 Codex CLI 版本的身份发出。版本号、
// originator 与 User-Agent 必须彼此一致，并且不低于目录里模型要求的
// minimal_client_version，否则后端可以识别出矛盾或按版本拒绝。升级时以
// openai/codex 的发布版本为准，同时核对 models.json 的 minimal_client_version。

import { execFileSync } from 'node:child_process';
import os from 'node:os';

/** Version of the official Codex CLI whose client behavior this gateway mirrors. */
export const CODEX_CLIENT_VERSION = '0.162.1';

/** `originator` the official interactive client (codex-tui) sends. */
export const CODEX_ORIGINATOR = 'codex-tui';

export interface CodexUserAgentHost {
  platform: NodeJS.Platform;
  /** `os.release()`: kernel release on Linux/macOS, build on Windows. */
  release: string;
  /** `os.machine()`, i.e. `uname -m`. */
  machine: string;
  /** macOS product version (`sw_vers -productVersion`), when known. */
  macosVersion?: string;
  env: Record<string, string | undefined>;
}

/** login/src/auth/default_client.rs sanitize_user_agent: header-safe ASCII. */
function headerSafe(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '_');
}

/** terminal-detection's token alphabet; anything else becomes `_`. */
function terminalToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._/-]/g, '_');
}

function osDescription(host: CodexUserAgentHost): string {
  // os_info names: "Mac OS 26.5.2", "Windows 10.0.26100", "Linux 6.8.0".
  if (host.platform === 'darwin') {
    if (host.macosVersion?.trim()) return `Mac OS ${host.macosVersion.trim()}`;
    // Without sw_vers, map the kernel: Darwin 25 is macOS 26 and Darwin
    // 20–24 are macOS 11–15; the minor version carries over.
    const [major, minor = '0'] = host.release.split('.');
    const darwin = Number(major);
    if (!Number.isInteger(darwin)) return 'Mac OS Unknown';
    return `Mac OS ${darwin >= 25 ? darwin + 1 : darwin - 9}.${minor}`;
  }
  if (host.platform === 'win32') return `Windows ${host.release}`;
  const kernel = /^\d+(?:\.\d+){0,2}/.exec(host.release)?.[0] ?? 'Unknown';
  return `Linux ${kernel}`;
}

/**
 * terminal-detection user_agent(): TERM_PROGRAM[/version] unless it names
 * tmux, else TERM, else "unknown". A service started without a terminal is
 * "unknown", exactly like a headless official CLI.
 */
function terminalDescription(env: CodexUserAgentHost['env']): string {
  const program = env.TERM_PROGRAM?.trim();
  if (program && program.toLowerCase() !== 'tmux') {
    const version = env.TERM_PROGRAM_VERSION?.trim();
    return terminalToken(version ? `${program}/${version}` : program);
  }
  const term = env.TERM?.trim();
  return term ? terminalToken(term) : 'unknown';
}

/**
 * Official User-Agent (default_client.rs get_codex_user_agent plus the
 * app-server's `{clientInfo.name}; {clientInfo.version}` suffix the TUI sets):
 * `codex-tui/0.162.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.162.1)`.
 * The OS, architecture and terminal describe the host running HappyClaw.
 */
export function buildCodexUserAgent(host: CodexUserAgentHost): string {
  return headerSafe(
    `${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION} (${osDescription(host)}; ${host.machine || 'unknown'}) ${terminalDescription(host.env)} (${CODEX_ORIGINATOR}; ${CODEX_CLIENT_VERSION})`,
  );
}

let cachedUserAgent: string | undefined;

function macosProductVersion(): string | undefined {
  try {
    return execFileSync('/usr/bin/sw_vers', ['-productVersion'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/** The host's official-format User-Agent, computed once per process. */
export function codexUserAgent(): string {
  cachedUserAgent ??= buildCodexUserAgent({
    platform: process.platform,
    release: os.release(),
    machine: os.machine(),
    ...(process.platform === 'darwin'
      ? { macosVersion: macosProductVersion() }
      : {}),
    env: process.env,
  });
  return cachedUserAgent;
}

/**
 * default_client.rs default_headers(): every official HTTP client, including
 * the auth client used for token refresh and revocation, sends these.
 */
export function codexClientHeaders(): Record<string, string> {
  return { originator: CODEX_ORIGINATOR, 'User-Agent': codexUserAgent() };
}

/**
 * Headers for the ChatGPT Codex backend. The built-in OpenAI provider adds
 * `version` to every model request (model-provider-info create_openai_provider).
 */
export function codexBackendClientHeaders(): Record<string, string> {
  return { ...codexClientHeaders(), version: CODEX_CLIENT_VERSION };
}
