import { describe, expect, test } from 'vitest';

import {
  createPassiveReplyStore,
  PASSIVE_REPLY_MAX_USES,
  PASSIVE_REPLY_TTL_MS,
} from '../src/qq-passive-reply.js';

const T0 = 1_700_000_000_000;

describe('createPassiveReplyStore', () => {
  test('returns nothing for an unknown chat', () => {
    const store = createPassiveReplyStore();
    expect(store.claim('c2c:u1', T0)).toBeUndefined();
  });

  test('claims the recorded msg_id and numbers seq from 1', () => {
    const store = createPassiveReplyStore();
    store.record('c2c:u1', 'm1', T0);

    expect(store.claim('c2c:u1', T0)).toEqual({ msgId: 'm1', msgSeq: 1 });
    expect(store.claim('c2c:u1', T0)).toEqual({ msgId: 'm1', msgSeq: 2 });
  });

  test('stops handing out a msg_id once its budget is spent', () => {
    const store = createPassiveReplyStore();
    store.record('c2c:u1', 'm1', T0);

    for (let i = 1; i <= PASSIVE_REPLY_MAX_USES; i++) {
      expect(store.claim('c2c:u1', T0)).toEqual({ msgId: 'm1', msgSeq: i });
    }

    // Budget exhausted → caller must fall back to an active push.
    expect(store.claim('c2c:u1', T0)).toBeUndefined();
  });

  test('stops handing out a msg_id once the window closes', () => {
    const store = createPassiveReplyStore();
    store.record('c2c:u1', 'm1', T0);

    expect(store.claim('c2c:u1', T0 + PASSIVE_REPLY_TTL_MS - 1)).toEqual({
      msgId: 'm1',
      msgSeq: 1,
    });
    expect(store.claim('c2c:u1', T0 + PASSIVE_REPLY_TTL_MS)).toBeUndefined();
  });

  test('prefers the freshest reference', () => {
    const store = createPassiveReplyStore();
    store.record('c2c:u1', 'm1', T0);
    store.record('c2c:u1', 'm2', T0 + 1_000);

    expect(store.claim('c2c:u1', T0 + 1_000)?.msgId).toBe('m2');
  });

  test('falls back to an older reference when the newest is exhausted', () => {
    const store = createPassiveReplyStore();
    store.record('c2c:u1', 'm1', T0);
    store.record('c2c:u1', 'm2', T0 + 1_000);

    for (let i = 0; i < PASSIVE_REPLY_MAX_USES; i++) {
      expect(store.claim('c2c:u1', T0 + 1_000)?.msgId).toBe('m2');
    }
    // m2 is spent but m1 is still inside its window.
    expect(store.claim('c2c:u1', T0 + 1_000)).toEqual({
      msgId: 'm1',
      msgSeq: 1,
    });
  });

  test('skips an expired newer reference to reach a live older one', () => {
    // The injected clock can observe events out of timestamp order; the store
    // must inspect every bounded entry rather than assume array age ordering.
    const store = createPassiveReplyStore();
    store.record('c2c:u1', 'm1', T0 + PASSIVE_REPLY_TTL_MS - 1);
    store.record('c2c:u1', 'm2', T0);

    // m2 is newest in insertion order but expired; m1 is still live.
    const claim = store.claim('c2c:u1', T0 + PASSIVE_REPLY_TTL_MS);
    expect(claim?.msgId).toBe('m1');
  });

  test('redelivery neither refreshes TTL nor resets budget', () => {
    const store = createPassiveReplyStore();
    store.record('c2c:u1', 'm1', T0);
    store.claim('c2c:u1', T0);

    store.record('c2c:u1', 'm1', T0 + PASSIVE_REPLY_TTL_MS - 1);
    expect(store.claim('c2c:u1', T0 + PASSIVE_REPLY_TTL_MS)).toBeUndefined();
  });

  test('typing, stream, text, and media share one per-msg_id sequence', () => {
    const store = createPassiveReplyStore();
    store.record('c2c:u1', 'm1', T0);

    const typing = store.claim('c2c:u1', T0, { reserve: 2 });
    const stream = store.claim('c2c:u1', T0);
    const text = store.claim('c2c:u1', T0);
    const media = store.claim('c2c:u1', T0);

    expect([typing, stream, text, media].map((claim) => claim?.msgSeq)).toEqual(
      [1, 2, 3, 4],
    );
    expect(
      new Set([typing, stream, text, media].map((claim) => claim?.msgId)),
    ).toEqual(new Set(['m1']));
  });

  test('discard retires a definitively rejected reference', () => {
    const store = createPassiveReplyStore();
    store.record('c2c:u1', 'm1', T0);
    store.discard('c2c:u1', 'm1');
    expect(store.claim('c2c:u1', T0)).toBeUndefined();
  });

  test('reserve leaves budget for higher-value sends', () => {
    const store = createPassiveReplyStore();
    store.record('c2c:u1', 'm1', T0);

    // A typing indicator reserves 2, so it may only take the first 2 of 4.
    expect(store.claim('c2c:u1', T0, { reserve: 2 })?.msgSeq).toBe(1);
    expect(store.claim('c2c:u1', T0, { reserve: 2 })?.msgSeq).toBe(2);
    expect(store.claim('c2c:u1', T0, { reserve: 2 })).toBeUndefined();

    // The reserved uses are still there for an unreserved caller.
    expect(store.claim('c2c:u1', T0)?.msgSeq).toBe(3);
    expect(store.claim('c2c:u1', T0)?.msgSeq).toBe(4);
    expect(store.claim('c2c:u1', T0)).toBeUndefined();
  });

  test('a reserve at or above the cap yields nothing', () => {
    const store = createPassiveReplyStore();
    store.record('c2c:u1', 'm1', T0);

    expect(
      store.claim('c2c:u1', T0, { reserve: PASSIVE_REPLY_MAX_USES }),
    ).toBeUndefined();
    expect(store.claim('c2c:u1', T0, { reserve: 99 })).toBeUndefined();
    // ...and nothing was consumed by the refusals.
    expect(store.claim('c2c:u1', T0)?.msgSeq).toBe(1);
  });

  test('a negative reserve cannot widen the budget', () => {
    const store = createPassiveReplyStore();
    store.record('c2c:u1', 'm1', T0);

    for (let i = 1; i <= PASSIVE_REPLY_MAX_USES; i++) {
      expect(store.claim('c2c:u1', T0, { reserve: -5 })?.msgSeq).toBe(i);
    }
    expect(store.claim('c2c:u1', T0, { reserve: -5 })).toBeUndefined();
  });

  test('keeps chats isolated from each other', () => {
    const store = createPassiveReplyStore();
    store.record('c2c:u1', 'm1', T0);
    store.record('group:g1', 'm2', T0);

    expect(store.claim('c2c:u1', T0)?.msgId).toBe('m1');
    expect(store.claim('group:g1', T0)?.msgId).toBe('m2');
  });

  test('drops the oldest reference past maxPerChat', () => {
    const store = createPassiveReplyStore({ maxPerChat: 2 });
    store.record('c1', 'm1', T0);
    store.record('c1', 'm2', T0);
    store.record('c1', 'm3', T0);

    // m1 was evicted; m3 and m2 remain and are consumed newest-first.
    const seen = new Set<string>();
    for (let i = 0; i < 2 * PASSIVE_REPLY_MAX_USES; i++) {
      const claim = store.claim('c1', T0);
      if (claim) seen.add(claim.msgId);
    }
    expect(seen).toEqual(new Set(['m2', 'm3']));
  });

  test('evicts the least recently used chat past maxChats', () => {
    const store = createPassiveReplyStore({ maxChats: 2 });
    store.record('c1', 'm1', T0);
    store.record('c2', 'm2', T0);
    store.record('c3', 'm3', T0);

    expect(store.size()).toBe(2);
    expect(store.claim('c1', T0)).toBeUndefined();
    expect(store.claim('c2', T0)?.msgId).toBe('m2');
    expect(store.claim('c3', T0)?.msgId).toBe('m3');
  });

  test('claiming counts as use for LRU ordering', () => {
    const store = createPassiveReplyStore({ maxChats: 2 });
    store.record('c1', 'm1', T0);
    store.record('c2', 'm2', T0);
    store.claim('c1', T0); // c1 becomes most recently used
    store.record('c3', 'm3', T0); // evicts c2, not c1

    expect(store.claim('c1', T0)?.msgId).toBe('m1');
    expect(store.claim('c2', T0)).toBeUndefined();
  });

  test('ignores empty keys and ids', () => {
    const store = createPassiveReplyStore();
    store.record('', 'm1', T0);
    store.record('c1', '', T0);

    expect(store.size()).toBe(0);
    expect(store.claim('c1', T0)).toBeUndefined();
  });

  test('clear drops everything', () => {
    const store = createPassiveReplyStore();
    store.record('c1', 'm1', T0);
    store.clear();

    expect(store.size()).toBe(0);
    expect(store.claim('c1', T0)).toBeUndefined();
  });
});
