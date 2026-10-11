// ─── ChatGPT/Codex 订阅网关 — 安装 ID ──────────────────────────────
//
// 官方客户端在 $CODEX_HOME/installation_id 保存一个稳定 UUID
// （core/src/installation_id.rs），每个请求的 client_metadata 与 turn metadata
// 都带上它。HappyClaw 每个安装一个，保存在 data/config 下；它不含账号信息，
// 所有 provider 共用。文件不可写时退回进程内 ID，不影响请求。

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cachedInstallationId: string | undefined;
/** Tests: a different file, or null for an in-memory ID only. */
let pathOverride: string | null | undefined;

/**
 * HAPPYCLAW_CODEX_INSTALLATION_ID_FILE relocates the file; an empty value
 * keeps the ID in memory only (the test runner sets that so suites never
 * write into a real data directory).
 */
function installationIdPath(): string | null {
  if (pathOverride !== undefined) return pathOverride;
  const configured = process.env.HAPPYCLAW_CODEX_INSTALLATION_ID_FILE;
  if (configured !== undefined) return configured.trim() || null;
  return path.join(DATA_DIR, 'config', 'codex-installation-id');
}

export function codexInstallationId(): string {
  if (cachedInstallationId) return cachedInstallationId;
  const file = installationIdPath();
  if (file) {
    try {
      const existing = readFileSync(file, 'utf8').trim();
      if (UUID_PATTERN.test(existing)) {
        cachedInstallationId = existing.toLowerCase();
        return cachedInstallationId;
      }
    } catch {
      // Missing or unreadable: create one below.
    }
  }
  const installationId = randomUUID();
  if (file) {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const tmpFile = `${file}.tmp`;
      writeFileSync(tmpFile, installationId, { mode: 0o644 });
      renameSync(tmpFile, file);
    } catch (err) {
      logger.warn(
        { err },
        'Codex gateway: failed to persist the installation id',
      );
    }
  }
  cachedInstallationId = installationId;
  return installationId;
}

/** Test hook: forget the cached ID and optionally move its file. */
export function resetCodexInstallationIdForTests(file?: string | null): void {
  cachedInstallationId = undefined;
  pathOverride = file;
}
