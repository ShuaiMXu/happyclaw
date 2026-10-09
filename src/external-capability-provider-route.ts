import { isIP } from 'node:net';

import { CONTAINER_HTTP_PROXY, CONTAINER_HTTPS_PROXY } from './config.js';
import { isCodexGatewayBaseUrl } from './codex-gateway/resolve-gateway-url.js';
import {
  getClaudeProviderConfig,
  getEnabledProviders,
} from './runtime-config.js';

const HOST_ONLY_NAMES = new Set([
  'host.docker.internal',
  'host.containers.internal',
  'gateway.docker.internal',
  'localhost',
  '::1',
  '0.0.0.0',
  '::',
]);

function normalizedHostname(url: URL): string {
  return url.hostname
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
}

function isHostOnlyHostname(hostname: string): boolean {
  return (
    HOST_ONLY_NAMES.has(hostname) ||
    hostname.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

function assertNetworkRoute(label: string, value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not an absolute network URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  const hostname = normalizedHostname(parsed);
  if (isHostOnlyHostname(hostname)) {
    throw new Error(
      `${label} requires host access, which external capability containers do not receive`,
    );
  }
  if (isIP(hostname) !== 0) {
    throw new Error(
      `${label} must use an approved DNS name rather than an IP literal`,
    );
  }
  return parsed;
}

/**
 * External calls may use only routes reachable from their dedicated Docker
 * network. Host gateways are deliberately unavailable to the confined runner.
 */
export function assertExternalCapabilityProviderRoute(input: {
  anthropicBaseUrl: string;
  httpsProxy?: string;
  httpProxy?: string;
}): void {
  if (isCodexGatewayBaseUrl(input.anthropicBaseUrl)) {
    throw new Error(
      'The built-in Codex gateway is host-routed and unavailable to external capabilities',
    );
  }
  const provider = input.anthropicBaseUrl
    ? assertNetworkRoute('Provider endpoint', input.anthropicBaseUrl)
    : null;
  if (input.httpsProxy) {
    assertNetworkRoute('HTTPS proxy', input.httpsProxy);
  }
  if (input.httpProxy) {
    assertNetworkRoute('HTTP proxy', input.httpProxy);
  }

  // The dedicated network is internal and must not have a host gateway. Every
  // Provider request therefore needs an explicitly configured proxy container
  // attached to that network. Default Provider routing is HTTPS.
  const requiredProxy =
    provider?.protocol === 'http:' ? input.httpProxy : input.httpsProxy;
  if (!requiredProxy) {
    throw new Error(
      `External capability Provider routing requires an approved ${
        provider?.protocol === 'http:' ? 'HTTP' : 'HTTPS'
      } proxy on the dedicated Docker network`,
    );
  }
}

/** Fail activation if any provider eligible for pool selection is host-routed. */
export function assertExternalCapabilityProviderRoutesReady(): void {
  const providers = getEnabledProviders();
  const baseUrls =
    providers.length > 0
      ? providers.map((provider) => provider.anthropicBaseUrl)
      : [getClaudeProviderConfig().anthropicBaseUrl];
  for (const anthropicBaseUrl of baseUrls) {
    assertExternalCapabilityProviderRoute({
      anthropicBaseUrl,
      httpsProxy: CONTAINER_HTTPS_PROXY,
      httpProxy: CONTAINER_HTTP_PROXY,
    });
  }
}
