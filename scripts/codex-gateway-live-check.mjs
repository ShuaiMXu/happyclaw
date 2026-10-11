#!/usr/bin/env node
// npm run build && node scripts/codex-gateway-live-check.mjs
//
// Opt-in LIVE check of the ChatGPT-subscription gateway against the real
// ChatGPT Codex backend: real Agent SDK/CLI -> real Hono gateway -> chatgpt.com.
// It spends a little of the account's quota.
//
// Credentials come from an existing Codex CLI login (CODEX_AUTH_FILE, default
// ~/.codex/auth.json), read-only. Only the access token is used; the stored
// refresh token is replaced by a placeholder, so a refresh attempt fails
// harmlessly instead of rotating (and invalidating) the real login.
// Nothing secret is printed: the report holds header NAMES, a few public
// header values and body SHAPES only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const authFile =
  process.env.CODEX_AUTH_FILE || path.join(os.homedir(), '.codex/auth.json');
const proxy =
  process.env.CODEX_LIVE_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  '';
const liteModel = process.env.CODEX_LIVE_MODEL || 'gpt-6-sol';
const classicModel = process.env.CODEX_LIVE_CLASSIC_MODEL || 'gpt-5.5';
const scratch = await mkdtemp(path.join(os.tmpdir(), 'hc-codex-live-'));
const workspace = path.join(scratch, 'workspace');
const servers = [];
const wire = [];
const checks = {};
const notes = {};

function check(name, condition, note) {
  checks[name] = Boolean(condition);
  if (note !== undefined) notes[name] = note;
}

