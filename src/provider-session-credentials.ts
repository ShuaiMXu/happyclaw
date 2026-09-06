import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import { listSessionNamespacesForProviderId } from './db.js';
import { logger } from './logger.js';
import {
  writeCredentialsFile,
  type ClaudeProviderConfig,
} from './runtime-config.js';
import { isValidWorkspaceFolderName } from './workspace-folder.js';

const SESSION_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Fan a Provider credential rotation only into session namespaces that are
 * durably bound to that Provider. Unbound and other-Provider directories are
 * deliberately left untouched; their next launch writes the selected config.
 */
export function updateProviderSessionCredentials(
  providerId: string,
  config: ClaudeProviderConfig,
): { updated: number; skipped: number } {
  if (!config.claudeOAuthCredentials) return { updated: 0, skipped: 0 };
  let updated = 0;
  let skipped = 0;
  let namespaces: ReturnType<typeof listSessionNamespacesForProviderId>;
  try {
    namespaces = listSessionNamespacesForProviderId(providerId);
  } catch (err) {
    logger.warn(
      { err, providerId },
      'Failed to list Provider-scoped session credentials',
    );
    return { updated: 0, skipped: 0 };
  }
  for (const namespace of namespaces) {
    if (
      !isValidWorkspaceFolderName(namespace.groupFolder) ||
      (namespace.agentId !== null &&
        !SESSION_AGENT_ID_RE.test(namespace.agentId))
    ) {
      skipped++;
      continue;
    }
    const claudeDir = namespace.agentId
      ? path.join(
          DATA_DIR,
          'sessions',
          namespace.groupFolder,
          'agents',
          namespace.agentId,
          '.claude',
        )
      : path.join(DATA_DIR, 'sessions', namespace.groupFolder, '.claude');
    try {
      if (!fs.existsSync(claudeDir) || !fs.statSync(claudeDir).isDirectory()) {
        skipped++;
        continue;
      }
      writeCredentialsFile(claudeDir, config);
      updated++;
    } catch (err) {
      skipped++;
      logger.warn(
        {
          err,
          providerId,
          groupFolder: namespace.groupFolder,
          agentId: namespace.agentId,
        },
        'Failed to update Provider-scoped session credentials',
      );
    }
  }
  return { updated, skipped };
}
