import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const dockerfile = fs.readFileSync(
  path.join(repoRoot, 'container', 'Dockerfile'),
  'utf8',
);
const entrypoint = fs.readFileSync(
  path.join(repoRoot, 'container', 'entrypoint.sh'),
  'utf8',
);
const containerRunner = fs.readFileSync(
  path.join(repoRoot, 'src', 'container-runner.ts'),
  'utf8',
);

describe('managed Chromium CDP contract', () => {
  test('defaults Chromium and agent-browser to container-local port 9222', () => {
    expect(dockerfile).toContain('ENV HAPPYCLAW_CHROMIUM_CDP_HOST=127.0.0.1');
    expect(dockerfile).toContain('ENV HAPPYCLAW_CHROMIUM_CDP_PORT=9222');
    expect(dockerfile).toContain('ENV AGENT_BROWSER_CDP=9222');

    expect(entrypoint).toContain('--remote-debugging-address="$HOST"');
    expect(entrypoint).toContain('--remote-debugging-port="$PORT"');
    expect(entrypoint).toContain(
      'export AGENT_BROWSER_CDP="$HAPPYCLAW_CHROMIUM_CDP_PORT"',
    );
  });

  test('starts Chromium only through the first agent-browser invocation', () => {
    expect(entrypoint).toContain('cat > "$AGENT_BROWSER_WRAPPER"');
    expect(entrypoint).toContain('happyclaw_startup_metric browser_deferred');
    expect(entrypoint).toContain('ensure_browser');
    expect(entrypoint).toContain(
      'phase=%s elapsed_ms=%s browser_elapsed_ms=%s',
    );
    expect(entrypoint.indexOf('ensure_browser')).toBeLessThan(
      entrypoint.indexOf(
        '/app/node_modules/agent-browser/bin/agent-browser.js "$@"',
      ),
    );
  });

  test('waits for the real HTTP endpoint and cleans up the managed browser', () => {
    expect(entrypoint).toContain('/json/version');
    expect(entrypoint).toContain('kill "$chromium_pid"');
    expect(entrypoint).toContain('wait "$chromium_pid"');
    expect(entrypoint).toContain(
      'CHROMIUM_PID_FILE=/tmp/happyclaw-chromium.pid',
    );
  });

  test('does not expose the privileged raw CDP port to the host', () => {
    expect(dockerfile).not.toMatch(/^EXPOSE\s+9222$/m);
    expect(containerRunner).not.toMatch(
      /(?:--publish|-p)\s*(?:["'`])?9222:9222/,
    );
  });
});
