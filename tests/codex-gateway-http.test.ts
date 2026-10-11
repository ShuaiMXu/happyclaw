import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getProviderById: vi.fn(),
  persistCredentials: vi.fn(),
  persistRefreshError: vi.fn(),
  fetch: vi.fn(),
  limiters: [] as Array<{ size: number }>,
  logger: { warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../src/runtime-config.js', () => ({
  getProviders: mocks.getProviders,
  getProviderById: mocks.getProviderById,
  updateProviderCodexOAuthCredentialsIfCurrent: mocks.persistCredentials,
  setProviderCodexOAuthRefreshErrorIfCurrent: mocks.persistRefreshError,
}));
vi.mock('../src/logger.js', () => ({ logger: mocks.logger }));
vi.mock('../src/codex-gateway/model-catalog-sync.js', () => ({
  getResolvedCodexCatalog: () => ({ models: [] }),
}));
vi.mock(
  '../src/codex-gateway/provider-rate-limit.js',
  async (importOriginal) => {
    const real =
      await importOriginal<
        typeof import('../src/codex-gateway/provider-rate-limit.js')
      >();
    return {
      CodexProviderRateLimiter: class extends real.CodexProviderRateLimiter {
        constructor() {
          super();
          mocks.limiters.push(this);
        }
      },
    };
  },
);
const { codexGatewayApp } = await import('../src/codex-gateway/gateway.js');
const { issueCodexGatewayToken, revokeCodexGatewayToken } =
  await import('../src/codex-gateway/runner-tokens.js');
const { resetCodexTokenManagerForTests } =
  await import('../src/codex-gateway/token-manager.js');
