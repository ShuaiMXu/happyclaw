import crypto from 'node:crypto';

import { markdownToPlainText, splitTextChunks } from './im-utils.js';

export const WECHAT_TEXT_CHUNK_LIMIT = 2000;

/** Normalize first so the exact provider payload is what the outbox splits. */
export function prepareWeChatTextChunks(text: string): string[] {
  return splitTextChunks(markdownToPlainText(text), WECHAT_TEXT_CHUNK_LIMIT);
}

/** iLink expects a decimal uint32 client_id; derive it from durable identity. */
export function weChatClientIdForChunk(
  outboxItemId: string,
  chunkIndex: number,
): string {
  if (!outboxItemId) throw new Error('WeChat delivery identity is required');
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error('WeChat chunk index must be a non-negative integer');
  }
  return String(
    crypto
      .createHash('sha256')
      .update(outboxItemId)
      .update('\0')
      .update(String(chunkIndex))
      .digest()
      .readUInt32BE(0),
  );
}
