import { describe, expect, test, vi } from 'vitest';

import {
  EXTERNAL_START_PUBLICATION_HEADROOM_MS,
  ExternalStartAuthorizationController,
} from '../src/external-start-authorization.js';

const readyControl = {
  type: 'external_ready' as const,
  protocol: 1 as const,
  authorizationId: 'attempt-1',
};
const readyFrame = {
  status: 'stream' as const,
  result: null,
  runnerControl: readyControl,
};
const consumedFrame = {
  status: 'stream' as const,
  result: null,
  runnerControl: {
    type: 'external_start_consumed' as const,
    protocol: 1 as const,
    authorizationId: 'attempt-1',
  },
};

describe('external host start authorization', () => {
  test('persists START and the consumption acknowledgement in order', () => {
    const calls: string[] = [];
    const controller = new ExternalStartAuthorizationController(
      'attempt-1',
      10_000,
      (publishStart) => {
        calls.push('persist');
        publishStart();
        return true;
      },
      (decision) => calls.push(`publish:${decision}`),
      () => calls.push('acknowledge'),
      () => 1_000,
    );

    expect(controller.handle(readyFrame)).toBe('start');
    expect(controller.handle(consumedFrame)).toBe('acknowledged');
    expect(calls).toEqual(['persist', 'publish:start', 'acknowledge']);
  });

  test('rejects START when durable authorization crosses the deadline', () => {
    let currentTime = 1_000;
    const publish = vi.fn();
    const controller = new ExternalStartAuthorizationController(
      'attempt-1',
      10_000,
      (publishStart) => {
        currentTime = 10_000;
        publishStart();
        return true;
      },
      publish,
      vi.fn(),
      () => currentTime,
    );

    expect(() => controller.handle(readyFrame)).toThrow(/expired/);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith('abort');
  });

  test('does not begin durable authorization inside publication headroom', () => {
    const authorize = vi.fn();
    const publish = vi.fn();
    const expiresAt = 10_000;
    const controller = new ExternalStartAuthorizationController(
      'attempt-1',
      expiresAt,
      authorize,
      publish,
      vi.fn(),
      () => expiresAt - EXTERNAL_START_PUBLICATION_HEADROOM_MS,
    );

    expect(() => controller.handle(readyFrame)).toThrow(/headroom/);
    expect(authorize).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith('abort');
  });

  test('publishes ABORT when durable authorization is denied', () => {
    const publish = vi.fn();
    const controller = new ExternalStartAuthorizationController(
      'attempt-1',
      10_000,
      () => false,
      publish,
      vi.fn(),
      () => 1_000,
    );

    expect(controller.handle(readyFrame)).toBe('abort');
    expect(publish).toHaveBeenCalledWith('abort');
  });

  test('publishes ABORT and preserves durable authorization failures', () => {
    const publish = vi.fn(() => {
      throw new Error('decision path unavailable');
    });
    const controller = new ExternalStartAuthorizationController(
      'attempt-1',
      10_000,
      () => {
        throw new Error('database unavailable');
      },
      publish,
      vi.fn(),
      () => 1_000,
    );

    expect(() => controller.handle(readyFrame)).toThrow(/database unavailable/);
    expect(publish).toHaveBeenCalledWith('abort');
  });

  test('fails closed on invalid, duplicate, and expired control frames', () => {
    const authorize = vi.fn((publishStart: () => void) => {
      publishStart();
      return true;
    });
    const publish = vi.fn();
    const mismatched = new ExternalStartAuthorizationController(
      'attempt-1',
      10_000,
      authorize,
      publish,
      vi.fn(),
      () => 1_000,
    );
    expect(() =>
      mismatched.handle({
        ...readyFrame,
        runnerControl: { ...readyControl, authorizationId: 'attempt-2' },
      }),
    ).toThrow(/invalid READY/);
    expect(authorize).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith('abort');

    const terminalOuterFrame = new ExternalStartAuthorizationController(
      'attempt-1',
      10_000,
      authorize,
      publish,
      vi.fn(),
      () => 1_000,
    );
    expect(() =>
      terminalOuterFrame.handle({ ...readyFrame, status: 'error' }),
    ).toThrow(/invalid READY/);

    const duplicate = new ExternalStartAuthorizationController(
      'attempt-1',
      10_000,
      authorize,
      publish,
      vi.fn(),
      () => 1_000,
    );
    expect(duplicate.handle(readyFrame)).toBe('start');
    expect(() => duplicate.handle(readyFrame)).toThrow(/START-consumed/);

    const expired = new ExternalStartAuthorizationController(
      'attempt-1',
      1_000,
      authorize,
      publish,
      vi.fn(),
      () => 1_000,
    );
    expect(() => expired.handle(readyFrame)).toThrow(/expired/);
  });

  test('does not acknowledge a mismatched or expired consumption frame', () => {
    const acknowledge = vi.fn();
    let now = 1_000;
    const controller = new ExternalStartAuthorizationController(
      'attempt-1',
      10_000,
      (publishStart) => {
        publishStart();
        return true;
      },
      vi.fn(),
      acknowledge,
      () => now,
    );
    expect(controller.handle(readyFrame)).toBe('start');
    expect(() =>
      controller.handle({
        ...consumedFrame,
        runnerControl: {
          ...consumedFrame.runnerControl,
          authorizationId: 'attempt-2',
        },
      }),
    ).toThrow(/invalid START-consumed/);
    expect(acknowledge).not.toHaveBeenCalled();

    const expired = new ExternalStartAuthorizationController(
      'attempt-1',
      10_000,
      (publishStart) => {
        publishStart();
        return true;
      },
      vi.fn(),
      acknowledge,
      () => now,
    );
    expect(expired.handle(readyFrame)).toBe('start');
    now = 10_000;
    expect(() => expired.handle(consumedFrame)).toThrow(/expired/);
    expect(acknowledge).not.toHaveBeenCalled();
  });
});
