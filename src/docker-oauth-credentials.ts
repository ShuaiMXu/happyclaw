import fs from 'node:fs';

import {
  normalizeClaudeAiOauth,
  type KeychainClaudeAiOauth,
} from './macos-keychain-credentials.js';
import {
  updateProviderOAuthCredentialsIfCurrent,
  type ClaudeOAuthCredentials,
} from './runtime-config.js';

const MAX_DOCKER_CREDENTIAL_FILE_BYTES = 64 * 1024;

export type DockerOAuthReconcileOutcome =
  | 'missing'
  | 'invalid'
  | 'unchanged'
  | 'not_newer'
  | 'stale'
  | 'updated';

export interface ReconcileDockerOAuthCredentialsOptions {
  providerId: string;
  credentialsFilePath: string;
  launchCredentials: ClaudeOAuthCredentials;
  persistRefreshedCredentials?: (
    expected: ClaudeOAuthCredentials,
    refreshed: ClaudeOAuthCredentials,
  ) => boolean;
}

function canonicalOAuth(credentials: KeychainClaudeAiOauth): string {
  return JSON.stringify(normalizeClaudeAiOauth(credentials));
}

export function dockerOAuthCredentialsEqual(
  left: ClaudeOAuthCredentials,
  right: ClaudeOAuthCredentials,
): boolean {
  try {
    return canonicalOAuth(left) === canonicalOAuth(right);
  } catch {
    return false;
  }
}

/**
 * Read the complete Claude OAuth value from a Docker session credential file.
 * The file is writable by Claude Code, so incomplete or non-regular payloads
 * are ignored rather than being allowed into Provider configuration.
 */
export function readDockerClaudeOAuthCredentials(
  credentialsFilePath: string,
): ClaudeOAuthCredentials | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(credentialsFilePath);
  } catch {
    return null;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size <= 0 ||
    stat.size > MAX_DOCKER_CREDENTIAL_FILE_BYTES
  ) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(credentialsFilePath, 'utf8'),
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const oauth = normalizeClaudeAiOauth(
      (parsed as Record<string, unknown>).claudeAiOauth,
    );
    return { ...oauth };
  } catch {
    return null;
  }
}

/**
 * Adopt a Docker SDK credential rotation only while the selected Provider is
 * still exactly the credential snapshot used for this launch. A concurrent
 * administrator update therefore wins the CAS and can never be overwritten by
 * a runner that exits later.
 */
export function reconcileDockerOAuthCredentials(
  options: ReconcileDockerOAuthCredentialsOptions,
): DockerOAuthReconcileOutcome {
  const refreshed = readDockerClaudeOAuthCredentials(
    options.credentialsFilePath,
  );
  if (!refreshed) {
    return fs.existsSync(options.credentialsFilePath) ? 'invalid' : 'missing';
  }

  let expected: ClaudeOAuthCredentials;
  try {
    expected = { ...normalizeClaudeAiOauth(options.launchCredentials) };
  } catch {
    return 'invalid';
  }
  if (dockerOAuthCredentialsEqual(expected, refreshed)) {
    return 'unchanged';
  }
  // A token refresh extends the credential lifetime. Do not persist arbitrary
  // rewrites of the writable session file that do not carry that evidence.
  if (refreshed.expiresAt <= expected.expiresAt) return 'not_newer';

  const persist =
    options.persistRefreshedCredentials ??
    ((launch, next) =>
      updateProviderOAuthCredentialsIfCurrent(
        options.providerId,
        launch,
        next,
      ));
  try {
    return persist(expected, refreshed) ? 'updated' : 'stale';
  } catch {
    // Provider deletion and concurrent configuration changes are both stale
    // launch outcomes, not runtime failures for the completed user turn.
    return 'stale';
  }
}
