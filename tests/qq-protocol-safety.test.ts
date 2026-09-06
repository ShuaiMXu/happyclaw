import { describe, expect, test } from 'vitest';
import {
  isDefinitiveQQPassiveReplyRejection,
  QQApiError,
  shouldRetireQQPassiveReplyReference,
  validateQQGatewayUrl,
} from '../src/qq.js';

describe('QQ protocol safety', () => {
  test('accepts official secure gateway hosts', () => {
    expect(validateQQGatewayUrl('wss://api.sgroup.qq.com/websocket')).toBe(
      'wss://api.sgroup.qq.com/websocket',
    );
  });

  test.each([
    'ws://api.sgroup.qq.com/websocket',
    'wss://evil.example/websocket',
    'wss://qq.com.evil.example/websocket',
    'wss://user:pass@api.sgroup.qq.com/websocket',
  ])('rejects an untrusted gateway URL: %s', (url) => {
    expect(() => validateQQGatewayUrl(url)).toThrow(/untrusted/);
  });
});

describe('QQ passive fallback evidence', () => {
  test('unclassified HTTP 400 business codes never authorize active replay', () => {
    expect(
      isDefinitiveQQPassiveReplyRejection(
        new QQApiError('bad passive reference', 40034025, 400),
      ),
    ).toBe(false);
    expect(
      new QQApiError('duplicate or already exists', 40054005, 400)
        .deliveryPhase,
    ).toBe('uncertain');
    expect(
      shouldRetireQQPassiveReplyReference(
        new QQApiError('duplicate or already exists', 40054005, 400),
      ),
    ).toBe(false);
    expect(
      isDefinitiveQQPassiveReplyRejection(
        new QQApiError('server error', undefined, 500),
      ),
    ).toBe(false);
    expect(
      isDefinitiveQQPassiveReplyRejection(
        new Error('socket timed out after write'),
      ),
    ).toBe(false);
  });
});
