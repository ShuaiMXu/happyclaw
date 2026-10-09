import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import { ExternalStartAuthorizationGate } from '../src/external-start-authorization.js';

function fileError(code: 'ENOENT' | 'EACCES'): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function authorization(expiresAt = Date.now() + 30_000) {
  return { protocol: 1 as const, authorizationId: 'attempt-1', expiresAt };
}

const decision = (value: 'start' | 'abort' = 'start') =>
  JSON.stringify({
    protocol: 1,
    authorizationId: 'attempt-1',
    decision: value,
  });
const confirmation = () =>
  JSON.stringify({
    protocol: 1,
    authorizationId: 'attempt-1',
    acknowledged: true,
  });

describe('external runner start authorization', () => {
  test('does not cross query until START is consumed and host-confirmed', async () => {
    const emit = vi.fn();
    const operations: string[] = [];
    const query = vi.fn(() => operations.push('query'));
    let publishedDecision: string | null = null;
    let publishedConfirmation: string | null = null;
    const gate = new ExternalStartAuthorizationGate(authorization(), {
      emit,
      decisionPath: '/authorization/decision.json',
      confirmationPath: '/authorization/acknowledged.json',
      readFile: (filePath) => {
        const value = filePath.endsWith('decision.json')
          ? publishedDecision
          : publishedConfirmation;
        if (value === null) throw fileError('ENOENT');
        return value;
      },
      wait: async () => {
        if (publishedDecision === null) {
          expect(query).not.toHaveBeenCalled();
          publishedDecision = decision();
          return;
        }
        expect(emit).toHaveBeenLastCalledWith({
          status: 'stream',
          result: null,
          runnerControl: {
            type: 'external_start_consumed',
            protocol: 1,
            authorizationId: 'attempt-1',
          },
        });
        operations.push('host-acknowledgement');
        publishedConfirmation = confirmation();
      },
    });

    await gate.authorize();
    query();

    expect(emit).toHaveBeenNthCalledWith(1, {
      status: 'stream',
      result: null,
      runnerControl: {
        type: 'external_ready',
        protocol: 1,
        authorizationId: 'attempt-1',
      },
    });
    expect(query).toHaveBeenCalledOnce();
    expect(operations).toEqual(['host-acknowledgement', 'query']);
  });

  test('does not return across query boundary when confirmation is invalid', async () => {
    const query = vi.fn();
    const gate = new ExternalStartAuthorizationGate(authorization(), {
      emit: vi.fn(),
      decisionPath: '/decision',
      confirmationPath: '/confirmation',
      readFile: (filePath) =>
        filePath === '/decision'
          ? decision()
          : JSON.stringify({
              protocol: 1,
              authorizationId: 'attempt-1',
              acknowledged: false,
            }),
    });

    await expect(gate.authorize().then(() => query())).rejects.toThrow(
      /confirmation does not match/,
    );
    expect(query).not.toHaveBeenCalled();
  });

  test.each([
    JSON.stringify({
      protocol: 1,
      authorizationId: 'wrong-attempt',
      decision: 'start',
    }),
    JSON.stringify({
      protocol: 1,
      authorizationId: 'attempt-1',
      decision: 'start',
      extra: true,
    }),
    '{broken',
  ])('fails closed for a malformed or mismatched decision', async (raw) => {
    const gate = new ExternalStartAuthorizationGate(authorization(), {
      emit: vi.fn(),
      decisionPath: '/decision',
      confirmationPath: '/confirmation',
      readFile: () => raw,
    });

    await expect(gate.authorize()).rejects.toThrow(/authorization decision/);
  });

  test('rejects authorization metadata with unknown fields', async () => {
    const gate = new ExternalStartAuthorizationGate(
      {
        ...authorization(),
        extra: true,
      } as ReturnType<typeof authorization>,
      {
        emit: vi.fn(),
        decisionPath: '/decision',
        confirmationPath: '/confirmation',
        readFile: () => {
          throw new Error('decision must not be read');
        },
      },
    );

    await expect(gate.authorize()).rejects.toThrow(/metadata is invalid/);
  });

  test('fails closed on ABORT and rejects duplicate gate use', async () => {
    const gate = new ExternalStartAuthorizationGate(authorization(), {
      emit: vi.fn(),
      decisionPath: '/decision',
      confirmationPath: '/confirmation',
      readFile: () => decision('abort'),
    });

    await expect(gate.authorize()).rejects.toThrow(/was denied/);
    await expect(gate.authorize()).rejects.toThrow(/was reused/);
  });

  test.each(['ENOENT', 'EACCES'] as const)(
    'times out while a host decision remains unavailable with %s',
    async (errorCode) => {
      let now = 0;
      const gate = new ExternalStartAuthorizationGate(authorization(100), {
        emit: vi.fn(),
        decisionPath: '/decision',
        confirmationPath: '/confirmation',
        timeoutMs: 10,
        pollIntervalMs: 5,
        readFile: () => {
          throw fileError(errorCode);
        },
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds;
        },
      });

      await expect(gate.authorize()).rejects.toThrow(/timed out/);
    },
  );

  test('does not enter query when confirmation crosses the deadline', async () => {
    let now = 0;
    const query = vi.fn();
    const gate = new ExternalStartAuthorizationGate(authorization(5), {
      emit: vi.fn(),
      decisionPath: '/decision',
      confirmationPath: '/confirmation',
      readFile: (filePath) => {
        if (filePath === '/decision') return decision();
        now = 6;
        return confirmation();
      },
      now: () => now,
      wait: async () => {},
    });

    await expect(gate.authorize().then(() => query())).rejects.toThrow(
      /timed out|expired while acknowledgement was confirmed/,
    );
    expect(query).not.toHaveBeenCalled();
  });

  test('rejects START when the decision read itself crosses the deadline', async () => {
    let now = 0;
    const gate = new ExternalStartAuthorizationGate(authorization(5), {
      emit: vi.fn(),
      decisionPath: '/decision',
      confirmationPath: '/confirmation',
      timeoutMs: 10,
      readFile: () => {
        now = 10;
        return decision();
      },
      now: () => now,
      wait: async () => {},
    });

    await expect(gate.authorize()).rejects.toThrow(/timed out/);
  });

  test('rejects a decision observed after the runner deadline', async () => {
    let now = 0;
    const gate = new ExternalStartAuthorizationGate(authorization(5), {
      emit: vi.fn(),
      decisionPath: '/decision',
      confirmationPath: '/confirmation',
      timeoutMs: 10,
      pollIntervalMs: 10,
      readFile: () => {
        if (now < 10) throw fileError('ENOENT');
        return decision();
      },
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
    });

    await expect(gate.authorize()).rejects.toThrow(/timed out/);
  });

  test('rejects oversized or multiply-linked host control files before reading them', async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'external-start-control-'),
    );
    const decisionPath = path.join(directory, 'decision.json');
    const confirmationPath = path.join(directory, 'acknowledged.json');
    try {
      fs.writeFileSync(decisionPath, 'x'.repeat(4 * 1024 + 1));
      const oversized = new ExternalStartAuthorizationGate(authorization(), {
        emit: vi.fn(),
        decisionPath,
        confirmationPath,
      });
      await expect(oversized.authorize()).rejects.toThrow(
        /control file is invalid/,
      );

      fs.rmSync(decisionPath);
      fs.writeFileSync(decisionPath, decision());
      fs.linkSync(decisionPath, path.join(directory, 'decision-link.json'));
      const linked = new ExternalStartAuthorizationGate(authorization(), {
        emit: vi.fn(),
        decisionPath,
        confirmationPath,
      });
      await expect(linked.authorize()).rejects.toThrow(
        /control file is invalid/,
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects oversized injected control records before parsing', async () => {
    const gate = new ExternalStartAuthorizationGate(authorization(), {
      emit: vi.fn(),
      decisionPath: '/decision',
      confirmationPath: '/confirmation',
      readFile: () => 'x'.repeat(4 * 1024 + 1),
    });

    await expect(gate.authorize()).rejects.toThrow(/oversized/);
  });
});
