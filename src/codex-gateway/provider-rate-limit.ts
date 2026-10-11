/**
 * Fixed windows keyed only by authenticated grant IDs, never bearer keys. The
 * gateway keys them per runner grant, so one busy runner cannot spend the
 * budget of every other workspace sharing the same provider.
 */
export class CodexProviderRateLimiter {
  private readonly counters = new Map<
    string,
    { windowStart: number; count: number }
  >();

  constructor(
    private readonly capacity = 1024,
    private readonly maxRequests = 120,
    private readonly windowMs = 60_000,
  ) {}

  get size(): number {
    return this.counters.size;
  }

  isLimited(key: string, now = Date.now()): boolean {
    const current = this.counters.get(key);
    if (current && now - current.windowStart < this.windowMs) {
      current.count += 1;
      return current.count > this.maxRequests;
    }
    this.counters.delete(key);
    // Map insertion order is window-start order. Remove only expired heads,
    // once each, rather than scanning every live counter for every new ID.
    while (this.counters.size) {
      const [oldestKey, oldest] = this.counters.entries().next().value!;
      if (now - oldest.windowStart < this.windowMs) break;
      this.counters.delete(oldestKey);
    }
    // Do not evict live counters: that would let active keys reset their
    // budgets. A full table fails closed until a window expires.
    if (this.counters.size >= this.capacity) return true;
    this.counters.set(key, { windowStart: now, count: 1 });
    return false;
  }

  /**
   * Milliseconds until a limited key may send again: its own window end, or
   * for a full table the end of the oldest live window.
   */
  retryAfterMs(key: string, now = Date.now()): number {
    const window =
      this.counters.get(key) ?? this.counters.values().next().value;
    if (!window) return 0;
    return Math.max(0, window.windowStart + this.windowMs - now);
  }
}
