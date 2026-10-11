import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getProviderById: vi.fn(),
  fetch: vi.fn(),
  logger: { warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../src/runtime-config.js', () => ({
  getProviders: mocks.getProviders,
  getProviderById: mocks.getProviderById,
  updateProviderCodexOAuthCredentialsIfCurrent: vi.fn(),
  setProviderCodexOAuthRefreshErrorIfCurrent: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({ logger: mocks.logger }));
vi.mock('../src/codex-gateway/model-catalog-sync.js', () => ({
  getResolvedCodexCatalog: () => ({ models: [] }),
  getCodexCatalogForProvider: () => [],
  maybeRefreshCodexProviderCatalog: () => {},
  noteCodexModelsEtag: () => {},
}));

const { codexGatewayApp } = await import('../src/codex-gateway/gateway.js');
const { issueCodexGatewayToken, revokeCodexGatewayToken } =
  await import('../src/codex-gateway/runner-tokens.js');
const { resetCodexTokenManagerForTests } =
  await import('../src/codex-gateway/token-manager.js');
const {
  CODEX_BACKGROUND_SOURCE,
  buildCodexUpstreamRequest,
  codexTurnBoundary,
  encodeCodexUpstreamBody,
} = await import('../src/codex-gateway/request-context.js');
const {
  codexCookieHeader,
  codexTransportScope,
  forgetCodexTransportState,
  resetCodexTransportStateForTests,
  storeCodexResponseCookies,
} = await import('../src/codex-gateway/transport-state.js');
const { codexInstallationId, resetCodexInstallationIdForTests } =
  await import('../src/codex-gateway/installation-id.js');
const { buildCodexUserAgent, codexUserAgent, CODEX_CLIENT_VERSION } =
  await import('../src/codex-gateway/client-identity.js');

const { serializeCodexResponsesRequest } =
  await import('../src/codex-gateway/convert-request.js');
type ResponsesRequest =
  import('../src/codex-gateway/convert-request.js').ResponsesRequest;
const zstdAvailable = typeof zlib.zstdCompressSync === 'function';
const encoder = new TextEncoder();
const completed = {
  type: 'response.completed',
  response: { usage: { input_tokens: 10, output_tokens: 1 } },
};
let providerNumber = 0;
let provider: Record<string, any>;
let runnerToken = '';

