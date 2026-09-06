import http from 'node:http';
import https from 'node:https';

import { MAX_FILE_SIZE } from './im-downloader.js';

/** Match QQ's outbound API budget so a blackhole CDN cannot hold an admitted turn. */
export const IM_MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;

export interface DownloadHttpsBufferOptions {
  /** Cancel DNS/connect, redirect, or body I/O when the admitting connection ends. */
  signal?: AbortSignal;
  /** Legacy single-protocol Agent. Redirects to another protocol are rejected. */
  agent?: http.Agent | https.Agent;
  /** Per-hop selector for protocol-aware agents such as ProxyAgent. */
  agentForUrl?: (url: URL) => http.Agent | https.Agent | undefined;
  /** Explicit protocol-specific agents; a configured-but-missing side rejects. */
  httpAgent?: http.Agent;
  httpsAgent?: https.Agent;
  /** HTTPS→HTTP redirects are rejected unless the caller explicitly opts in. */
  allowInsecureRedirects?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  followRedirects?: boolean;
  oversizedMessage?: string;
}

export function imMediaAgentForUrl(
  requestUrl: URL,
  initialProtocol: 'http:' | 'https:',
  options: Pick<
    DownloadHttpsBufferOptions,
    'agent' | 'agentForUrl' | 'httpAgent' | 'httpsAgent'
  >,
): http.Agent | https.Agent | undefined {
  if (options.agentForUrl) {
    const selected = options.agentForUrl(requestUrl);
    if (!selected) {
      throw new Error(
        `IM media agentForUrl returned no Agent for ${requestUrl.protocol} URL`,
      );
    }
    return selected;
  }

  if (options.httpAgent || options.httpsAgent) {
    const selected =
      requestUrl.protocol === 'https:' ? options.httpsAgent : options.httpAgent;
    if (!selected) {
      throw new Error(
        `No IM media Agent configured for ${requestUrl.protocol} URL`,
      );
    }
    return selected;
  }

  if (options.agent) {
    if (requestUrl.protocol !== initialProtocol) {
      throw new Error(
        `Legacy IM media Agent cannot follow ${initialProtocol}→${requestUrl.protocol} redirect; configure agentForUrl/httpAgent/httpsAgent`,
      );
    }
    return options.agent;
  }
  return undefined;
}

export function assertImMediaRedirectPolicy(
  currentUrl: URL,
  nextUrl: URL,
  allowInsecureRedirects = false,
): void {
  if (
    currentUrl.protocol === 'https:' &&
    nextUrl.protocol === 'http:' &&
    !allowInsecureRedirects
  ) {
    throw new Error('Refusing insecure IM media redirect from HTTPS to HTTP');
  }
}

