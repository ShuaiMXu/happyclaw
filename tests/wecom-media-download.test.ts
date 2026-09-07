import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { downloadAndDecryptWeComMedia } from '../src/wecom.js';

const servers: http.Server[] = [];

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return `http://127.0.0.1:${address.port}`;
}

function encryptWeComFile(plaintext: Buffer, key: Buffer): Buffer {
  const padLength = 32 - (plaintext.length % 32);
  const padded = Buffer.concat([plaintext, Buffer.alloc(padLength, padLength)]);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe('WeCom bounded encrypted media download', () => {
  test('streams a relative redirect and decrypts with the SDK primitive', async () => {
    const key = Buffer.alloc(32, 7);
    const plaintext = Buffer.from('bounded wecom payload');
    const encrypted = encryptWeComFile(plaintext, key);
    const origin = await listen((req, res) => {
      if (req.url === '/nested/start') {
        res.writeHead(302, { location: '../media' });
        res.end('drain-me');
        return;
      }
      res.writeHead(200, {
        'content-disposition': "attachment; filename*=UTF-8''hello%20world.txt",
        'content-length': encrypted.length,
      });
      res.end(encrypted);
    });

    await expect(
      downloadAndDecryptWeComMedia(
        `${origin}/nested/start`,
        key.toString('base64'),
        plaintext.length,
      ),
    ).resolves.toEqual({ buffer: plaintext, filename: 'hello world.txt' });
  });

  test('rejects declared and streamed bodies above the absolute ceiling', async () => {
    const declaredOrigin = await listen((_req, res) => {
      res.writeHead(200, { 'content-length': 100 });
      res.end(Buffer.alloc(100));
    });
    await expect(
      downloadAndDecryptWeComMedia(declaredOrigin, undefined, 10),
    ).rejects.toThrow('byte limit');

    const streamedOrigin = await listen((_req, res) => {
      res.write(Buffer.alloc(8));
      res.end(Buffer.alloc(8));
    });
    await expect(
      downloadAndDecryptWeComMedia(streamedOrigin, undefined, 10),
    ).rejects.toThrow('byte limit');
  });

  test('actively closes replaced and declared-oversize responses', async () => {
    let redirectClosed = false;
    const redirectOrigin = await listen((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/final' });
        res.flushHeaders();
        const writer = setInterval(() => res.write(Buffer.alloc(1024)), 1);
        res.on('close', () => {
          clearInterval(writer);
          redirectClosed = true;
        });
        return;
      }
      res.end('final');
    });
    await expect(
      downloadAndDecryptWeComMedia(`${redirectOrigin}/start`, undefined, 10),
    ).resolves.toEqual({ buffer: Buffer.from('final'), filename: undefined });
    await expect.poll(() => redirectClosed).toBe(true);

    let oversizeClosed = false;
    const oversizeOrigin = await listen((_req, res) => {
      res.writeHead(200, { 'content-length': 1_000_000 });
      res.flushHeaders();
      const writer = setInterval(() => res.write(Buffer.alloc(1024)), 1);
      res.on('close', () => {
        clearInterval(writer);
        oversizeClosed = true;
      });
    });
    await expect(
      downloadAndDecryptWeComMedia(oversizeOrigin, undefined, 10),
    ).rejects.toThrow('byte limit');
    await expect.poll(() => oversizeClosed).toBe(true);
  });

  test('rejects non-http URLs and bounded timeouts', async () => {
    await expect(
      downloadAndDecryptWeComMedia('file:///tmp/secret', undefined),
    ).rejects.toThrow('Unsupported WeCom media protocol');

    const origin = await listen(() => undefined);
    await expect(
      downloadAndDecryptWeComMedia(origin, undefined, 10, 20),
    ).rejects.toThrow('timed out');
  });

  test('abort signal destroys the active HTTP response', async () => {
    let responseStarted = false;
    let responseClosed = false;
    const origin = await listen((_req, res) => {
      res.writeHead(200);
      res.flushHeaders();
      responseStarted = true;
      const writer = setInterval(() => res.write(Buffer.alloc(1024)), 1);
      res.on('close', () => {
        clearInterval(writer);
        responseClosed = true;
      });
    });
    const controller = new AbortController();
    const pending = downloadAndDecryptWeComMedia(
      origin,
      undefined,
      1024 * 1024,
      1000,
      controller.signal,
    );
    await expect.poll(() => responseStarted).toBe(true);
    controller.abort();

    await expect(pending).rejects.toThrow('cancelled');
    await expect.poll(() => responseClosed).toBe(true);
  });

  test('rejects an HTTPS redirect downgrade before opening the HTTP target', async () => {
    const httpRequest = vi.spyOn(http, 'request');
    vi.spyOn(https, 'request').mockImplementation(
      (_options: any, callback?: any) => {
        const req = new EventEmitter() as EventEmitter & {
          end: () => void;
          setTimeout: () => void;
          destroy: () => void;
        };
        req.setTimeout = () => undefined;
        req.destroy = () => undefined;
        req.end = () => {
          const res = new EventEmitter() as EventEmitter & {
            statusCode: number;
            headers: Record<string, string>;
            destroy: () => void;
          };
          res.statusCode = 302;
          res.headers = { location: 'http://insecure.example/media' };
          res.destroy = () => undefined;
          callback?.(res);
        };
        return req as any;
      },
    );

    await expect(
      downloadAndDecryptWeComMedia(
        'https://secure.example/start',
        undefined,
        1024,
        1000,
      ),
    ).rejects.toThrow('HTTPS downgrade');
    expect(httpRequest).not.toHaveBeenCalled();
  });
});