function claims(jwt) {
  try {
    const segment = jwt.split('.')[1];
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

async function listen(server) {
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

/** A one-page PDF whose text layer holds the marker. */
function tinyPdf(marker) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 18 Tf 24 72 Td (${marker}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** Record what the gateway sends upstream — names and shapes, no secrets. */
function recordUpstream(url, init, response) {
  const headers = new Headers(init?.headers);
  let body;
  try {
    let raw = init?.body;
    if (raw && typeof raw !== 'string') raw = Buffer.from(raw);
    if (Buffer.isBuffer(raw)) {
      raw =
        headers.get('content-encoding') === 'zstd'
          ? zlib.zstdDecompressSync(raw).toString('utf8')
          : raw.toString('utf8');
    }
    body = typeof raw === 'string' ? JSON.parse(raw) : undefined;
  } catch {
    body = undefined;
  }
  const input = Array.isArray(body?.input) ? body.input : [];
  wire.push({
    url: new URL(url).pathname,
    status: response?.status ?? null,
    headerNames: [...headers.keys()].sort(),
    version: headers.get('version'),
    originator: headers.get('originator'),
    userAgent: headers.get('user-agent')?.split(' ')[0] ?? null,
    responsesLite: headers.get('x-openai-internal-codex-responses-lite'),
    subagent: headers.get('x-openai-subagent'),
    contentEncoding: headers.get('content-encoding'),
    turnStateSent: headers.has('x-codex-turn-state'),
    turnStateReceived: Boolean(response?.headers.get('x-codex-turn-state')),
    requestIdReceived: Boolean(response?.headers.get('x-request-id')),
    rateLimitHeaders: response
      ? [...response.headers.keys()].filter((name) =>
          name.startsWith('x-codex-'),
        )
      : [],
    body: body && {
      keys: Object.keys(body),
      model: body.model,
      hasTopLevelTools: Array.isArray(body.tools),
      firstInputType: input[0]?.type ?? null,
      additionalTools: input.some((item) => item.type === 'additional_tools'),
      inputFile: input.some((item) =>
        item.content?.some?.((part) => part.type === 'input_file'),
      ),
      parallelToolCalls: body.parallel_tool_calls,
      reasoning: body.reasoning,
      text: body.text,
      hasClientMetadata: Boolean(body.client_metadata),
      hasPromptCacheKey: typeof body.prompt_cache_key === 'string',
      hasInstructions: 'instructions' in body,
    },
  });
}

let exitCode = 0;
try {
  const auth = JSON.parse(await readFile(authFile, 'utf8'));
  const tokens = auth.tokens ?? {};
  assert.ok(tokens.access_token, 'Codex login has no access token');
  const accessClaims = claims(tokens.access_token);
  const idClaims = claims(tokens.id_token ?? '');
  const openaiAuth = idClaims['https://api.openai.com/auth'] ?? {};
  const expiresAt = (accessClaims.exp ?? 0) * 1000;
  assert.ok(
    expiresAt > Date.now() + 30 * 60 * 1000,
    'The Codex access token expires within 30 minutes; refresh it with the Codex CLI first',
  );

  await mkdir(workspace, { recursive: true });
  // config.ts captures PROJECT_ROOT at import time: switch into the empty
  // scratch first so no real HappyClaw data directory is touched.
  process.chdir(scratch);
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

  // Same proxy wiring as production: load-env reads HTTPS_PROXY / NO_PROXY.
  if (proxy) {
    process.env.HTTPS_PROXY = proxy;
    process.env.NO_PROXY = '127.0.0.1,localhost';
  }
  // load-env announces the proxy on stdout; keep stdout for the JSON report.
  const announce = console.log;
  console.log = () => {};
  try {
    await import(pathToFileURL(path.join(repository, 'dist/load-env.js')).href);
  } finally {
    console.log = announce;
  }
  const { Hono } = await import(
    pathToFileURL(path.join(repository, 'node_modules/hono/dist/index.js')).href
  );
  const { serve } = await import(
    pathToFileURL(
      path.join(repository, 'node_modules/@hono/node-server/dist/index.mjs'),
    ).href
  );
  const sdkPath = path.join(
    repository,
    'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
  );
  const cli = path.join(
    repository,
    `node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`,
  );
  const { query } = await import(pathToFileURL(sdkPath).href);
  const { createProvider } = await import(
    pathToFileURL(path.join(repository, 'dist/runtime-config.js')).href
  );
  const { codexGatewayApp } = await import(
    pathToFileURL(path.join(repository, 'dist/codex-gateway/gateway.js')).href
  );
  const { CodexGatewayRunnerLease, resolveCodexGatewayLaunchConfig } =
    await import(
      pathToFileURL(
        path.join(repository, 'dist/codex-gateway/runner-tokens.js'),
      ).href
    );
  const { CODEX_GATEWAY_ROUTE, CODEX_GATEWAY_BASE_URL_PLACEHOLDER } =
    await import(
      pathToFileURL(path.join(repository, 'dist/codex-gateway/types.js')).href
    );

  const gatewayIdentifier = 'live-check-gateway-identifier';
  const provider = createProvider({
    name: 'Live check ChatGPT',
    type: 'third_party',
    enabled: true,
    anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
    anthropicAuthToken: gatewayIdentifier,
    anthropicModel: liteModel,
    codexOAuthCredentials: {
      accessToken: tokens.access_token,
      // Never the real refresh token: a refresh must fail, not rotate it.
      refreshToken: 'live-check-placeholder-never-refresh',
      idToken: null,
      expiresAt,
      accountId: tokens.account_id ?? openaiAuth.chatgpt_account_id ?? null,
      planType: openaiAuth.chatgpt_plan_type ?? null,
      email: idClaims.email ?? null,
      updatedAt: new Date().toISOString(),
    },
  });
  notes.plan = openaiAuth.chatgpt_plan_type ?? null;

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const response = await realFetch(input, init);
    if (url.startsWith('https://chatgpt.com/backend-api/codex/'))
      recordUpstream(url, init, response);
    return response;
  };

  // The CLI subprocess may only reach the loopback gateway.
  const denyProxy = createServer((_request, response) => {
    response.writeHead(403);
    response.end();
  });
  denyProxy.on('connect', (_request, socket) =>
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'),
  );
  const proxyUrl = await listen(denyProxy);
  const app = new Hono();
  app.route(CODEX_GATEWAY_ROUTE, codexGatewayApp);
  const gateway = await new Promise((resolve, reject) => {
    const server = serve(
      { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
      () => resolve(server),
    );
    server.once('error', reject);
  });
  servers.push(gateway);
  const gatewayUrl = `http://127.0.0.1:${gateway.address().port}${CODEX_GATEWAY_ROUTE}`;
  const lease = new CodexGatewayRunnerLease({ kind: 'host' });
  const gatewayKey = resolveCodexGatewayLaunchConfig(
    {
      anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
      anthropicAuthToken: gatewayIdentifier,
    },
    'host',
    lease,
  ).anthropicAuthToken;

  const baseEnv = {
    PATH: process.env.PATH,
    LANG: 'C.UTF-8',
    ANTHROPIC_BASE_URL: gatewayUrl,
    ANTHROPIC_API_KEY: gatewayKey,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };

  async function runAgent(name, model, prompt, tools) {
    const config = path.join(scratch, `claude-${name}`);
    await mkdir(config, { recursive: true });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 240_000);
    const startedAt = Date.now();
    const before = wire.length;
    let result = '';
    let error = null;
    try {
      for await (const message of query({
        prompt,
        options: {
          cwd: workspace,
          env: {
            ...baseEnv,
            CLAUDE_CONFIG_DIR: config,
            ANTHROPIC_MODEL: model,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
          },
          pathToClaudeCodeExecutable: cli,
          model,
          tools,
          allowedTools: tools,
          permissionMode: 'dontAsk',
          settingSources: [],
          persistSession: false,
          maxTurns: 6,
          abortController: controller,
        },
      })) {
        if (message.type === 'result') {
          result = message.result ?? '';
          if (message.is_error) error = message.subtype;
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message.slice(0, 200) : String(err);
    } finally {
      clearTimeout(timer);
    }
    const calls = wire
      .slice(before)
      .filter((entry) => entry.url.endsWith('/responses'));
    notes[name] = {
      model,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      upstreamCalls: calls.length,
      statuses: calls.map((entry) => entry.status),
      error,
    };
    return { result, error, calls };
  }

  // 1. Responses Lite model, real tool loop with reasoning replay.
  const marker = 'HAPPYCLAW_LIVE_TOOL_OK';
  const lite = await runAgent(
    'liteToolLoop',
    liteModel,
    `Use the Bash tool to run: printf '${marker}' > live-probe.txt && cat live-probe.txt . Then reply with exactly the text the command printed.`,
    ['Bash'],
  );
  check('liteLoopFinished', !lite.error && lite.result.includes(marker));
  check('liteLoopUsedTool', lite.calls.length >= 2);
  check(
    'liteAllUpstreamOk',
    lite.calls.length > 0 && lite.calls.every((entry) => entry.status === 200),
  );
  const liteBody = lite.calls[0]?.body;
  notes.liteRequestShape = liteBody;
  notes.liteHeaders = lite.calls[0] && {
    names: lite.calls[0].headerNames,
    version: lite.calls[0].version,
    originator: lite.calls[0].originator,
    userAgent: lite.calls[0].userAgent,
    responsesLite: lite.calls[0].responsesLite,
    contentEncoding: lite.calls[0].contentEncoding,
    rateLimitHeaders: lite.calls[0].rateLimitHeaders,
  };
  check(
    'turnStateReplayedInLoop',
    lite.calls.length < 2 ||
      !lite.calls[0].turnStateReceived ||
      lite.calls.slice(1).some((entry) => entry.turnStateSent),
  );

  // 2. A PDF read by the Read tool reaches the backend as a document.
  const pdfMarker = 'HCPDFMARKER42';
  await writeFile(path.join(workspace, 'sample.pdf'), tinyPdf(pdfMarker));
  const pdf = await runAgent(
    'pdfRead',
    liteModel,
    'Read the file sample.pdf with the Read tool and reply with the single all-caps word printed in it.',
    ['Read'],
  );
  notes.pdfAgentAnswered = !pdf.error && pdf.result.includes(pdfMarker);
  check(
    'pdfUpstreamOk',
    pdf.calls.length > 0 && pdf.calls.every((entry) => entry.status === 200),
  );
  notes.pdfSentAsInputFile = pdf.calls.some((entry) => entry.body?.inputFile);

  // 3. Classic (non-lite) model keeps the classic shape and still works.
  const classic = await runAgent(
    'classicModel',
    classicModel,
    'Reply with exactly: HAPPYCLAW_CLASSIC_OK',
    [],
  );
  check(
    'classicAnswered',
    !classic.error && classic.result.includes('HAPPYCLAW_CLASSIC_OK'),
  );
  notes.classicRequestShape = classic.calls[0]?.body;

  // 4. Direct gateway calls: background (haiku-tier), non-streaming, count_tokens.
  const direct = async (pathname, body) => {
    const before = wire.length;
    const response = await realFetch(`${gatewayUrl}${pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': gatewayKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, calls: wire.slice(before) };
  };
  const background = await direct('/v1/messages', {
    model: 'claude-haiku-4-5',
    max_tokens: 64,
    stream: false,
    messages: [{ role: 'user', content: 'Reply with the word: TITLE' }],
  });
  check('backgroundNonStreamOk', background.status === 200);
  notes.background = {
    status: background.status,
    effort: background.calls[0]?.body?.reasoning?.effort ?? null,
    subagent: background.calls[0]?.subagent ?? null,
  };
  // A document block exactly as Claude Code sends a PDF the model reads.
  const pdfDirect = await direct('/v1/messages', {
    model: liteModel,
    max_tokens: 256,
    stream: false,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: tinyPdf(pdfMarker).toString('base64'),
            },
          },
          {
            type: 'text',
            text: 'Reply with the single all-caps word printed in the attached PDF.',
          },
        ],
      },
    ],
  });
  notes.pdfDirect = {
    status: pdfDirect.status,
    sentAsInputFile: pdfDirect.calls.some((entry) => entry.body?.inputFile),
    upstreamStatuses: pdfDirect.calls.map((entry) => entry.status),
    answered: pdfDirect.text.includes(pdfMarker),
  };
  check('pdfDocumentAccepted', pdfDirect.status === 200);
  const counted = await direct('/v1/messages/count_tokens', {
    model: liteModel,
    messages: [{ role: 'user', content: 'Count these tokens please.' }],
  });
  check(
    'countTokensOk',
    counted.status === 200 &&
      Number.isInteger(JSON.parse(counted.text).input_tokens) &&
      counted.calls.length === 0,
  );

  notes.providerId = provider.id ? 'created' : 'missing';
  lease.revoke?.();
} catch (err) {
  exitCode = 1;
  notes.fatal = err instanceof Error ? err.message.slice(0, 300) : String(err);
} finally {
  for (const server of servers) server.close?.();
  process.chdir(repository);
  await rm(scratch, { recursive: true, force: true });
}

const failed = Object.entries(checks)
  .filter(([, ok]) => !ok)
  .map(([name]) => name);
process.stdout.write(
  `${JSON.stringify({ passed: !failed.length && exitCode === 0, failed, checks, notes }, null, 2)}\n`,
);
process.exit(failed.length || exitCode ? 1 : 0);