export function downloadHttpsBuffer(
  url: string,
  options: DownloadHttpsBufferOptions = {},
): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? IM_MEDIA_DOWNLOAD_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_FILE_SIZE;
  const followRedirects = options.followRedirects === true;
  const oversizedMessage =
    options.oversizedMessage ?? 'File exceeds MAX_FILE_SIZE';

  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    let activeRequest: http.ClientRequest | null = null;
    let activeResponse: http.IncomingMessage | null = null;
    let deadlineTimer: NodeJS.Timeout;

    const abortError = (): Error => {
      if (options.signal?.reason instanceof Error) {
        return options.signal.reason;
      }
      const error = new Error('IM media download aborted');
      error.name = 'AbortError';
      return error;
    };

    const onAbort = (): void => finish(abortError());

    const finish = (error?: Error, value?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      options.signal?.removeEventListener('abort', onAbort);
      const request = activeRequest;
      const response = activeResponse;
      activeRequest = null;
      activeResponse = null;
      if (error) {
        response?.destroy();
        request?.destroy();
        reject(error);
      } else {
        resolve(value ?? Buffer.alloc(0));
      }
    };

    // One timer covers DNS/connect time, every redirect hop, and the complete
    // response body. Resetting a per-socket timeout at each hop would let a
    // redirect chain or trickle response hold an admitted turn indefinitely.
    deadlineTimer = setTimeout(
      () => {
        const error = new Error(
          `IM media download timed out after ${timeoutMs}ms`,
        );
        finish(error);
      },
      Math.max(0, timeoutMs),
    );

    if (options.signal?.aborted) {
      finish(abortError());
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const parseHttpUrl = (raw: string | URL, base?: URL): URL => {
      const parsed = raw instanceof URL ? raw : new URL(raw, base);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(
          `Unsupported IM media URL protocol: ${parsed.protocol || '<none>'}`,
        );
      }
      return parsed;
    };
    let initialProtocol: 'http:' | 'https:';

    const doRequest = (requestUrl: URL, redirectCount: number): void => {
      if (settled) return;
      if (redirectCount > 5) {
        finish(new Error('Too many redirects'));
        return;
      }

      const transport = requestUrl.protocol === 'https:' ? https : http;
      let req: http.ClientRequest;
      const onRequestError = (error: Error): void => finish(error);
      const onResponse = (res: http.IncomingMessage): void => {
        req.off('error', onRequestError);
        if (settled) {
          res.destroy();
          return;
        }
        activeResponse = res;
        const status = res.statusCode ?? 0;
        const isRedirect = status >= 300 && status < 400;
        if (followRedirects && isRedirect && res.headers.location) {
          let nextUrl: URL;
          try {
            nextUrl = parseHttpUrl(res.headers.location, requestUrl);
          } catch (error) {
            res.destroy();
            finish(
              error instanceof Error
                ? error
                : new Error('Invalid IM media redirect URL'),
            );
            return;
          }
          try {
            assertImMediaRedirectPolicy(
              requestUrl,
              nextUrl,
              options.allowInsecureRedirects,
            );
          } catch (error) {
            res.destroy();
            finish(
              error instanceof Error
                ? error
                : new Error('Unsafe IM media redirect'),
            );
            return;
          }
          const continueRedirect = (): void => {
            if (settled) return;
            if (activeResponse === res) activeResponse = null;
            if (activeRequest === req) activeRequest = null;
            doRequest(nextUrl, redirectCount + 1);
          };
          res.once('error', (error) => finish(error));
          res.once('aborted', () =>
            finish(new Error('IM media redirect response aborted')),
          );
          res.once('close', () => {
            if (!settled && !res.complete) {
              finish(
                new Error(
                  'IM media redirect response closed before completion',
                ),
              );
            }
          });
          res.once('end', continueRedirect);
          // Fully consume this response before replacing the tracked socket.
          // A redirect body that never ends is still bounded by deadlineTimer.
          res.resume();
          return;
        }

        if (status < 200 || status >= 300) {
          res.destroy();
          finish(new Error(`IM media download HTTP ${status || 'unknown'}`));
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (rawChunk: Buffer | Uint8Array | string) => {
          const chunk = Buffer.isBuffer(rawChunk)
            ? rawChunk
            : Buffer.from(rawChunk);
          total += chunk.length;
          if (total > maxBytes) {
            const error = new Error(oversizedMessage);
            finish(error);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => finish(undefined, Buffer.concat(chunks)));
        res.on('error', (error) => finish(error));
        res.on('aborted', () =>
          finish(new Error('IM media response aborted before completion')),
        );
        res.on('close', () => {
          if (!settled && !res.complete) {
            finish(new Error('IM media response closed before completion'));
          }
        });
      };

      try {
        req = transport.get(
          requestUrl,
          {
            agent: imMediaAgentForUrl(requestUrl, initialProtocol, options),
          },
          onResponse,
        );
      } catch (error) {
        finish(
          error instanceof Error
            ? error
            : new Error('IM media request setup failed'),
        );
        return;
      }
      activeRequest = req;
      req.once('error', onRequestError);
    };

    try {
      const initialUrl = parseHttpUrl(url);
      initialProtocol = initialUrl.protocol as 'http:' | 'https:';
      doRequest(initialUrl, 0);
    } catch (error) {
      finish(
        error instanceof Error ? error : new Error('Invalid IM media URL'),
      );
    }
  });
}
