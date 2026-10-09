import { describe, expect, test } from 'vitest';

import { CODEX_GATEWAY_BASE_URL_PLACEHOLDER } from '../src/codex-gateway/types.js';
import { assertExternalCapabilityProviderRoute } from '../src/external-capability-provider-route.js';

describe('external capability provider routes', () => {
  test('accepts public providers and proxies on the dedicated Docker network', () => {
    expect(() =>
      assertExternalCapabilityProviderRoute({
        anthropicBaseUrl: 'https://api.example.test',
        httpsProxy: 'http://external-egress-proxy:8080',
      }),
    ).not.toThrow();
    expect(() =>
      assertExternalCapabilityProviderRoute({
        anthropicBaseUrl: '',
        httpsProxy: 'http://external-egress-proxy:8080',
      }),
    ).not.toThrow();
  });

  test.each([
    ['provider loopback', { anthropicBaseUrl: 'http://127.9.8.7:3000' }],
    [
      'provider host alias',
      { anthropicBaseUrl: 'http://host.docker.internal:3000' },
    ],
    [
      'container-engine host alias',
      { anthropicBaseUrl: 'http://host.containers.internal:3000' },
    ],
    [
      'proxy host alias',
      {
        anthropicBaseUrl: 'https://api.example.test',
        httpsProxy: 'http://gateway.docker.internal:8080',
      },
    ],
    [
      'desktop loopback proxy',
      {
        anthropicBaseUrl: 'https://api.example.test',
        httpProxy: 'http://localhost:8080',
      },
    ],
  ])('rejects %s before external execution', (_label, input) => {
    expect(() => assertExternalCapabilityProviderRoute(input)).toThrow(
      /requires host access/i,
    );
  });

  test.each([
    'http://10.0.0.1:8080',
    'http://172.17.0.1:8080',
    'http://192.168.1.1:8080',
    'http://169.254.169.254:8080',
    'http://[fd00::1]:8080',
    'http://[fe80::1]:8080',
  ])('rejects proxy IP literal %s', (httpsProxy) => {
    expect(() =>
      assertExternalCapabilityProviderRoute({
        anthropicBaseUrl: 'https://api.example.test',
        httpsProxy,
      }),
    ).toThrow(/IP literal/i);
  });

  test('requires a dedicated-network proxy before external execution', () => {
    expect(() =>
      assertExternalCapabilityProviderRoute({
        anthropicBaseUrl: 'https://api.example.test',
      }),
    ).toThrow(/requires an approved HTTPS proxy/i);
  });

  test('rejects the built-in Codex gateway', () => {
    expect(() =>
      assertExternalCapabilityProviderRoute({
        anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
        httpsProxy: 'http://external-egress-proxy:8080',
      }),
    ).toThrow(/Codex gateway is host-routed/i);
  });
});
