/**
 * A connector call may fan one logical message out to several provider
 * mutations. Once any mutation has an ACK, replaying the whole call is unsafe:
 * a later error describes only the tail, not the already-visible prefix.
 */
export class PartialChannelDeliveryError extends Error {
  readonly code = 'CHANNEL_DELIVERY_PARTIAL';
  readonly outcome = 'uncertain';

  constructor(
    readonly deliveredOutputs: number,
    readonly totalOutputs: number,
    cause: unknown,
  ) {
    super(
      `Channel delivery stopped after ${deliveredOutputs}/${totalOutputs} physical outputs were acknowledged`,
      { cause },
    );
    this.name = 'PartialChannelDeliveryError';
  }
}

/** Track the ACK boundary across every provider mutation in one connector call. */
export class PhysicalDeliveryTracker {
  private deliveredOutputs = 0;

  constructor(private readonly totalOutputs: number) {}

  async send(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
      this.deliveredOutputs += 1;
    } catch (error) {
      if (this.deliveredOutputs > 0) {
        throw new PartialChannelDeliveryError(
          this.deliveredOutputs,
          this.totalOutputs,
          error,
        );
      }
      throw error;
    }
  }
}