function upstream(
  init: { status?: number; headers?: Record<string, string> | Headers } = {},
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(completed)}\n\n`),
        );
        controller.close();
      },
    }),
    {
      status: init.status ?? 200,
      headers: init.headers ?? { 'content-type': 'text/event-stream' },
    },
  );
}

function sse(headers: Record<string, string>, setCookies: string[] = []) {
  const result = new Headers({ 'content-type': 'text/event-stream' });
  for (const [name, value] of Object.entries(headers)) result.set(name, value);
  for (const cookie of setCookies) result.append('set-cookie', cookie);
  return upstream({ headers: result });
}

function request(
  payload: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  return codexGatewayApp.request(
    '/v1/messages',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': runnerToken,
        'x-claude-code-session-id': 'session-1',
        ...headers,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        ...payload,
      }),
    },
    { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never,
  );
}

interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, any>;
  metadata: Record<string, any>;
}
function sent(call: number): SentRequest {
  const [url, init] = mocks.fetch.mock.calls[call] as [
    string,
    { headers: Record<string, string>; body: Uint8Array | string },
  ];
  const bytes =
    init.headers['Content-Encoding'] === 'zstd'
      ? zlib.zstdDecompressSync(init.body as Uint8Array)
      : Buffer.from(init.body);
  return {
    url,
    headers: init.headers,
    body: JSON.parse(bytes.toString('utf8')),
    metadata: JSON.parse(init.headers['x-codex-turn-metadata']),
  };
}

const toolUse = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: {} }],
};
const toolResult = (text = 'ok') => ({
  role: 'user',
  content: [
    { type: 'tool_result', tool_use_id: 'call-1', content: text },
    { type: 'text', text: '<system-reminder>queued</system-reminder>' },
  ],
});
const tools = [
  { name: 'Bash', input_schema: { type: 'object', properties: {} } },
];

beforeEach(() => {
  vi.clearAllMocks();
  resetCodexTokenManagerForTests();
  resetCodexTransportStateForTests();
  resetCodexInstallationIdForTests(null);
  provider = {
    id: `alignment-provider-${++providerNumber}`,
    enabled: true,
    anthropicAuthToken: 'identifier',
    anthropicModel: 'gpt-6-sol',
    customEnv: {},
    codexOAuthCredentials: {
      accessToken: 'upstream-access',
      refreshToken: 'upstream-refresh',
      expiresAt: Date.now() + 3_600_000,
      accountId: 'account-1',
    },
    codexOAuthLastRefreshError: null,
  };
  mocks.getProviders.mockImplementation(() => [structuredClone(provider)]);
  mocks.getProviderById.mockImplementation(() => structuredClone(provider));
  mocks.fetch.mockImplementation(async () => upstream());
  vi.stubGlobal('fetch', mocks.fetch);
  runnerToken = issueCodexGatewayToken(provider.id, { kind: 'host' }).token;
});
afterEach(() => {
  revokeCodexGatewayToken(runnerToken);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetCodexInstallationIdForTests();
});

describe('official client identity', () => {
  test.each([
    [
      {
        platform: 'darwin',
        release: '25.5.0',
        machine: 'arm64',
        macosVersion: '26.5.2',
        env: { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.11' },
      },
      'codex-tui/0.162.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.162.1)',
    ],
    [
      {
        platform: 'darwin',
        release: '24.1.0',
        machine: 'x86_64',
        env: { TERM_PROGRAM: 'tmux', TERM: 'tmux-256color' },
      },
      'codex-tui/0.162.1 (Mac OS 15.1; x86_64) tmux-256color (codex-tui; 0.162.1)',
    ],
    [
      {
        platform: 'linux',
        release: '6.8.0-45-generic',
        machine: 'x86_64',
        env: {},
      },
      'codex-tui/0.162.1 (Linux 6.8.0; x86_64) unknown (codex-tui; 0.162.1)',
    ],
    [
      {
        platform: 'win32',
        release: '10.0.26100',
        machine: 'x86_64',
        env: { TERM_PROGRAM: 'vscode (insiders)' },
      },
      'codex-tui/0.162.1 (Windows 10.0.26100; x86_64) vscode__insiders_ (codex-tui; 0.162.1)',
    ],
  ] as const)('builds the official User-Agent format %#', (host, expected) => {
    expect(buildCodexUserAgent(host as never)).toBe(expected);
  });

  test('the host User-Agent is header-safe and pinned to the mirrored version', () => {
    expect(codexUserAgent()).toMatch(/^[\x20-\x7e]+$/);
    expect(
      codexUserAgent().startsWith(`codex-tui/${CODEX_CLIENT_VERSION} (`),
    ).toBe(true);
    expect(
      codexUserAgent().endsWith(`(codex-tui; ${CODEX_CLIENT_VERSION})`),
    ).toBe(true);
  });
});

describe('official /responses request shape', () => {
  test('sends exactly the official header set for a conversation turn', async () => {
    expect((await request()).status).toBe(200);
    const first = sent(0);
    // The converter decides Responses Lite per request (see below).
    const lite = first.body.reasoning?.context === 'all_turns';
    expect(first.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(Object.keys(first.headers).sort()).toEqual(
      [
        'Accept',
        'Authorization',
        'ChatGPT-Account-ID',
        ...(zstdAvailable ? ['Content-Encoding'] : []),
        'Content-Type',
        'User-Agent',
        'originator',
        'session-id',
        'thread-id',
        'version',
        'x-client-request-id',
        'x-codex-routing-hint',
        'x-codex-turn-metadata',
        'x-codex-window-id',
        ...(lite ? ['x-openai-internal-codex-responses-lite'] : []),
      ].sort(),
    );
    expect(first.headers).toMatchObject({
      Accept: 'text/event-stream',
      Authorization: 'Bearer upstream-access',
      'ChatGPT-Account-ID': 'account-1',
      ...(zstdAvailable ? { 'Content-Encoding': 'zstd' } : {}),
      'Content-Type': 'application/json',
      'User-Agent': codexUserAgent(),
      originator: 'codex-tui',
      version: CODEX_CLIENT_VERSION,
      'x-codex-routing-hint': 'model=gpt-6-sol',
    });
    const thread = first.headers['thread-id'];
    expect(first.headers['x-client-request-id']).toBe(thread);
    expect(first.headers['session-id']).toBe(thread);
    expect(first.headers['x-codex-window-id']).toBe(`${thread}:0`);
    expect(first.body.prompt_cache_key).toBe(thread);
    // No beta features are advertised (see CODEX_BETA_FEATURES).
    expect(first.headers).not.toHaveProperty('x-codex-beta-features');
  });

  test('client_metadata and turn metadata follow the official shape', async () => {
    resetCodexInstallationIdForTests(null);
    const installationId = codexInstallationId();
    await request();
    const { headers, body, metadata } = sent(0);
    const thread = headers['thread-id'];
    expect(Object.keys(metadata)).toEqual([
      'installation_id',
      'session_id',
      'thread_id',
      'agent_name',
      'turn_id',
      'window_id',
      'window_number',
      'request_kind',
      'root_turn_id',
      'thread_source',
      'turn_started_at_unix_ms',
      'model',
      'reasoning_effort',
    ]);
    // Official 0.162.1 capture: a root thread's root turn is its own turn.
    expect(metadata.root_turn_id).toBe(metadata.turn_id);
    expect(metadata).toMatchObject({
      installation_id: installationId,
      session_id: thread,
      thread_id: thread,
      agent_name: '/root',
      window_id: `${thread}:0`,
      window_number: 0,
      request_kind: 'turn',
      thread_source: 'user',
    });
    expect(metadata.turn_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(body.client_metadata).toEqual({
      'x-codex-installation-id': installationId,
      session_id: thread,
      thread_id: thread,
      'x-codex-window-id': `${thread}:0`,
      turn_id: metadata.turn_id,
      'x-codex-turn-metadata': headers['x-codex-turn-metadata'],
      root_turn_id: metadata.turn_id,
    });
  });

  test.each([
    [{ model: 'gpt-6-sol', reasoning: { context: 'all_turns' } }, true],
    // A lite model whose request the converter kept classic (hosted tools).
    [{ model: 'gpt-6-sol', reasoning: { effort: 'low' } }, false],
    [{ model: 'gpt-6-sol' }, false],
    [{ model: 'gpt-5.5', reasoning: { context: 'all_turns' } }, true],
  ])(
    'Responses Lite header follows the converted request %#',
    (responsesRequest, lite) => {
      const { headers } = buildCodexUpstreamRequest({
        incomingHeaders: new Headers({ 'x-claude-code-session-id': 's' }),
        anthropicRequest: { messages: [{ role: 'user', content: 'hi' }] },
        responsesRequest,
        access: {
          providerId: 'p',
          accessToken: 't',
          accountId: 'a',
        },
        fallbackScope: 'g',
      });
      expect(headers['x-openai-internal-codex-responses-lite']).toBe(
        lite ? 'true' : undefined,
      );
      expect(headers['x-codex-routing-hint']).toBe(
        `model=${responsesRequest.model}`,
      );
    },
  );

  test('a FedRAMP account adds X-OpenAI-Fedramp; others never send it', async () => {
    provider.codexOAuthCredentials.isFedramp = true;
    await request();
    expect(sent(0).headers['X-OpenAI-Fedramp']).toBe('true');
    provider.codexOAuthCredentials.isFedramp = false;
    await request();
    expect(sent(1).headers).not.toHaveProperty('X-OpenAI-Fedramp');
  });

  test('an account-less login omits ChatGPT-Account-ID', async () => {
    provider.codexOAuthCredentials.accountId = null;
    await request();
    expect(sent(0).headers).not.toHaveProperty('ChatGPT-Account-ID');
  });

  test('background requests take the official title-thread shape with their own cache key', async () => {
    await request();
    await request({ model: 'claude-haiku-4-5' });
    await request({ model: 'claude-haiku-4-5' });
    const main = sent(0);
    const background = sent(1);
    const conversation = main.headers['thread-id'];
    const thread = background.headers['thread-id'];
    expect(thread).not.toBe(conversation);
    // Stable per conversation thread.
    expect(sent(2).headers['thread-id']).toBe(thread);
    const cacheKey = `${CODEX_BACKGROUND_SOURCE}:${conversation}`;
    expect(background.body.prompt_cache_key).toBe(cacheKey);
    expect(background.headers['session-id']).toBe(cacheKey);
    expect(background.headers['x-client-request-id']).toBe(thread);
    // A root thread of its own, like the TUI's hidden title thread.
    expect(background.metadata).toMatchObject({
      session_id: thread,
      thread_id: thread,
      agent_name: '/root',
      thread_source: CODEX_BACKGROUND_SOURCE,
    });
    expect(background.body.client_metadata).toMatchObject({
      session_id: thread,
      thread_id: thread,
    });
    for (const call of [main, background]) {
      expect(call.headers).not.toHaveProperty('x-openai-subagent');
      expect(call.headers).not.toHaveProperty('x-codex-parent-thread-id');
      expect(call.metadata).not.toHaveProperty('parent_thread_id');
    }
    // Another account never shares the background thread or its key.
    provider.codexOAuthCredentials.accountId = 'account-2';
    await request({ model: 'claude-haiku-4-5' });
    expect(sent(3).headers['thread-id']).not.toBe(thread);
    expect(sent(3).body.prompt_cache_key).not.toBe(cacheKey);
  });

  test('without an SDK session id the request still sends a deterministic cache key', async () => {
    await request({}, { 'x-claude-code-session-id': '' });
    await request(
      {
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
          { role: 'user', content: 'again' },
        ],
      },
      { 'x-claude-code-session-id': '' },
    );
    expect(sent(0).body.prompt_cache_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent(1).body.prompt_cache_key).toBe(sent(0).body.prompt_cache_key);
  });

  test('the version header is on every request, including the retry after a 401', async () => {
    mocks.fetch
      .mockImplementationOnce(async () => new Response('{}', { status: 401 }))
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              access_token: 'rotated',
              refresh_token: 'rotated-refresh',
              expires_in: 3600,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      );
    // The refreshed credentials are what the retry reads back.
    const persist = vi.mocked(
      (await import('../src/runtime-config.js'))
        .updateProviderCodexOAuthCredentialsIfCurrent,
    );
    persist.mockImplementation((_id, _expected, refreshed) => {
      provider.codexOAuthCredentials = refreshed;
      return true;
    });
    expect((await request()).status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(sent(0).headers.version).toBe(CODEX_CLIENT_VERSION);
    expect(sent(2).headers.version).toBe(CODEX_CLIENT_VERSION);
    expect(sent(2).headers.Authorization).toBe('Bearer rotated');
    // The retry is the same request, so it stays in the same turn.
    expect(sent(2).metadata.turn_id).toBe(sent(0).metadata.turn_id);
  });
});

describe('x-codex-turn-state', () => {
  test('is replayed within a tool loop and reset by a new user turn', async () => {
    mocks.fetch
      .mockImplementationOnce(async () =>
        sse({ 'x-codex-turn-state': 'state-turn-1' }),
      )
      .mockImplementationOnce(async () =>
        sse({ 'x-codex-turn-state': 'ignored-second-value' }),
      )
      .mockImplementationOnce(async () => upstream())
      .mockImplementationOnce(async () =>
        sse({ 'x-codex-turn-state': 'state-turn-2' }),
      )
      .mockImplementationOnce(async () => upstream());
    const opening = { role: 'user', content: 'run a tool' };
    await request({ messages: [opening], tools });
    await request({ messages: [opening, toolUse, toolResult()], tools });
    await request({
      messages: [opening, toolUse, toolResult(), toolUse, toolResult('2')],
      tools,
    });
    const next = [
      opening,
      toolUse,
      toolResult(),
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'next task' },
    ];
    await request({ messages: next, tools });
    await request({ messages: [...next, toolUse, toolResult()], tools });

    const calls = [0, 1, 2, 3, 4].map(sent);
    expect(calls[0].headers).not.toHaveProperty('x-codex-turn-state');
    // Captured once per turn (OnceLock): the first value wins.
    expect(calls[1].headers['x-codex-turn-state']).toBe('state-turn-1');
    expect(calls[2].headers['x-codex-turn-state']).toBe('state-turn-1');
    expect(calls[3].headers).not.toHaveProperty('x-codex-turn-state');
    expect(calls[4].headers['x-codex-turn-state']).toBe('state-turn-2');

    const turnIds = calls.map((call) => call.metadata.turn_id);
    expect(new Set(turnIds.slice(0, 3)).size).toBe(1);
    expect(turnIds[3]).not.toBe(turnIds[0]);
    expect(turnIds[4]).toBe(turnIds[3]);
    expect(calls[1].metadata.turn_started_at_unix_ms).toBe(
      calls[0].metadata.turn_started_at_unix_ms,
    );
  });

  test('is not captured from failed responses and is kept per thread and account', async () => {
    mocks.fetch
      .mockImplementationOnce(
        async () =>
          // A non-retryable failure: 5xx would be retried by the gateway.
          new Response('{"error":{"message":"rejected"}}', {
            status: 400,
            headers: { 'x-codex-turn-state': 'from-error' },
          }),
      )
      .mockImplementationOnce(async () =>
        sse({ 'x-codex-turn-state': 'main-state' }),
      );
    const opening = { role: 'user', content: 'go' };
    expect((await request({ messages: [opening] })).status).toBe(400);
    // The retry of the opening request keeps the same turn.
    await request({ messages: [opening] });
    await request({ messages: [opening, toolUse, toolResult()], tools });
    expect(sent(1).metadata.turn_id).toBe(sent(0).metadata.turn_id);
    expect(sent(1).headers).not.toHaveProperty('x-codex-turn-state');
    expect(sent(2).headers['x-codex-turn-state']).toBe('main-state');

    // Another Claude Code agent is another thread with its own turn.
    await request(
      { messages: [opening, toolUse, toolResult()], tools },
      { 'x-claude-code-agent-id': 'agent-2' },
    );
    expect(sent(3).headers).not.toHaveProperty('x-codex-turn-state');

    // Another account never sees this account's turn state.
    provider.codexOAuthCredentials.accountId = 'account-2';
    await request({ messages: [opening, toolUse, toolResult()], tools });
    expect(sent(4).headers).not.toHaveProperty('x-codex-turn-state');
  });

  test('turn boundaries: tool results continue, new user content starts', () => {
    const opening = { role: 'user', content: 'x' };
    expect(codexTurnBoundary({ messages: [opening] }).startsTurn).toBe(true);
    expect(
      codexTurnBoundary({ messages: [opening, toolUse, toolResult()] })
        .startsTurn,
    ).toBe(false);
    expect(
      codexTurnBoundary({
        messages: [
          opening,
          { role: 'user', content: [{ type: 'text', text: 'more' }] },
        ],
      }).startsTurn,
    ).toBe(true);
    expect(
      codexTurnBoundary({
        messages: [opening, { role: 'assistant', content: 'p' }],
      }).startsTurn,
    ).toBe(false);
    // The same opening text later in the conversation is a different turn.
    expect(codexTurnBoundary({ messages: [opening] }).fingerprint).not.toBe(
      codexTurnBoundary({
        messages: [opening, { role: 'assistant', content: 'a' }, opening],
      }).fingerprint,
    );
  });
});

describe('ChatGPT infrastructure cookies', () => {
  test('keeps allowlisted cookies per account and sends them back', async () => {
    mocks.fetch.mockImplementationOnce(async () =>
      sse({}, [
        '__cf_bm=bm-value; Path=/; Domain=.chatgpt.com; Secure; HttpOnly',
        '__oailb=lb-value; Max-Age=3600; Path=/',
        '__Secure-next-auth.session-token=PRIVATE_SESSION; Path=/',
        'oai-did=PRIVATE_DEVICE; Path=/',
      ]),
    );
    await request();
    expect(sent(0).headers).not.toHaveProperty('Cookie');
    await request();
    expect(sent(1).headers.Cookie).toBe('__cf_bm=bm-value; __oailb=lb-value');
    expect(JSON.stringify(sent(1).headers)).not.toContain('PRIVATE');

    provider.codexOAuthCredentials.accountId = 'account-2';
    await request();
    expect(sent(2).headers).not.toHaveProperty('Cookie');
  });

  test('error responses update the jar too (e.g. a Cloudflare challenge)', async () => {
    mocks.fetch.mockImplementationOnce(async () => {
      const headers = new Headers();
      headers.append('set-cookie', 'cf_clearance=clear; Path=/');
      return new Response('challenge', { status: 403, headers });
    });
    await request();
    await request();
    expect(sent(1).headers.Cookie).toBe('cf_clearance=clear');
  });

  test('expiry, deletion, foreign domains and paths', () => {
    const scope = codexTransportScope('p', 'a');
    const headers = (...cookies: string[]) => {
      const result = new Headers();
      for (const cookie of cookies) result.append('set-cookie', cookie);
      return result;
    };
    const now = 1_000_000;
    storeCodexResponseCookies(
      scope,
      headers(
        '__cf_bm=short; Max-Age=10',
        '__cflb=other; Domain=example.com',
        '_cfuvid=wrong-path; Path=/other',
        '__cfruid=prefix-only; Path=/backend',
        'cf_chl_rc_m=challenge; Path=/backend-api',
      ),
      now,
    );
    expect(codexCookieHeader(scope, now)).toBe(
      '__cf_bm=short; cf_chl_rc_m=challenge',
    );
    expect(codexCookieHeader(scope, now + 11_000)).toBe(
      'cf_chl_rc_m=challenge',
    );
    storeCodexResponseCookies(
      scope,
      headers('cf_chl_rc_m=gone; Expires=Thu, 01 Jan 1970 00:00:00 GMT'),
      now,
    );
    expect(codexCookieHeader(scope, now)).toBeUndefined();
    expect(
      codexCookieHeader(codexTransportScope('p', 'b'), now),
    ).toBeUndefined();
  });

  test('forgetting a provider drops its cookies only', () => {
    const headers = new Headers();
    headers.append('set-cookie', '__oailb=x');
    storeCodexResponseCookies(codexTransportScope('p1', 'a'), headers);
    storeCodexResponseCookies(codexTransportScope('p10', 'a'), headers);
    forgetCodexTransportState('p1');
    expect(codexCookieHeader(codexTransportScope('p1', 'a'))).toBeUndefined();
    expect(codexCookieHeader(codexTransportScope('p10', 'a'))).toBe(
      '__oailb=x',
    );
  });
});

describe('gateway wiring of the request shape', () => {
  test('Lite prefix ids are namespaced by the conversation thread', async () => {
    const opening = { role: 'user', content: 'go' };
    await request({ messages: [opening], tools });
    await request({ messages: [opening, toolUse, toolResult()], tools });
    await request(
      { messages: [opening], tools },
      { 'x-claude-code-session-id': 'session-2' },
    );
    const prefix = (call: number) => sent(call).body.input[0];
    expect(prefix(0).type).toBe('additional_tools');
    expect(sent(0).headers['x-openai-internal-codex-responses-lite']).toBe(
      'true',
    );
    // Same conversation: stable ids, so the prompt prefix stays cacheable.
    expect(prefix(1).id).toBe(prefix(0).id);
    // Another conversation derives its own ids.
    expect(prefix(2).id).not.toBe(prefix(0).id);
  });

  test('the body keeps the official field order', async () => {
    await request({ tools });
    const keys = Object.keys(sent(0).body);
    expect(keys.slice(0, 2)).toEqual(['model', 'stream']);
    expect(keys.indexOf('prompt_cache_key')).toBeLessThan(keys.indexOf('text'));
    expect(keys.at(-1)).toBe('client_metadata');
  });
});

describe('request body compression', () => {
  test.skipIf(!zstdAvailable)('zstd round-trips the exact JSON body', () => {
    const request = { input: 'x'.repeat(10_000), emoji: '你好 🌍' };
    const extras = {
      promptCacheKey: 'key',
      clientMetadata: { turn_id: 'turn' },
    };
    // The body is the official-order serialization of request + extras.
    const json = serializeCodexResponsesRequest(
      request as unknown as ResponsesRequest,
      extras,
    );
    const encoded = encodeCodexUpstreamBody(request, extras);
    expect(encoded.contentEncoding).toBe('zstd');
    expect(
      zlib.zstdDecompressSync(encoded.body as Uint8Array).toString('utf8'),
    ).toBe(json);
    expect((encoded.body as Uint8Array).byteLength).toBeLessThan(json.length);
  });

  test('without zstd support the body is sent uncompressed', async () => {
    const original = zlib.zstdCompressSync;
    (zlib as { zstdCompressSync?: unknown }).zstdCompressSync = undefined;
    try {
      expect(
        encodeCodexUpstreamBody(
          { a: 1 },
          { promptCacheKey: 'k', clientMetadata: {} },
        ),
      ).toEqual({
        body: serializeCodexResponsesRequest(
          { a: 1 } as unknown as ResponsesRequest,
          { promptCacheKey: 'k', clientMetadata: {} },
        ),
      });
      await request();
      const init = mocks.fetch.mock.calls[0][1];
      expect(init.headers).not.toHaveProperty('Content-Encoding');
      expect(JSON.parse(init.body).prompt_cache_key).toBeTruthy();
    } finally {
      (zlib as { zstdCompressSync?: unknown }).zstdCompressSync = original;
    }
  });
});

describe('installation id', () => {
  test('is created once, persisted and reused', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-install-'));
    try {
      const file = path.join(dir, 'config', 'codex-installation-id');
      resetCodexInstallationIdForTests(file);
      const id = codexInstallationId();
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(fs.readFileSync(file, 'utf8')).toBe(id);
      resetCodexInstallationIdForTests(file);
      expect(codexInstallationId()).toBe(id);
      fs.writeFileSync(file, 'not-a-uuid');
      resetCodexInstallationIdForTests(file);
      const replaced = codexInstallationId();
      expect(replaced).not.toBe(id);
      expect(fs.readFileSync(file, 'utf8')).toBe(replaced);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('upstream headers deadline', () => {
  test('waits like the official client, then fails only after 300 seconds', async () => {
    vi.useFakeTimers();
    mocks.fetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal!.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        ),
    );
    let settled = false;
    const pending = request().then((response) => {
      settled = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(299_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    // A headers stall reports 504 like a stream stall; the 300-second
    // deadline exceeds the retry window, so it is not retried.
    expect((await pending).status).toBe(504);
  });
});
