const WINDOW_MS = 60_000;
const MAX_CLIENT_BUCKETS = 10_000;
const DEFAULT_GLOBAL_LIMIT = 600;
const DEFAULT_CLIENT_LIMIT = 120;

type RateBucket = { windowStartedAt: number; count: number };

let globalBucket: RateBucket = { windowStartedAt: 0, count: 0 };
const clientBuckets = new Map<string, RateBucket>();

function configuredLimit(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 1_000_000
    ? parsed
    : fallback;
}

function rollBucketWindow(bucket: RateBucket, now: number): void {
  if (now - bucket.windowStartedAt >= WINDOW_MS) {
    bucket.windowStartedAt = now;
    bucket.count = 0;
  }
}

function pruneClientBuckets(now: number): void {
  for (const [clientId, bucket] of clientBuckets) {
    if (now - bucket.windowStartedAt >= WINDOW_MS) {
      clientBuckets.delete(clientId);
    }
  }
}

/**
 * Cheap process-local admission fence that runs before bearer hashing or any
 * SQLite lookup. Durable per-key limits still apply after authentication.
 */
export function consumeExternalCapabilityAuthAdmission(input: {
  clientId: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const now = input.now ?? Date.now();
  const env = input.env ?? process.env;
  const globalLimit = configuredLimit(
    env,
    'EXTERNAL_CAPABILITY_UNAUTH_REQUESTS_PER_MINUTE',
    DEFAULT_GLOBAL_LIMIT,
  );
  const clientLimit = configuredLimit(
    env,
    'EXTERNAL_CAPABILITY_UNAUTH_PER_CLIENT_REQUESTS_PER_MINUTE',
    DEFAULT_CLIENT_LIMIT,
  );

  rollBucketWindow(globalBucket, now);
  let bucket = clientBuckets.get(input.clientId);
  if (bucket) {
    rollBucketWindow(bucket, now);
  } else {
    if (clientBuckets.size >= MAX_CLIENT_BUCKETS) {
      pruneClientBuckets(now);
      if (clientBuckets.size >= MAX_CLIENT_BUCKETS) return false;
    }
    bucket = { windowStartedAt: now, count: 0 };
  }

  // Admission is a two-bucket transaction. A request rejected by either limit
  // must not consume the other limit, otherwise one abusive client can spend
  // the entire global allowance on requests already rejected locally.
  if (globalBucket.count >= globalLimit || bucket.count >= clientLimit) {
    return false;
  }
  globalBucket.count += 1;
  bucket.count += 1;
  clientBuckets.set(input.clientId, bucket);
  return true;
}

export function resetExternalCapabilityAuthAdmissionForTest(): void {
  globalBucket = { windowStartedAt: 0, count: 0 };
  clientBuckets.clear();
}