let fixtureNumber = 0;
let runnerToken: string;
let runnerGrant: ReturnType<typeof issueCodexGatewayToken>['grant'];
const LOCAL_RUNNER = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
let provider: Record<string, unknown>;
const encoder = new TextEncoder();
const created = {
  type: 'response.created',
  response: { id: 'resp-http', model: 'gpt-6-sol' },
};
const completed = {
  type: 'response.completed',
  response: {
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 80 },
      output_tokens: 10,
    },
  },
};
function frame(event: Record<string, unknown>): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}
function upstreamEvents(events = [created, completed]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        events.forEach((event) => c.enqueue(frame(event)));
        c.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
function request(
  payload: unknown = {
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
  },
  key = runnerToken,
  init: RequestInit = {},
  env: unknown = LOCAL_RUNNER,
  path = '/v1/messages',
): Promise<Response> {
  return codexGatewayApp.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify(payload),
      ...init,
    },
    env as never,
  );
}
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
/** Upstream bodies are zstd-compressed like the official client's. */
function upstreamJson(init: {
  headers: Record<string, string>;
  body: string | Uint8Array;
}): Record<string, any> {
  const bytes =
    init.headers['Content-Encoding'] === 'zstd'
      ? zlib.zstdDecompressSync(init.body as Uint8Array)
      : Buffer.from(init.body);
  return JSON.parse(bytes.toString('utf8'));
}
function sentBody(call = 0): Record<string, any> {
  return upstreamJson(mocks.fetch.mock.calls[call][1]);
}
beforeEach(() => {
  vi.clearAllMocks();
  resetCodexTokenManagerForTests();
  provider = {
    id: `provider-${++fixtureNumber}`,
    enabled: true,
    anthropicAuthToken: 'stored-identifier',
    anthropicModel: 'gpt-6-sol',
    customEnv: {},
    codexOAuthCredentials: {
      accessToken: 'fake-upstream',
      refreshToken: 'fake-refresh',
      expiresAt: Date.now() + 3_600_000,
      accountId: 'business-workspace',
    },
    codexOAuthLastRefreshError: null,
  };
  mocks.getProviders.mockImplementation(() => [structuredClone(provider)]);
  mocks.getProviderById.mockImplementation(() => structuredClone(provider));
  mocks.persistCredentials.mockImplementation((_id, _expected, refreshed) => {
    provider.codexOAuthCredentials = refreshed;
    provider.codexOAuthLastRefreshError = null;
    return true;
  });
  mocks.persistRefreshError.mockImplementation((_id, _expected, state) => {
    provider.codexOAuthLastRefreshError = state;
    return true;
  });
  mocks.fetch.mockImplementation(async () => upstreamEvents());
  vi.stubGlobal('fetch', mocks.fetch);
  ({ token: runnerToken, grant: runnerGrant } = issueCodexGatewayToken(
    provider.id as string,
    { kind: 'container', groupFolder: 'workspace' },
  ));
});
afterEach(() => {
  revokeCodexGatewayToken(runnerToken);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Codex gateway HTTP boundary', () => {
  test('random unauthenticated keys allocate no rate counters and never call upstream', async () => {
    const before = mocks.limiters[0].size;
    for (let i = 0; i < 1200; i++)
      expect((await request(undefined, `invalid-${i}`)).status).toBe(401);
    expect(mocks.limiters[0].size).toBe(before);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect((await request()).status).toBe(200);
  });

  test('the stored provider identifier is not a gateway credential', async () => {
    const response = await request(undefined, 'stored-identifier');
    expect(response.status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  test('a revoked runner token stops working immediately', async () => {
    expect((await request()).status).toBe(200);
    revokeCodexGatewayToken(runnerToken);
    expect((await request()).status).toBe(401);
  });

  test.each([
    [
      'public source',
      { incoming: { socket: { remoteAddress: '203.0.113.9' } } },
      {},
    ],
    ['missing socket', {}, {}],
    ['X-Forwarded-For', LOCAL_RUNNER, { 'x-forwarded-for': '203.0.113.9' }],
    ['Forwarded', LOCAL_RUNNER, { forwarded: 'for=203.0.113.9' }],
    ['X-Real-IP', LOCAL_RUNNER, { 'x-real-ip': '203.0.113.9' }],
  ])(
    'rejects %s even with a live token, before reading the body',
    async (_label, env, extraHeaders) => {
      const response = await request(
        undefined,
        runnerToken,
        {
          headers: {
            'content-type': 'application/json',
            'x-api-key': runnerToken,
            ...extraHeaders,
          },
        },
        env,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { type: 'permission_error' },
      });
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  test.each(['10.1.2.3', '172.17.0.2', '192.168.65.1', '::1', 'fd00::2'])(
    'accepts runner traffic from local address %s',
    async (remoteAddress) => {
      const response = await request(
        undefined,
        runnerToken,
        {},
        {
          incoming: { socket: { remoteAddress } },
        },
      );
      expect(response.status).toBe(200);
    },
  );

  test('rate budget is per runner grant and answers with retry-after', async () => {
    for (let i = 0; i < 120; i++) {
      // Malformed requests consume budget without spending upstream subscription.
      expect((await request(null)).status).toBe(400);
    }
    const limited = await request();
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(limited.headers.get('x-should-retry')).toBeNull();
    expect(runnerGrant.lastVerdict).toBe('local_transient');
    expect(mocks.fetch).not.toHaveBeenCalled();
    // Another runner on the same provider keeps its own budget.
    const other = issueCodexGatewayToken(provider.id as string, {
      kind: 'host',
    });
    try {
      expect((await request(undefined, other.token)).status).toBe(200);
    } finally {
      revokeCodexGatewayToken(other.token);
    }
  });

  test.each([
    null,
    [],
    {},
    { messages: null },
    { messages: 'bad' },
    { messages: [{ role: 'unknown', content: 'bad' }] },
    {
      messages: [
        {
          role: 'system',
          content: [{ type: 'tool_use', id: 'call', name: 'Bash', input: {} }],
        },
      ],
    },
    { messages: [{ role: 'user', content: [null] }] },
    { messages: [{ role: 'user', content: 'hi' }], tools: 'bad' },
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', content: 'missing call id' }],
        },
      ],
    },
    {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png' },
            },
          ],
        },
      ],
    },
  ])(
    'malformed consumed input returns 400 before upstream (%#)',
    async (payload) => {
      const response = await request(payload);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { type: 'invalid_request_error' },
      });
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  test('validation errors name the offending field path, never its value', async () => {
    const response = await request({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'ok' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'SECRET-VALUE' },
            },
          ],
        },
      ],
    });
    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error.message).toContain('messages.0.content.1.source.data');
    expect(error.message).not.toContain('SECRET-VALUE');
  });

  test('unsupported historical blocks degrade instead of failing every later turn', async () => {
    const response = await request({
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'url', url: 'https://example.invalid/image.png' },
            },
            {
              type: 'search_result',
              title: 'Doc',
              content: [{ type: 'text', text: 'found' }],
            },
          ],
        },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'next turn' },
      ],
    });
    expect(response.status).toBe(200);
    const content = sentBody().input[0].content;
    expect(content[0].text).toContain('Image omitted');
    expect(content[1].text).toContain('found');
  });

  test('authenticated oversized request bodies receive 413 before JSON buffering', async () => {
    const response = await request(undefined, runnerToken, {
      headers: {
        'x-api-key': runnerToken,
        'content-type': 'application/json',
        'content-length': String(40 * 1024 * 1024),
      },
    });
    expect(response.status).toBe(413);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  test('sends the account header and cache-exclusive nonstream usage', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      usage: {
        input_tokens: 20,
        cache_read_input_tokens: 80,
        output_tokens: 10,
      },
    });
    expect(mocks.fetch.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer fake-upstream',
      'ChatGPT-Account-ID': 'business-workspace',
    });
  });

  test('preserves SDK system reminders at their conversation position', async () => {
    const response = await request({
      model: 'claude-sonnet-4-6',
      system: [
        {
          type: 'text',
          text: 'You are an assistant with Bash.',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Read README.' }] },
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: '<system-reminder>Use Bash.</system-reminder>',
            },
          ],
        },
      ],
      tools: [
        { name: 'Bash', input_schema: { type: 'object', properties: {} } },
      ],
      stream: true,
      max_tokens: 32_000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      context_management: { edits: [] },
      metadata: { user_id: 'sdk-test' },
    });
    expect(response.status).toBe(200);
    await response.text();
    const body = sentBody();
    expect(body.instructions).toBe('');
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'developer',
        content: [
          { type: 'input_text', text: 'You are an assistant with Bash.' },
        ],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Read README.' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '<system-reminder>\n<system-reminder>Use Bash.</system-reminder>\n</system-reminder>',
          },
        ],
      },
    ]);
    expect(body.tools[0].name).toBe('Bash');
    expect(body.thinking).toBeUndefined();
    expect(body.metadata).toBeUndefined();
  });

  test('SSE publishes cache-exclusive usage and a single successful terminal', async () => {
    const response = await request({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const text = await response.text();
    expect(text).toContain('"input_tokens":20');
    expect(text).toContain('"cache_read_input_tokens":80');
    expect(text.match(/event: message_stop/g)).toHaveLength(1);
    expect(text).not.toContain('event: error');
  });

  test('tool screenshot reaches upstream with its call identity', async () => {
    const response = await request({
      stream: false,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'screen', name: 'screenshot', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'screen',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'c2NyZWVu',
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(response.status).toBe(200);
    const translated = sentBody();
    expect(translated.input[1]).toMatchObject({
      type: 'function_call_output',
      call_id: 'screen',
    });
    expect(translated.input[1].output).toContainEqual({
      type: 'input_image',
      image_url: 'data:image/png;base64,c2NyZWVu',
    });
  });

  test('downstream cancellation cancels a pending upstream without enqueue/close errors', async () => {
    const cancel = vi.fn();
    let signal!: AbortSignal;
    mocks.fetch.mockImplementation(async (_url, init) => {
      signal = init.signal;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(frame(created));
            c.enqueue(
              frame({ type: 'response.output_text.delta', delta: 'partial' }),
            );
          },
          cancel,
        }),
      );
    });
    const response = await request({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalled();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  test('client request abort also terminates a pending nonstream upstream reader', async () => {
    const cancel = vi.fn();
    let opened!: () => void;
    const bodyOpened = new Promise<void>((resolve) => {
      opened = resolve;
    });
    mocks.fetch.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(frame(created));
              opened();
            },
            cancel,
          }),
        ),
    );
    const client = new AbortController();
    const pending = request(undefined, runnerToken, {
      signal: client.signal,
    });
    await bodyOpened;
    // Let the response attach its upstream reader's abort handler.
    await Promise.resolve();
    client.abort();
    expect((await pending).status).toBe(504);
    expect(cancel).toHaveBeenCalled();
  });

  test('a slow consumer does not drain an entire upstream into an unbounded queue', async () => {
    let pulls = 0;
    const cancel = vi.fn();
    mocks.fetch.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            pull(c) {
              pulls++;
              c.enqueue(
                frame(
                  pulls === 1
                    ? created
                    : { type: 'response.output_text.delta', delta: 'more' },
                ),
              );
            },
            cancel,
          }),
        ),
    );
    const response = await request({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(pulls).toBeLessThanOrEqual(3);
    await response.body!.cancel();
    expect(cancel).toHaveBeenCalled();
  });

  test('a success terminal without a trailing SSE separator is preserved', async () => {
    mocks.fetch.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(frame(created));
              c.enqueue(encoder.encode(`data: ${JSON.stringify(completed)}`));
              c.close();
            },
          }),
        ),
    );
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      usage: {
        input_tokens: 20,
        output_tokens: 10,
        cache_read_input_tokens: 80,
      },
    });
  });

  test('stalled SSE cancels upstream and emits an error without a success terminal', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    mocks.fetch.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(frame(created));
            },
            cancel,
          }),
        ),
    );
    const pendingResponse = request({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    // The handshake is held back until content or the bootstrap time budget.
    await vi.advanceTimersByTimeAsync(20_000);
    const response = await pendingResponse;
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read(); // message_start
    await reader.read(); // ping
    const pending = reader.read();
    // A quiet reasoning phase is not a stall before the 300s idle deadline.
    await vi.advanceTimersByTimeAsync(200_000);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100_000);
    const chunk = await pending;
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain('event: error');
    expect(text).not.toContain('event: message_stop');
    expect((await reader.read()).done).toBe(true);
    expect(cancel).toHaveBeenCalled();
  });

  test('an upstream error body is read only up to its bound, redacted, and never logged', async () => {
    const cancel = vi.fn();
    mocks.fetch.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(
                encoder.encode(
                  JSON.stringify({
                    error: {
                      message: `SECRET echo Bearer sk-abcdefghijklmnop ${'x'.repeat(2000)}`,
                    },
                  }),
                ),
              );
              // An oversized tail is never buffered.
              c.enqueue(new Uint8Array(128 * 1024));
            },
            cancel,
          }),
          { status: 500 },
        ),
    );
    const response = await request();
    expect(response.status).toBe(500);
    const { error } = await response.json();
    expect(error.type).toBe('api_error');
    expect(error.message).toContain('SECRET echo');
    expect(error.message).not.toContain('sk-abcdefghijklmnop');
    expect(error.message.length).toBeLessThan(700);
    expect(cancel).toHaveBeenCalled();
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(
      'SECRET',
    );
  });

  test('a stalled upstream error body is abandoned after its read deadline', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    mocks.fetch.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(
                encoder.encode('{"error":{"code":"rate_limit_exceeded"'),
              );
            },
            cancel,
          }),
          { status: 429 },
        ),
    );
    const pending = request();
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await pending;
    expect(response.status).toBe(429);
    expect((await response.json()).error.type).toBe('rate_limit_error');
    expect(cancel).toHaveBeenCalled();
  });
});

