import { describe, expect, test } from 'vitest';
import {
  ResponsesToAnthropicConverter,
  aggregateResponsesStream,
  describeUpstreamFailure,
  describeUpstreamHttpFailure,
  sanitizeUpstreamText,
  upstreamFailureStatus,
} from '../src/codex-gateway/convert-response.js';

const created = {
  type: 'response.created',
  response: { id: 'r1', model: 'gpt-6-sol' },
};

describe('Codex upstream failure semantics', () => {
  test('premature EOF emits error rather than a successful stop', () => {
    const converter = new ResponsesToAnthropicConverter('gpt-6-sol');
    converter.handleEvent(created);
    const events = converter.finish();
    expect(events.map(({ event }) => event)).toEqual(['error']);
    expect(events[0].data).toMatchObject({ type: 'error' });
  });

  test.each([
    [created],
    [
      created,
      { type: 'response.failed', response: { error: { message: 'quota' } } },
    ],
    [created, { type: 'error', message: 'backend error' }],
  ])(
    'aggregation rejects missing success terminal or upstream failure',
    (...events) => {
      expect(() => aggregateResponsesStream(events, 'gpt-6-sol')).toThrow();
    },
  );

  // 实测上游形态：裸 error 事件把详情挂在 error.{type,code,message} 下。
  const flaggedPrompt = {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      code: 'invalid_prompt',
      message: 'Invalid prompt: your prompt was flagged.',
    },
  };

  test('bare error event keeps upstream reason and non-retryable type', () => {
    const converter = new ResponsesToAnthropicConverter('gpt-6-sol');
    converter.handleEvent(created);
    const [event] = converter.handleEvent(flaggedPrompt);
    expect(event.data).toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error' },
    });
    const message = String((event.data.error as { message: string }).message);
    expect(message).toContain('invalid_prompt');
    expect(message).toContain('Invalid prompt: your prompt was flagged.');
    expect(converter.getFailure()).toMatchObject({
      type: 'invalid_request_error',
      code: 'invalid_prompt',
    });
  });

  test('aggregation surfaces typed upstream failure', () => {
    expect(() =>
      aggregateResponsesStream([created, flaggedPrompt], 'gpt-6-sol'),
    ).toThrow(
      expect.objectContaining({
        name: 'CodexUpstreamError',
        errorType: 'invalid_request_error',
        status: 400,
      }),
    );
  });

  test.each([
    [
      {
        type: 'error',
        error: { code: 'rate_limit_exceeded', message: 'slow' },
      },
      'rate_limit_error',
      429,
    ],
    [
      { type: 'error', error: { type: 'server_error', message: 'boom' } },
      'api_error',
      502,
    ],
    [
      {
        type: 'response.failed',
        response: { error: { code: 'usage_limit_reached', message: 'quota' } },
      },
      'rate_limit_error',
      429,
    ],
  ])(
    'maps upstream failure %# to Anthropic error type',
    (failure, type, status) => {
      expect(() =>
        aggregateResponsesStream([created, failure], 'gpt-6-sol'),
      ).toThrow(expect.objectContaining({ errorType: type, status }));
    },
  );

  test('premature EOF is a retryable api_error', () => {
    expect(() => aggregateResponsesStream([created], 'gpt-6-sol')).toThrow(
      expect.objectContaining({ errorType: 'api_error', status: 502 }),
    );
  });

  test('completed response still succeeds', () => {
    expect(
      aggregateResponsesStream(
        [created, { type: 'response.completed', response: {} }],
        'gpt-6-sol',
      ).stopReason,
    ).toBe('end_turn');
  });

  describe('upstream classification', () => {
    const now = Date.UTC(2026, 9, 11, 12, 0, 0);

    test('usage limits are detected by error.type and carry the reset time', () => {
      const failure = describeUpstreamFailure(
        {
          type: 'response.failed',
          response: {
            error: {
              type: 'usage_limit_reached',
              message: 'The usage limit has been reached',
              resets_at: now / 1000 + 3 * 3600 + 120,
            },
          },
        },
        { now },
      );
      expect(failure).toMatchObject({
        type: 'rate_limit_error',
        status: 429,
        retryAfterSeconds: 3 * 3600 + 120,
        noRetry: true,
      });
      expect(failure.message).toContain('2026-10-11T15:02:00.000Z');
      expect(failure.message).toContain('3 小时 2 分钟');
    });

    test('resets_in_seconds is honoured when resets_at is absent or past', () => {
      expect(
        describeUpstreamFailure(
          {
            error: {
              code: 'usage_limit_reached',
              resets_at: now / 1000 - 10,
              resets_in_seconds: '90',
            },
          },
          { now },
        ),
      ).toMatchObject({ status: 429, retryAfterSeconds: 90 });
    });

    test.each([
      [{ code: 'server_is_overloaded' }, 'overloaded_error', 529],
      [{ code: 'slow_down' }, 'overloaded_error', 529],
      [{ type: 'service_unavailable_error' }, 'overloaded_error', 529],
      [{ code: 'usage_not_included' }, 'permission_error', 403],
      [{ type: 'usage_not_included' }, 'permission_error', 403],
      [{ code: 'context_length_exceeded' }, 'invalid_request_error', 400],
      [
        {
          type: 'invalid_request_error',
          message: 'maximum context length is 272000 tokens',
        },
        'invalid_request_error',
        400,
      ],
      [{ code: 'rate_limit_exceeded' }, 'rate_limit_error', 429],
    ])('maps %j to %s %i', (error, type, status) => {
      const failure = describeUpstreamFailure({ type: 'error', error });
      expect(failure.type).toBe(type);
      expect(upstreamFailureStatus(failure)).toBe(status);
    });

    test('context-length failures start with the wording Claude Code compacts on', () => {
      const { message } = describeUpstreamFailure({
        type: 'error',
        error: { code: 'context_length_exceeded', message: 'too big' },
      });
      expect(message.startsWith('Prompt is too long')).toBe(true);
    });

    test.each([
      [
        401,
        '{"detail":"Unauthorized"}',
        'authentication_error',
        'Unauthorized',
      ],
      [500, 'Internal failure', 'api_error', 'Internal failure'],
      [502, '<html>edge</html>', 'api_error', 'returned 502'],
      [
        403,
        '{"detail":{"code":"usage_not_included"}}',
        'permission_error',
        'usage_not_included',
      ],
    ])('HTTP %i body %s → %s', (status, body, type, fragment) => {
      const failure = describeUpstreamHttpFailure(status, body);
      expect(failure.type).toBe(type);
      expect(failure.message).toContain(fragment);
    });

    test('sanitizes secrets and bounds the length', () => {
      const text = sanitizeUpstreamText(
        `Bearer abc.def-ghi sk-proj-0123456789abcdef eyJhbGciOi.eyJzdWIiOi.sig ${'A'.repeat(64)}\n${'y '.repeat(600)}`,
      );
      expect(text).not.toMatch(/abc\.def|0123456789abcdef|eyJ|AAAA/);
      expect(text).not.toContain('\n');
      expect(text.length).toBeLessThanOrEqual(501);
    });
  });
});
