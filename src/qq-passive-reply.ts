/**
 * Passive-reply bookkeeping for the QQ Bot Open API.
 *
 * QQ splits outbound messages into two classes:
 *
 * - **Passive reply** — the request carries the `msg_id` of an inbound user
 *   message. It is free and does not consume the bot's active-push quota, but
 *   the platform only accepts a handful of replies per `msg_id` and only
 *   within a short window after the user's message.
 * - **Active push** — no `msg_id`. Always allowed, but billed against the
 *   bot's limited active-message quota.
 *
 * This module tracks which inbound `msg_id`s are still usable so `qq.ts` can
 * prefer the free path and silently fall back to an active push once the
 * budget is spent. It is deliberately pure (state in, decision out, injectable
 * clock) so the expiry/exhaustion rules can be unit-tested without a socket.
 *
 * `msg_seq` is returned alongside the `msg_id` because QQ deduplicates on the
 * `(msg_id, msg_seq)` pair: reusing a seq for the same msg_id is rejected as a
 * duplicate, so the counter has to live with the reference, not with the chat.
 */

/** Replies allowed per inbound msg_id. The platform cap is 5; stay one under. */
export const PASSIVE_REPLY_MAX_USES = 4;

/** How long an inbound msg_id stays usable as a passive-reply reference. */
export const PASSIVE_REPLY_TTL_MS = 5 * 60 * 1000;

/** Inbound msg_ids retained per chat, newest last. */
export const PASSIVE_REPLY_MAX_PER_CHAT = 10;

/** Chats tracked before the least-recently-used one is evicted. */
export const PASSIVE_REPLY_MAX_CHATS = 200;

export interface PassiveReplyClaim {
  /** The inbound msg_id to echo back, making this send a passive reply. */
  msgId: string;
  /** Sequence number for this (msg_id, send) pair, starting at 1. */
  msgSeq: number;
}

export interface PassiveReplyStoreOptions {
  ttlMs?: number;
  maxUses?: number;
  maxPerChat?: number;
  maxChats?: number;
}

export interface PassiveReplyStore {
  /** Remember an inbound msg_id as a future passive-reply reference. */
  record(chatKey: string, msgId: string, now?: number): void;
  /**
   * Reserve the freshest still-usable reference for `chatKey`.
   *
   * Returns `undefined` when every known reference is expired or exhausted —
   * the caller should then send an active push (no msg_id).
   *
   * `reserve` keeps that many uses of a reference untouched, so a low-value
   * send can take slack without spending the budget a real reply needs.
   */
  claim(
    chatKey: string,
    now?: number,
    options?: { reserve?: number },
  ): PassiveReplyClaim | undefined;
  /** Retire a reference after the platform definitively rejects it. */
  discard(chatKey: string, msgId: string): void;
  /** Drop all state (used when the socket goes away). */
  clear(): void;
  /** Number of tracked chats. Exposed for tests and diagnostics. */
  size(): number;
}

interface PassiveRef {
  msgId: string;
  receivedAt: number;
  uses: number;
}

export function createPassiveReplyStore(
  options: PassiveReplyStoreOptions = {},
): PassiveReplyStore {
  const ttlMs = options.ttlMs ?? PASSIVE_REPLY_TTL_MS;
  const maxUses = options.maxUses ?? PASSIVE_REPLY_MAX_USES;
  const maxPerChat = options.maxPerChat ?? PASSIVE_REPLY_MAX_PER_CHAT;
  const maxChats = options.maxChats ?? PASSIVE_REPLY_MAX_CHATS;

  // Map iteration order is insertion order, so re-inserting on touch turns
  // this into an LRU: the first key is always the least recently used.
  const chats = new Map<string, PassiveRef[]>();

  function touch(chatKey: string, refs: PassiveRef[]): void {
    chats.delete(chatKey);
    chats.set(chatKey, refs);
    while (chats.size > maxChats) {
      const oldest = chats.keys().next();
      if (oldest.done) break;
      chats.delete(oldest.value);
    }
  }

  return {
    record(chatKey: string, msgId: string, now = Date.now()): void {
      if (!chatKey || !msgId) return;

      const refs = chats.get(chatKey) ?? [];

      // The same msg_id can be recorded twice if an event is redelivered.
      // Neither its platform TTL nor its budget restarts on redelivery.
      const existing = refs.find((ref) => ref.msgId === msgId);
      if (existing) {
        touch(chatKey, refs);
        return;
      }

      refs.push({ msgId, receivedAt: now, uses: 0 });
      while (refs.length > maxPerChat) refs.shift();
      touch(chatKey, refs);
    },

    claim(
      chatKey: string,
      now = Date.now(),
      options?: { reserve?: number },
    ): PassiveReplyClaim | undefined {
      const refs = chats.get(chatKey);
      if (!refs?.length) return undefined;

      const usable = Math.max(0, maxUses - Math.max(0, options?.reserve ?? 0));

      // Newest first: the freshest reference has the most window left.
      for (let i = refs.length - 1; i >= 0; i--) {
        const ref = refs[i]!;
        // Not `break`: a redelivered event refreshes an entry in place, so the
        // list is only approximately ordered by age. The list is capped at
        // `maxPerChat`, so scanning all of it is cheap.
        if (now - ref.receivedAt >= ttlMs) continue;
        if (ref.uses >= usable) continue;
        ref.uses += 1;
        touch(chatKey, refs);
        return { msgId: ref.msgId, msgSeq: ref.uses };
      }

      return undefined;
    },

    discard(chatKey: string, msgId: string): void {
      const refs = chats.get(chatKey);
      if (!refs) return;
      const remaining = refs.filter((ref) => ref.msgId !== msgId);
      if (remaining.length === 0) {
        chats.delete(chatKey);
        return;
      }
      touch(chatKey, remaining);
    },

    clear(): void {
      chats.clear();
    },

    size(): number {
      return chats.size;
    },
  };
}
