import { describe, expect, test } from 'vitest';

import {
  DEFAULT_MAX_TRANSIENT_RETRIES,
  TransientRetryLedger,
  PROVIDER_FAILURE_USER_NOTICE,
  PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE,
  resolveTransientRetryKey,
} from '../src/provider-failure.js';

describe('liveness retry ledger', () => {
  test('grants exactly one same-provider replay per input turn', () => {
    const ledger = new TransientRetryLedger();
    expect(DEFAULT_MAX_TRANSIENT_RETRIES).toBe(1);
    expect(ledger.consume('turn-a')).toBe(true);
    expect(ledger.consume('turn-a')).toBe(false);
  });

  test('budgets are independent per input turn', () => {
    const ledger = new TransientRetryLedger();
    expect(ledger.consume('turn-a')).toBe(true);
    expect(ledger.consume('turn-b')).toBe(true);
    expect(ledger.consume('turn-a')).toBe(false);
    expect(ledger.consume('turn-b')).toBe(false);
  });

  test('a spent turn stops occupying the ledger', () => {
    const ledger = new TransientRetryLedger();
    ledger.consume('turn-a');
    expect(ledger.trackedTurnCount).toBe(1);
    ledger.consume('turn-a');
    expect(ledger.trackedTurnCount).toBe(0);
  });

  test('fails closed without a durable turn identity', () => {
    const ledger = new TransientRetryLedger();
    expect(ledger.consume(undefined)).toBe(false);
    expect(ledger.consume('')).toBe(false);
    expect(ledger.trackedTurnCount).toBe(0);
  });

  test('honours a larger retry budget', () => {
    const ledger = new TransientRetryLedger(3);
    expect(ledger.consume('turn-a')).toBe(true);
    expect(ledger.consume('turn-a')).toBe(true);
    expect(ledger.consume('turn-a')).toBe(true);
    expect(ledger.consume('turn-a')).toBe(false);
  });

  test('evicts in insertion order instead of growing without bound', () => {
    const ledger = new TransientRetryLedger(1, 2);
    ledger.consume('turn-a');
    ledger.consume('turn-b');
    expect(ledger.trackedTurnCount).toBe(2);

    // Turns that later succeed never clear their entry, so a third distinct
    // stall must evict the oldest rather than push the ledger past its cap.
    ledger.consume('turn-c');
    expect(ledger.trackedTurnCount).toBe(2);

    // 'turn-a' was evicted, so it reads as a fresh turn with a full budget.
    expect(ledger.consume('turn-a')).toBe(true);
    // 'turn-c' is still tracked and stays spent.
    expect(ledger.consume('turn-c')).toBe(false);
  });
});

describe('liveness retry key', () => {
  test('prefers the durable message id over the per-hand-off deliveryId', () => {
    expect(
      resolveTransientRetryKey({
        inputTurnId: 'delivery-uuid-1',
        ipcReceipts: [{ cursor: { id: 'msg-1' } }],
      }),
    ).toBe('msg-1');
  });

  test('a replayed turn keeps its budget even as the deliveryId rotates', () => {
    const ledger = new TransientRetryLedger();
    // Warm turn: deliveryId is a fresh UUID per IPC hand-off.
    const warm = {
      inputTurnId: 'delivery-uuid-1',
      ipcReceipts: [{ cursor: { id: 'msg-1' } }],
    };
    // The replay spawns a cold runner, whose ContainerInput.turnId is the
    // durable message id. Both must resolve to the same budget.
    const cold = { inputTurnId: 'msg-1' };

    expect(ledger.consume(resolveTransientRetryKey(warm))).toBe(true);
    expect(ledger.consume(resolveTransientRetryKey(cold))).toBe(false);
  });

  test('falls back to inputTurnId for a cold, non-IPC turn', () => {
    expect(resolveTransientRetryKey({ inputTurnId: 'msg-2' })).toBe('msg-2');
    expect(resolveTransientRetryKey({})).toBeUndefined();
    expect(resolveTransientRetryKey({ ipcReceipts: [] })).toBeUndefined();
  });
});

describe('liveness timeout user notice', () => {
  test('never reuses the quota wording', () => {
    expect(PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE).not.toBe(
      PROVIDER_FAILURE_USER_NOTICE,
    );
    expect(PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE).not.toContain('额度已用尽');
    expect(PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE).toContain('与账号额度无关');
  });
});
