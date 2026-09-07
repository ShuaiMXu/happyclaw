import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire('/opt/happyclaw-agent/package.json');
const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
const sdk = await import(pathToFileURL(sdkEntry).href);
if (typeof sdk.query !== 'function')
  throw new Error('SDK query export missing');

const cliPackagePath =
  require.resolve('@anthropic-ai/claude-code/package.json');
const cliPackage = JSON.parse(fs.readFileSync(cliPackagePath, 'utf8'));
const cliRelative =
  typeof cliPackage.bin === 'string' ? cliPackage.bin : cliPackage.bin?.claude;
if (!cliRelative) throw new Error('Bundled Claude CLI bin missing');
const cli = path.join(path.dirname(cliPackagePath), cliRelative);
if (!fs.existsSync(cli) || fs.statSync(cli).size < 4096) {
  throw new Error('Bundled Claude CLI is not a native executable');
}

function event(response, name, data) {
  response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

const server = http.createServer((request, response) => {
  if (request.method !== 'POST') {
    response.writeHead(404).end();
    return;
  }
  request.resume();
  request.on('end', () => {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    event(response, 'message_start', {
      type: 'message_start',
      message: {
        id: 'msg_happyclaw_image_smoke',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5-20250929',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 1 },
      },
    });
    event(response, 'content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    event(response, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'IMAGE_QUERY_OK' },
    });
    event(response, 'content_block_stop', {
      type: 'content_block_stop',
      index: 0,
    });
    event(response, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
    });
    event(response, 'message_stop', { type: 'message_stop' });
    response.end();
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('Fake provider did not expose a TCP port');
}

try {
  const environment = { ...process.env };
  delete environment.CLAUDE_CODE_OAUTH_TOKEN;
  environment.ANTHROPIC_BASE_URL = `http://127.0.0.1:${address.port}`;
  environment.ANTHROPIC_AUTH_TOKEN = 'happyclaw-local-image-smoke';
  environment.ANTHROPIC_API_KEY = '';
  environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';

  let result = '';
  const conversation = sdk.query({
    prompt: 'Return IMAGE_QUERY_OK.',
    options: {
      pathToClaudeCodeExecutable: cli,
      cwd: '/tmp',
      model: 'claude-sonnet-4-5-20250929',
      env: environment,
      allowedTools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: [],
    },
  });
  for await (const message of conversation) {
    if (message.type === 'result' && message.subtype === 'success') {
      result = message.result;
    }
  }
  if (!result.includes('IMAGE_QUERY_OK')) {
    throw new Error(`Unexpected SDK result: ${JSON.stringify(result)}`);
  }
  process.stdout.write('IMAGE_SDK_QUERY_SMOKE_OK\n');
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
