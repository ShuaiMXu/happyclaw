import { removeFlowArtifacts } from './file-manager.js';
import {
  claimWorkspaceFilesystemCleanup,
  completeWorkspaceFilesystemCleanup,
  failWorkspaceFilesystemCleanup,
  listWorkspaceFilesystemCleanupOutbox,
  type WorkspaceFilesystemCleanupAttempt,
} from './db.js';
import { logger } from './logger.js';

export function cleanupWorkspaceFilesystem(
  folder: string,
): WorkspaceFilesystemCleanupAttempt {
  const claimed = claimWorkspaceFilesystemCleanup(folder);
  if (claimed.status !== 'claimed') return claimed;

  try {
    // Recursive deletion and fsync can be slow. Keep them outside SQLite while
    // the durable tombstone continues to reject every folder publisher.
    removeFlowArtifacts(folder);
  } catch (error) {
    return failWorkspaceFilesystemCleanup(claimed.claim, error);
  }
  return completeWorkspaceFilesystemCleanup(claimed.claim);
}

/** Retry every durable workspace cleanup tombstone during service startup. */
export function sweepPendingWorkspaceFilesystemCleanups(): {
  cleaned: number;
  pending: number;
  blocked: number;
} {
  const summary = { cleaned: 0, pending: 0, blocked: 0 };
  for (const entry of listWorkspaceFilesystemCleanupOutbox()) {
    const result = cleanupWorkspaceFilesystem(entry.folder);
    summary[result.status] += 1;
    if (result.status === 'pending') {
      logger.error(
        { folder: result.folder, error: result.error },
        'Workspace filesystem cleanup remains pending',
      );
    } else if (result.status === 'blocked') {
      logger.error(
        { folder: result.folder, survivingJids: result.survivingJids },
        'Workspace filesystem cleanup blocked by surviving registration',
      );
    }
  }
  return summary;
}