describe('upstream 401 handling', () => {
  const refreshed = () =>
    jsonResponse(200, {
      access_token: 'rotated-upstream',
      refresh_token: 'rotated-refresh',
      expires_in: 3600,
    });

  test('refreshes once and retries the request with the new access token', async () => {
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse(401, { detail: 'token revoked' }))
      .mockResolvedValueOnce(refreshed())
      .mockImplementationOnce(async () => upstreamEvents());
    const response = await request();
    expect(response.status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(String(mocks.fetch.mock.calls[1][0])).toContain('oauth/token');
    expect(mocks.fetch.mock.calls[2][1].headers.Authorization).toBe(
      'Bearer rotated-upstream',
    );
    expect(provider.codexOAuthCredentials).toMatchObject({
      accessToken: 'rotated-upstream',
    });
  });

  test('a rejected refresh grant answers authentication_error naming the re-login and persists the state', async () => {
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse(401, { detail: 'token revoked' }))
      .mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_grant' }));
    const response = await request();
    expect(response.status).toBe(401);
    expect(response.headers.get('x-should-retry')).toBe('false');
    const { error } = await response.json();
    expect(error.type).toBe('authentication_error');
    expect(error.message).toContain('重新登录 ChatGPT');
    expect(error.message).toContain('invalid_grant');
    expect(provider.codexOAuthLastRefreshError).toMatchObject({
      kind: 'reauth_required',
      accessTokenRejected: true,
    });
    expect(runnerGrant.lastVerdict).toBe('reauth_required');
    // Later requests stop at the gateway: no upstream call, no refresh.
    mocks.fetch.mockClear();
    expect((await request()).status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  test('a transient refresh failure answers a retryable 503 with retry-after', async () => {
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse(401, { detail: 'token revoked' }))
      .mockResolvedValueOnce(jsonResponse(503, { error: 'unavailable' }));
    const response = await request();
    expect(response.status).toBe(503);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await response.json()).error.type).toBe('api_error');
    expect(provider.codexOAuthLastRefreshError?.kind).toBe('transient');
    expect(runnerGrant.lastVerdict).toBe('local_transient');
  });

  test('a second 401 after a successful refresh is surfaced, not retried again', async () => {
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse(401, {}))
      .mockResolvedValueOnce(refreshed())
      .mockResolvedValueOnce(jsonResponse(401, {}));
    const response = await request();
    expect(response.status).toBe(401);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect((await response.json()).error.message).toContain('重新登录');
  });
});

