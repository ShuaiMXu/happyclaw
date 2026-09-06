export const MAX_PENDING_RESCAN_TARGETS = 256;
export const RESCAN_COALESCE_DELAY_MS = 50;

/**
 * Coalesce filesystem events without retaining an unbounded path backlog.
 *
 * A burst with more unique targets than the configured bound is represented
 * by one authoritative full-root scan. The caller keeps all path validation
 * and descriptor-relative traversal in its scan callbacks.
 */
export function createBoundedRescanScheduler({
  runTarget,
  runFull,
  onError,
  maxPendingTargets = MAX_PENDING_RESCAN_TARGETS,
  delayMs = RESCAN_COALESCE_DELAY_MS,
}) {
  if (!Number.isSafeInteger(maxPendingTargets) || maxPendingTargets <= 0) {
    throw new Error('maxPendingTargets must be a positive safe integer');
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new Error('delayMs must be a non-negative safe integer');
  }

  const pendingTargets = new Map();
  let fullScanPending = false;
  let timer;
  let stopped = false;

  function drain() {
    timer = undefined;
    if (stopped) return;

    const scanFullRoot = fullScanPending;
    const targets = scanFullRoot ? [] : [...pendingTargets.values()];
    fullScanPending = false;
    pendingTargets.clear();

    try {
      if (scanFullRoot) {
        runFull();
        return;
      }
      for (const target of targets) runTarget(target);
    } catch (error) {
      onError(error);
    }
  }

  function schedule() {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(drain, delayMs);
    timer.unref?.();
  }

  return {
    enqueueTarget(key, target) {
      if (stopped || fullScanPending || pendingTargets.has(key)) return;
      if (pendingTargets.size >= maxPendingTargets) {
        pendingTargets.clear();
        fullScanPending = true;
      } else {
        pendingTargets.set(key, target);
      }
      schedule();
    },

    enqueueFull() {
      if (stopped) return;
      pendingTargets.clear();
      fullScanPending = true;
      schedule();
    },

    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pendingTargets.clear();
      fullScanPending = false;
    },

    getPendingTargetCount() {
      return pendingTargets.size;
    },

    isFullScanPending() {
      return fullScanPending;
    },
  };
}
