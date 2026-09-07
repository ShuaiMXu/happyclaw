import { EventEmitter } from 'node:events';
import https from 'node:https';
import net from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  batchSendToUser,
  dingtalkHttpsRequest,
  sendViaGroupMessagesAPI,
} from '../src/dingtalk.js';

async function listenBlackhole(): Promise<{
  server: net.Server;
  port: number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // Accept TCP and stay silent so TLS/HTTP never complete.
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('blackhole server has no TCP port');
  }
  return {
    server,
    port: addr.port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

describe('DingTalk HTTPS send timeout against a blackhole TCP peer', () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(closers.splice(0).map((close) => close()));
  });

  test('POST wall deadline cannot be extended by trickling response bytes', async () => {
    let responseDestroyed = false;
    vi.spyOn(https, 'request').mockImplementation(
      (_options: any, callback?: any) => {
        let writer: NodeJS.Timeout | undefined;
        const req = new EventEmitter() as EventEmitter & {
          write: () => void;
          end: () => void;
          setTimeout: () => void;
          destroy: () => void;
        };
        req.write = () => undefined;
        req.setTimeout = () => undefined;
        req.destroy = () => undefined;
        req.end = () => {
          const res = new EventEmitter() as EventEmitter & {
            statusCode: number;
            headers: Record<string, string>;
            destroy: () => void;
          };
          res.statusCode = 200;
          res.headers = {};
          res.destroy = () => {
            if (writer) clearInterval(writer);
            responseDestroyed = true;
          };
          callback?.(res);
          writer = setInterval(() => res.emit('data', Buffer.from('.')), 5);
        };
        return req as any;
      },
    );
    const started = Date.now();

    await expect(
      dingtalkHttpsRequest(
        { hostname: 'trickle.example', method: 'POST', timeoutMs: 40 },
        '{}',
      ),
    ).rejects.toThrow('timed out');

    expect(Date.now() - started).toBeLessThan(500);
    expect(responseDestroyed).toBe(true);
  });

  test('sendViaGroupMessagesAPI rejects with timeout instead of hanging', async () => {
    const blackhole = await listenBlackhole();
    closers.push(blackhole.close);
    const started = Date.now();

    await expect(
      sendViaGroupMessagesAPI(
        'cidXXXX',
        'robot-code',
        'token',
        'sampleText',
        JSON.stringify({ content: 'hi' }),
        {
          hostname: '127.0.0.1',
          port: blackhole.port,
          timeoutMs: 250,
          rejectUnauthorized: false,
        },
      ),
    ).rejects.toThrow(/timed out/i);

    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('batchSendToUser rejects with timeout instead of hanging', async () => {
    const blackhole = await listenBlackhole();
    closers.push(blackhole.close);
    const started = Date.now();

    await expect(
      batchSendToUser(
        ['staff-1'],
        'robot-code',
        'token',
        'sampleText',
        JSON.stringify({ content: 'hi' }),
        {
          hostname: '127.0.0.1',
          port: blackhole.port,
          timeoutMs: 250,
          rejectUnauthorized: false,
        },
      ),
    ).rejects.toThrow(/timed out/i);

    expect(Date.now() - started).toBeLessThan(2000);
  });
});
