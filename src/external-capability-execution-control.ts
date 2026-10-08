/**
 * In-process bridge between the data-plane cancellation endpoint and the
 * isolated worker. Database cancellation is the durable source of truth; this
 * registry only lets the current process stop an already-running container
 * promptly instead of waiting for its lease heartbeat.
 */
const activeExecutionStops = new Map<string, () => void>();

export function registerExternalCapabilityExecution(
  runId: string,
  stop: () => void,
): () => void {
  activeExecutionStops.set(runId, stop);
  return () => {
    if (activeExecutionStops.get(runId) === stop) {
      activeExecutionStops.delete(runId);
    }
  };
}

/** Returns true only when this process was actively executing the run. */
export function stopExternalCapabilityExecution(runId: string): boolean {
  const stop = activeExecutionStops.get(runId);
  if (!stop) return false;
  stop();
  return true;
}