describe('upstream error mapping', () => {
  test('usage limits become 429 with retry-after, a reset time and no client retry', async () => {
    mocks.fetch.mockResolvedValueOnce(
      jsonResponse(429, {
        error: {
          type: 'usage_limit_reached',
          message: 'The usage limit has been reached',
          resets_in_seconds: 7200,
        },
      }),
    );
    const response = await request();
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('7200');
    expect(response.headers.get('x-should-retry')).toBe('false');
    const { error } = await response.json();
    expect(error.type).toBe('rate_limit_error');
    expect(error.message).toMatch(/重置.*2 小时/);
  });

  test.each([
    [
      { error: { code: 'server_is_overloaded', message: 'busy' } },
      503,
      529,
      'overloaded_error',
    ],
    [
      { error: { code: 'slow_down', message: 'slow' } },
      429,
      529,
      'overloaded_error',
    ],
    [{ detail: { code: 'usage_not_included' } }, 403, 403, 'permission_error'],
    [
      {
        error: {
          code: 'context_length_exceeded',
          message: 'Your input exceeds the context window of this model.',
        },
      },
      400,
      400,
      'invalid_request_error',
    ],
  ])(
    'maps upstream %j (HTTP %i) to %i %s',
    async (body, upstreamStatus, status, type) => {
      mocks.fetch.mockResolvedValueOnce(jsonResponse(upstreamStatus, body));
      const response = await request();
      expect(response.status).toBe(status);
      expect((await response.json()).error.type).toBe(type);
    },
  );

  test('context-length rejections use the wording Claude Code compacts on', async () => {
    mocks.fetch.mockResolvedValueOnce(
      jsonResponse(400, {
        error: {
          message: 'Your input exceeds the context window of this model.',
        },
      }),
    );
    const { error } = await (await request()).json();
    expect(error.message.toLowerCase()).toContain('prompt is too long');
  });

  test('a failure before any content becomes a real HTTP status on a stream', async () => {
    mocks.fetch.mockImplementationOnce(async () =>
      upstreamEvents([
        created,
        { type: 'response.in_progress', response: {} },
        {
          type: 'response.failed',
          response: {
            error: {
              type: 'usage_limit_reached',
              message: 'limit',
              resets_at: Math.floor(Date.now() / 1000) + 600,
            },
          },
        },
      ]),
    );
    const response = await request({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(500);
    expect((await response.json()).error.type).toBe('rate_limit_error');
  });

  test('an overload reported inside a 200 stream before content is a 529', async () => {
    mocks.fetch.mockImplementationOnce(async () =>
      upstreamEvents([
        created,
        {
          type: 'error',
          error: {
            type: 'service_unavailable_error',
            code: 'server_is_overloaded',
            message: 'Our servers are currently overloaded.',
          },
        },
      ]),
    );
    const response = await request({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(response.status).toBe(529);
    expect((await response.json()).error.type).toBe('overloaded_error');
  });

  test('a failure after content has streamed stays an in-stream error event', async () => {
    mocks.fetch.mockImplementationOnce(async () =>
      upstreamEvents([
        created,
        { type: 'response.output_text.delta', delta: 'partial' },
        {
          type: 'error',
          error: { code: 'server_is_overloaded', message: 'x' },
        },
      ]),
    );
    const response = await request({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('partial');
    expect(text).toContain('event: error');
  });
});

describe('count_tokens', () => {
  test('estimates input tokens locally without an upstream call', async () => {
    const response = await request(
      {
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hello world, 你好世界' }],
        tools: [
          {
            name: 'Bash',
            description: 'Run a command',
            input_schema: {
              type: 'object',
              properties: { cmd: { type: 'string' } },
            },
          },
        ],
      },
      runnerToken,
      {},
      LOCAL_RUNNER,
      '/v1/messages/count_tokens',
    );
    expect(response.status).toBe(200);
    const { input_tokens } = await response.json();
    expect(input_tokens).toBeGreaterThan(10);
    expect(input_tokens).toBeLessThan(200);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  test('requires a live runner token', async () => {
    const response = await request(
      { messages: [{ role: 'user', content: 'hi' }] },
      'stored-identifier',
      {},
      LOCAL_RUNNER,
      '/v1/messages/count_tokens',
    );
    expect(response.status).toBe(401);
  });
});

describe('reasoning effort policy', () => {
  const adaptive = (extra: Record<string, unknown> = {}) => ({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'Bash', input_schema: { type: 'object', properties: {} } }],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'max' },
    stream: false,
    ...extra,
  });

  test('an inheriting Agent uses the provider effort, not the SDK default', async () => {
    provider.customEnv = { CODEX_REASONING_EFFORT: 'high' };
    await request(adaptive());
    expect(sentBody().reasoning.effort).toBe('high');
  });

  test('without a provider effort the model catalog default applies', async () => {
    await request(adaptive());
    expect(sentBody().reasoning.effort).toBe('medium');
  });

  test('an explicit Agent effort beats the provider effort', async () => {
    provider.customEnv = { CODEX_REASONING_EFFORT: 'low' };
    const agent = issueCodexGatewayToken(provider.id as string, {
      kind: 'container',
      agentEffort: 'xhigh',
    });
    try {
      await request(adaptive({ output_config: undefined }), agent.token);
      expect(sentBody().reasoning.effort).toBe('xhigh');
      await request(
        adaptive({ output_config: { effort: 'high' } }),
        agent.token,
      );
      expect(sentBody(1).reasoning.effort).toBe('high');
    } finally {
      revokeCodexGatewayToken(agent.token);
    }
  });

  test('disabled thinking and haiku-tier requests use a low effort', async () => {
    provider.customEnv = { CODEX_REASONING_EFFORT: 'xhigh' };
    await request(adaptive({ thinking: { type: 'disabled' } }));
    expect(sentBody(0).reasoning.effort).toBe('low');
    await request(adaptive({ model: 'claude-haiku-4-5' }));
    expect(sentBody(1).reasoning.effort).toBe('low');
    expect(sentBody(1).model).toBe('gpt-6-sol');
  });
});
