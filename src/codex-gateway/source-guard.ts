// ─── ChatGPT/Codex 订阅网关 — 来源校验 ─────────────────────────────
//
// 网关挂在公开的 WEB_PORT 上，但只服务本机 Runner：宿主机模式走 127.0.0.1，
// 容器模式经 host.docker.internal 从 Docker 私网地址回连。带反向代理转发头
// 的请求说明经过了反代（即可能来自公网），来源是公网地址的请求同理，两者
// 即使带着有效 token 也拒绝。
//
// 残余风险：同机反代若既不加转发头又从回环地址转发（如默认配置的
// nginx proxy_pass），来源校验无法识别；此时仍需要一枚存活 Runner 的 token。

import net from 'node:net';

const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-real-ip',
  'x-forwarded-host',
  'x-forwarded-proto',
];

export function hasForwardingHeaders(headers: Headers): boolean {
  return FORWARDING_HEADERS.some((name) => headers.has(name));
}

/** Loopback, RFC 1918/6598 private, link-local or IPv6 ULA source addresses. */
export function isLocalNetworkAddress(
  address: string | null | undefined,
): boolean {
  if (!address) return false;
  let value = address.trim();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) value = mapped[1];
  if (net.isIPv4(value)) {
    const [a, b] = value.split('.').map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      // Shared address space: rootless Docker/VPN bridges, never public.
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (net.isIPv6(value)) {
    const lower = value.toLowerCase();
    return (
      lower === '::1' ||
      /^f[cd][0-9a-f]{2}:/.test(lower) ||
      /^fe[89ab][0-9a-f]:/.test(lower)
    );
  }
  return false;
}

/**
 * The reason a request must be refused before authentication, or null. The
 * remote address comes from the Node adapter's socket, never from headers.
 */
export function rejectNonLocalGatewaySource(
  headers: Headers,
  remoteAddress: string | null | undefined,
): string | null {
  if (hasForwardingHeaders(headers)) {
    return 'Codex gateway does not accept proxied requests';
  }
  if (!isLocalNetworkAddress(remoteAddress)) {
    return 'Codex gateway only accepts requests from local runners';
  }
  return null;
}
