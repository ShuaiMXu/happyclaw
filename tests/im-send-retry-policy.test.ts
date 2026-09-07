import { describe, expect, test } from 'vitest';

import {
  classifyImSendFailure,
  ImDeliveryPhaseError,
  physicalDeliveryProgressError,
  imSendFailurePolicy,
  isUncertainAfterAcceptImError,
} from '../src/im-send-retry-policy.js';
import { DefinitiveChannelDeliveryError } from '../src/channel-outbox-delivery.js';
import { WeChatContextTokenError } from '../src/wechat-context-token.js';

describe('imSendFailurePolicy', () => {
  test.each(['missing', 'expired', 'quota_exhausted'] as const)(
    'does not retry or remove a healthy WeChat chat for %s context',
    (reason) => {
      expect(
        imSendFailurePolicy(new WeChatContextTokenError(reason, 'peer')),
      ).toEqual({
        retryable: false,
        countsTowardChannelRemoval: false,
        outcome: 'rejected',
      });
    },
  );

  test('recognizes a refresh requirement wrapped as an error cause', () => {
    const cause = new WeChatContextTokenError('missing', 'peer');
    expect(imSendFailurePolicy(new Error('adapter failed', { cause }))).toEqual(
      {
        retryable: false,
        countsTowardChannelRemoval: false,
        outcome: 'rejected',
      },
    );
  });

  test('retries only a transport failure proven to be pre-acceptance', () => {
    expect(
      imSendFailurePolicy(
        Object.assign(new Error('connect refused'), {
          code: 'ECONNREFUSED',
        }),
      ),
    ).toEqual({
      retryable: true,
      countsTowardChannelRemoval: true,
      outcome: 'pre_accept',
    });
    expect(classifyImSendFailure(new Error('connection reset'))).toBe(
      'uncertain',
    );
  });

  test('does not automatically replay an accepted-but-unacknowledged delivery', () => {
    const cause = Object.assign(new Error('response lost'), {
      code: 'CHANNEL_DELIVERY_UNCERTAIN',
    });
    expect(imSendFailurePolicy(new Error('adapter failed', { cause }))).toEqual(
      {
        retryable: false,
        countsTowardChannelRemoval: false,
        outcome: 'uncertain',
      },
    );
  });

  test('does not retry or remove a channel after a partial physical delivery', () => {
    const error = Object.assign(new Error('1/2 outputs delivered'), {
      code: 'CHANNEL_DELIVERY_PARTIAL',
    });
    expect(imSendFailurePolicy(error)).toEqual({
      retryable: false,
      countsTowardChannelRemoval: false,
      outcome: 'uncertain',
    });
  });

  test('does not retry or remove a healthy channel after an explicit provider rejection', () => {
    expect(
      imSendFailurePolicy(
        new DefinitiveChannelDeliveryError(
          'Feishu rejected the request (http=400, code=230028)',
        ),
      ),
    ).toEqual({
      retryable: false,
      countsTowardChannelRemoval: false,
      outcome: 'rejected',
    });
  });

  test('treats ETIMEDOUT in the error chain as uncertain after accept', () => {
    const timeout = Object.assign(new Error('socket hang up'), {
      code: 'ETIMEDOUT',
    });
    expect(isUncertainAfterAcceptImError(timeout)).toBe(true);
    expect(
      isUncertainAfterAcceptImError(
        new Error('adapter failed', { cause: timeout }),
      ),
    ).toBe(true);
    expect(isUncertainAfterAcceptImError(new Error('connection reset'))).toBe(
      true,
    );
  });

  test('an ETIMEDOUT retries only with explicit pre-accept phase evidence', () => {
    const timeout = Object.assign(new Error('connect timed out'), {
      code: 'ETIMEDOUT',
    });
    expect(classifyImSendFailure(timeout)).toBe('uncertain');
    expect(
      classifyImSendFailure(
        Object.assign(timeout, { deliveryPhase: 'pre_accept' }),
      ),
    ).toBe('pre_accept');
  });

  test('typed local validation evidence is pre-accept even without errno text', () => {
    const error = new ImDeliveryPhaseError(
      'pre_accept',
      'persisted path rejected locally',
    );
    expect(classifyImSendFailure(error)).toBe('pre_accept');
    expect(imSendFailurePolicy(error)).toMatchObject({ retryable: true });
  });

  test('acknowledged multi-part progress makes a retryable tail failure uncertain', () => {
    const tail = Object.assign(new Error('connect refused on chunk 2'), {
      code: 'ECONNREFUSED',
    });
    const partial = physicalDeliveryProgressError(tail, 1);
    expect(partial.acknowledgedParts).toBe(1);
    expect(classifyImSendFailure(partial)).toBe('uncertain');
    expect(imSendFailurePolicy(partial)).toMatchObject({ retryable: false });
  });

  test('acknowledged progress dominates a definitive tail rejection', () => {
    const tail = new DefinitiveChannelDeliveryError(
      'provider rejected the second chunk',
    );
    const partial = physicalDeliveryProgressError(tail, 1);

    expect(classifyImSendFailure(partial)).toBe('uncertain');
    expect(imSendFailurePolicy(partial)).toEqual({
      retryable: false,
      countsTowardChannelRemoval: false,
      outcome: 'uncertain',
    });
  });
});
