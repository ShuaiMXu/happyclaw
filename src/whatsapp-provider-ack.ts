import {
  WAMessageStatus,
  type WASocket,
  type WAMessage,
  type WAMessageUpdate,
} from 'baileys';
import { ImDeliveryPhaseError } from './im-send-retry-policy.js';

/** Baileys resolves on socket write; Meta's server ACK is separately awaited. */
export const WHATSAPP_PROVIDER_ACK_TIMEOUT_MS = 15_000;

type AckOutcome = { kind: 'ack' } | { kind: 'rejected'; errorCode?: string };

interface PendingAck {
  generation: number;
  timer: NodeJS.Timeout;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class WhatsAppProviderAckTracker {
  private activeGeneration: number | null = null;
  private readonly pending = new Map<string, PendingAck>();
  private readonly recent = new Map<
    string,
    { outcome: AckOutcome; receivedAt: number }
  >();

  constructor(private readonly timeoutMs = WHATSAPP_PROVIDER_ACK_TIMEOUT_MS) {}

  activate(generation: number): void {
    this.activeGeneration = generation;
  }

  deactivate(generation: number, reason: string): void {
    if (this.activeGeneration === generation) this.activeGeneration = null;
    for (const [key, pending] of this.pending) {
      if (pending.generation !== generation) continue;
      this.pending.delete(key);
      clearTimeout(pending.timer);
      pending.reject(new ImDeliveryPhaseError('uncertain', reason));
    }
    for (const key of this.recent.keys()) {
      if (key.startsWith(`${generation}:`)) this.recent.delete(key);
    }
  }

  recordServerAck(
    generation: number,
    messageId: string | null | undefined,
    errorCode?: string,
  ): void {
    if (!messageId || generation !== this.activeGeneration) return;
    this.settle(
      generation,
      messageId,
      errorCode ? { kind: 'rejected', errorCode } : { kind: 'ack' },
    );
  }

  observeMessageUpdates(generation: number, updates: WAMessageUpdate[]): void {
    if (generation !== this.activeGeneration) return;
    for (const entry of updates) {
      const messageId = entry.key?.id;
      const status = entry.update?.status;
      if (!messageId || status === null || status === undefined) continue;
      if (status === WAMessageStatus.ERROR) {
        const errorCode = entry.update?.messageStubParameters?.[0];
        this.recordServerAck(
          generation,
          messageId,
          errorCode ? String(errorCode) : 'provider-error',
        );
      } else if (status >= WAMessageStatus.SERVER_ACK) {
        this.recordServerAck(generation, messageId);
      }
    }
  }

  async send(
    socket: WASocket,
    generation: number,
    jid: string,
    content: Parameters<WASocket['sendMessage']>[1],
  ): Promise<void> {
    if (generation !== this.activeGeneration) {
      throw new ImDeliveryPhaseError(
        'pre_accept',
        'WhatsApp provider ACK tracker is unavailable',
      );
    }
    const message = await socket.sendMessage(jid, content);
    await this.wait(generation, message);
  }

  private key(generation: number, messageId: string): string {
    return `${generation}:${messageId}`;
  }

  private rejected(errorCode?: string): ImDeliveryPhaseError {
    return new ImDeliveryPhaseError(
      'rejected',
      `WhatsApp server rejected message${errorCode ? ` (${errorCode})` : ''}`,
    );
  }

  private settle(
    generation: number,
    messageId: string,
    outcome: AckOutcome,
  ): void {
    const key = this.key(generation, messageId);
    const pending = this.pending.get(key);
    if (pending) {
      this.pending.delete(key);
      clearTimeout(pending.timer);
      if (outcome.kind === 'ack') pending.resolve();
      else pending.reject(this.rejected(outcome.errorCode));
      return;
    }
    const now = Date.now();
    this.recent.set(key, { outcome, receivedAt: now });
    for (const [cachedKey, cached] of this.recent) {
      if (
        this.recent.size <= 1000 &&
        now - cached.receivedAt <= 2 * this.timeoutMs
      ) {
        break;
      }
      this.recent.delete(cachedKey);
    }
  }

  private async wait(
    generation: number,
    message: WAMessage | undefined,
  ): Promise<void> {
    const messageId = message?.key?.id;
    if (!messageId) {
      throw new ImDeliveryPhaseError(
        'uncertain',
        'WhatsApp socket write returned without a provider message id',
      );
    }
    const key = this.key(generation, messageId);
    const cached = this.recent.get(key);
    if (cached) {
      this.recent.delete(key);
      if (cached.outcome.kind === 'ack') return;
      throw this.rejected(cached.outcome.errorCode);
    }
    if (generation !== this.activeGeneration) {
      throw new ImDeliveryPhaseError(
        'uncertain',
        'WhatsApp connection changed before provider ACK was observed',
      );
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(
          new ImDeliveryPhaseError(
            'uncertain',
            `WhatsApp provider ACK timed out after ${this.timeoutMs}ms`,
          ),
        );
      }, this.timeoutMs);
      this.pending.set(key, { generation, timer, resolve, reject });
    });
  }
}
