/**
 * In-process bridge between the data-plane cancellation endpoint and the
 * isolated worker. Database cancellation is the durable source of truth; this
 * registry only lets the current process stop an already-running container
 * promptly instead of waiting for its lease heartbeat.
 */
type ExternalCapabilityExecutionStop = () => boolean | Promise<boolean>;

const activeExecutionStops = new Map<
  string,
  Set<ExternalCapabilityExecutionStop>
>();

export function registerExternalCapabilityExecution(
  runId: string,
  stop: ExternalCapabilityExecutionStop,
): () => void {
  const stops = activeExecutionStops.get(runId) ?? new Set();
  stops.add(stop);
  activeExecutionStops.set(runId, stops);
  return () => {
    const current = activeExecutionStops.get(runId);
    if (!current) return;
    current.delete(stop);
    if (current.size === 0) activeExecutionStops.delete(runId);
  };
}

export type ExternalCapabilityExecutionStopResult =
  | 'not_found'
  | 'stopped'
  | 'unverified';

/**
 * Stop a process-local execution and report whether container absence was
 * verified. Durable cancellation remains the cross-process source of truth.
 */
export async function stopExternalCapabilityExecution(
  runId: string,
): Promise<ExternalCapabilityExecutionStopResult> {
  const stops = activeExecutionStops.get(runId);
  if (!stops || stops.size === 0) return 'not_found';
  const results = await Promise.allSettled([...stops].map((stop) => stop()));
  return results.every(
    (result) => result.status === 'fulfilled' && result.value === true,
  )
    ? 'stopped'
    : 'unverified';
}
