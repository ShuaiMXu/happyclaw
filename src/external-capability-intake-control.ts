let activeIntakes = 0;
let activeDownloads = 0;

/**
 * Protect process-local parsers, decoders and synchronous Vault writes without
 * creating an attacker-controlled in-memory wait queue. Durable cross-process
 * admission remains the database reservation's responsibility.
 */
export function tryAcquireExternalCapabilityIntakeSlot(
  limit: number,
): (() => void) | null {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('External capability intake limit must be positive');
  }
  if (activeIntakes >= limit) return null;
  activeIntakes += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeIntakes = Math.max(0, activeIntakes - 1);
  };
}

export function tryAcquireExternalCapabilityDownloadSlot(
  limit: number,
): (() => void) | null {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('External capability download limit must be positive');
  }
  if (activeDownloads >= limit) return null;
  activeDownloads += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeDownloads = Math.max(0, activeDownloads - 1);
  };
}

export function getActiveExternalCapabilityIntakesForTest(): number {
  return activeIntakes;
}

export function getActiveExternalCapabilityDownloadsForTest(): number {
  return activeDownloads;
}

export function resetExternalCapabilityIntakesForTest(): void {
  activeIntakes = 0;
  activeDownloads = 0;
}
