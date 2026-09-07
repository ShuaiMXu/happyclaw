import { describe, expect, test } from 'vitest';

import { deriveContainerProfileImage } from '../src/config.js';
import {
  buildContainerArgs,
  runtimeMcpServersRequireHeadroom,
} from '../src/container-runner.js';

describe('container image profiles', () => {
  test('derives the matching immutable Headroom tag', () => {
    expect(
      deriveContainerProfileImage(
        'riba2534/happyclaw-agent:git-012345',
        'headroom',
      ),
    ).toBe('riba2534/happyclaw-agent:git-012345-headroom');
    expect(
      deriveContainerProfileImage(
        'riba2534/happyclaw-agent@sha256:abc',
        'headroom',
      ),
    ).toBeNull();
  });

  test('selects Headroom only for an explicit Headroom MCP executable', () => {
    expect(
      runtimeMcpServersRequireHeadroom({
        compressor: { command: '/usr/local/bin/headroom', args: ['mcp'] },
      }),
    ).toBe(true);
    expect(
      runtimeMcpServersRequireHeadroom({
        browser: { command: 'agent-browser' },
        custom: { command: 'uvx', args: ['some-package'] },
      }),
    ).toBe(false);
  });

  test('places the selected profile image at the end of docker arguments', () => {
    const args = buildContainerArgs(
      [],
      'happyclaw-test',
      'Asia/Shanghai',
      { mode: 'host-root' },
      { addHostGateway: false },
      'happyclaw-agent:test-headroom',
    );
    expect(args.at(-1)).toBe('happyclaw-agent:test-headroom');
  });
});
