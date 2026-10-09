import type { ContainerOutput } from './agent-runtime-contracts.js';

export type ExternalStartAuthorizationDecision = 'start' | 'abort';
export type ExternalStartAuthorizationOutcome =
  | ExternalStartAuthorizationDecision
  | 'acknowledged';

export const EXTERNAL_START_PUBLICATION_HEADROOM_MS = 5_000;

export class ExternalStartAuthorizationExpiredError extends Error {}

export interface ExternalStartAuthorizationControl {
  type: 'external_ready' | 'external_start_consumed';
  protocol: 1;
  authorizationId: string;
}

type ControllerState = 'waiting_ready' | 'start_published' | 'acknowledged';

function isExactControl(
  value: unknown,
  authorizationId: string,
  type: ExternalStartAuthorizationControl['type'],
): value is ExternalStartAuthorizationControl {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const control = value as Record<string, unknown>;
  const allowedKeys = new Set(['type', 'protocol', 'authorizationId']);
  return (
    Object.keys(control).every((key) => allowedKeys.has(key)) &&
    control.type === type &&
    control.protocol === 1 &&
    control.authorizationId === authorizationId
  );
}

function isExactControlFrame(
  value: unknown,
  authorizationId: string,
  type: ExternalStartAuthorizationControl['type'],
): value is ContainerOutput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const frame = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'status',
    'result',
    'runnerControl',
    'inputTurnId',
  ]);
  return (
    Object.keys(frame).every((key) => allowedKeys.has(key)) &&
    frame.status === 'stream' &&
    frame.result === null &&
    (frame.inputTurnId === undefined ||
      typeof frame.inputTurnId === 'string') &&
    isExactControl(frame.runnerControl, authorizationId, type)
  );
}

/**
 * Completes the two-phase START handshake. READY authorizes and durably
 * publishes START. The runner then reports that it consumed START and waits;
 * only after the host durably stores that acknowledgement and publishes the
 * read-only confirmation may the runner cross the SDK query() boundary.
 */
export class ExternalStartAuthorizationController {
  private state: ControllerState = 'waiting_ready';

  constructor(
    private readonly authorizationId: string,
    private readonly expiresAt: number,
    private readonly authorizeStart: (publishStart: () => void) => boolean,
    private readonly publishDecision: (
      decision: ExternalStartAuthorizationDecision,
    ) => void,
    private readonly acknowledgeStart: () => void,
    private readonly now: () => number = Date.now,
    private readonly publicationHeadroomMs = EXTERNAL_START_PUBLICATION_HEADROOM_MS,
  ) {}

  private publishAbortWithoutMasking(error: unknown): never {
    try {
      this.publishDecision('abort');
    } catch {
      // Preserve the protocol or durable-authorization failure as the cause.
    }
    throw error;
  }

  private handleReady(frame: unknown): ExternalStartAuthorizationDecision {
    if (!isExactControlFrame(frame, this.authorizationId, 'external_ready')) {
      return this.publishAbortWithoutMasking(
        new Error('External runner emitted invalid READY control frame'),
      );
    }
    const publicationDeadline =
      this.expiresAt - Math.max(0, this.publicationHeadroomMs);
    if (this.now() >= publicationDeadline) {
      return this.publishAbortWithoutMasking(
        new ExternalStartAuthorizationExpiredError(
          'External runner READY control expired or lacks START publication headroom',
        ),
      );
    }
    let startPublished = false;
    try {
      const authorized = this.authorizeStart(() => {
        if (startPublished) {
          throw new Error('External START decision was published twice');
        }
        if (this.now() >= publicationDeadline) {
          throw new ExternalStartAuthorizationExpiredError(
            'External runner START authorization expired or lacks publication headroom',
          );
        }
        this.publishDecision('start');
        startPublished = true;
      });
      if (authorized && startPublished) {
        this.state = 'start_published';
        return 'start';
      }
      if (authorized || startPublished) {
        throw new Error('External START authorization contract was violated');
      }
    } catch (error) {
      if (startPublished) throw error;
      return this.publishAbortWithoutMasking(error);
    }
    this.publishDecision('abort');
    return 'abort';
  }

  private handleConsumed(frame: unknown): 'acknowledged' {
    if (
      !isExactControlFrame(
        frame,
        this.authorizationId,
        'external_start_consumed',
      )
    ) {
      throw new Error(
        'External runner emitted invalid START-consumed control frame',
      );
    }
    if (this.now() >= this.expiresAt) {
      throw new ExternalStartAuthorizationExpiredError(
        'External runner START consumption acknowledgement expired',
      );
    }
    // The callback must persist the acknowledgement before publishing the
    // confirmation file that releases the runner into query().
    this.acknowledgeStart();
    this.state = 'acknowledged';
    return 'acknowledged';
  }

  handle(frame: unknown): ExternalStartAuthorizationOutcome {
    if (this.state === 'waiting_ready') return this.handleReady(frame);
    if (this.state === 'start_published') return this.handleConsumed(frame);
    throw new Error(
      'External runner emitted control after START acknowledgement',
    );
  }
}
