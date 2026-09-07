/**
 * A connection-scoped lease for asynchronous inbound work.
 *
 * Provider SDKs keep event listeners alive while a connection is being torn
 * down.  A lease lets every awaited boundary prove that it still belongs to
 * the connection which admitted it before it performs a durable side effect.
 */
export interface ChannelInboundLease {
  generation: number;
  signal: AbortSignal;
}

export class ChannelInboundCancelledError extends Error {
  readonly code = 'CHANNEL_INBOUND_CANCELLED';

  constructor() {
    super('Channel inbound operation was cancelled by connection teardown');
    this.name = 'ChannelInboundCancelledError';
  }
}

interface InFlightInboundOperation {
  generation: number;
  promise: Promise<void>;
}

/**
 * Owns the generation, abort signal, active callback registry, and per-message
 * single-flight registry for one connector instance.
 */
export class ChannelInboundLifecycle {
  private generation = 0;
  private abortController: AbortController | null = null;
  private readonly activeCallbacks = new Set<Promise<void>>();
  private readonly inFlightMessages = new Map<
    string,
    InFlightInboundOperation
  >();

  /** Start a fresh physical connection and fence all work from its predecessor. */
  begin(): ChannelInboundLease {
    this.abortController?.abort();
    const abortController = new AbortController();
    const generation = ++this.generation;
    this.abortController = abortController;
    return { generation, signal: abortController.signal };
  }

  /** Fence the current connection before its transport or shared state is cleared. */
  invalidate(): void {
    this.generation += 1;
    const abortController = this.abortController;
    this.abortController = null;
    abortController?.abort();
  }

  isCurrent(lease: ChannelInboundLease): boolean {
    return (
      lease.generation === this.generation &&
      this.abortController?.signal === lease.signal &&
      !lease.signal.aborted
    );
  }

  assertCurrent(lease: ChannelInboundLease): void {
    if (!this.isCurrent(lease)) {
      throw new ChannelInboundCancelledError();
    }
  }

  isCancellation(error: unknown, lease?: ChannelInboundLease): boolean {
    return (
      error instanceof ChannelInboundCancelledError ||
      (lease !== undefined && !this.isCurrent(lease))
    );
  }

  /** Register a provider callback so disconnect can await its terminal state. */
  track<T extends Promise<void>>(task: T): T {
    this.activeCallbacks.add(task);
    const remove = (): void => {
      this.activeCallbacks.delete(task);
    };
    task.then(remove, remove);
    return task;
  }

  /**
   * Run one provider message once.
   *
   * Same-generation redeliveries share the exact result. A new connection
   * waits for a stale attempt to observe cancellation, then is allowed to
   * process the provider redelivery. The durable dedup marker is written only
   * after the operation and its final generation check both succeed.
   */
  async runMessage(
    lease: ChannelInboundLease,
    messageKey: string | undefined,
    isDuplicate: (messageKey: string) => boolean,
    markSeen: (messageKey: string) => void,
    operation: () => Promise<void>,
  ): Promise<void> {
    this.assertCurrent(lease);
    if (!messageKey) {
      await operation();
      this.assertCurrent(lease);
      return;
    }

    if (isDuplicate(messageKey)) return;

    while (true) {
      const existing = this.inFlightMessages.get(messageKey);
      if (!existing) break;
      if (existing.generation === lease.generation) {
        await existing.promise;
        return;
      }

      // The preceding connection owns this attempt. It has already been
      // aborted by begin(); wait for its cleanup before admitting redelivery.
      await existing.promise.catch(() => undefined);
      this.assertCurrent(lease);
      if (isDuplicate(messageKey)) return;
    }

    const promise = operation();
    this.inFlightMessages.set(messageKey, {
      generation: lease.generation,
      promise,
    });
    try {
      await promise;
      this.assertCurrent(lease);
      markSeen(messageKey);
    } finally {
      const current = this.inFlightMessages.get(messageKey);
      if (current?.promise === promise) {
        this.inFlightMessages.delete(messageKey);
      }
    }
  }

  /** Wait until every callback admitted before teardown has settled. */
  async settle(): Promise<void> {
    while (this.activeCallbacks.size > 0) {
      await Promise.allSettled([...this.activeCallbacks]);
    }
    this.inFlightMessages.clear();
  }
}
