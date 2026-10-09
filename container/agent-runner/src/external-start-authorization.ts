import fs from 'node:fs';

import type { ContainerInput, ContainerOutput } from './types.js';

const AUTHORIZATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_POLL_INTERVAL_MS = 50;
const CONTROL_RECORD_MAX_BYTES = 4 * 1024;

type StartAuthorization = NonNullable<
  ContainerInput['externalStartAuthorization']
>;

type GateState = 'pending' | 'waiting' | 'confirming' | 'authorized' | 'failed';

interface ExternalStartAuthorizationGateDependencies {
  emit: (output: ContainerOutput) => void;
  decisionPath: string;
  confirmationPath: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  readFile?: (filePath: string) => string;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

function isRetryableReadError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'EACCES';
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readBoundedControlFile(filePath: string): string {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size <= 0 ||
      stat.size > CONTROL_RECORD_MAX_BYTES
    ) {
      throw new Error('External start authorization control file is invalid');
    }
    const raw = fs.readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') !== stat.size) {
      throw new Error(
        'External start authorization control file changed while being read',
      );
    }
    return raw;
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateAuthorization(
  authorization: StartAuthorization | undefined,
): asserts authorization is StartAuthorization {
  const allowedKeys = new Set(['protocol', 'authorizationId', 'expiresAt']);
  if (
    typeof authorization !== 'object' ||
    authorization === null ||
    Array.isArray(authorization) ||
    Object.keys(authorization).some((key) => !allowedKeys.has(key)) ||
    authorization.protocol !== 1 ||
    typeof authorization.authorizationId !== 'string' ||
    !AUTHORIZATION_ID_PATTERN.test(authorization.authorizationId) ||
    !Number.isSafeInteger(authorization.expiresAt) ||
    authorization.expiresAt <= 0
  ) {
    throw new Error('External start authorization metadata is invalid');
  }
}

function parseDecision(
  raw: string,
  authorizationId: string,
): 'start' | 'abort' {
  if (Buffer.byteLength(raw, 'utf8') > CONTROL_RECORD_MAX_BYTES) {
    throw new Error('External start authorization decision is oversized');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('External start authorization decision is malformed');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('External start authorization decision is malformed');
  }
  const decision = parsed as Record<string, unknown>;
  const allowedKeys = new Set(['protocol', 'authorizationId', 'decision']);
  if (
    Object.keys(decision).some((key) => !allowedKeys.has(key)) ||
    decision.protocol !== 1 ||
    decision.authorizationId !== authorizationId ||
    (decision.decision !== 'start' && decision.decision !== 'abort')
  ) {
    throw new Error('External start authorization decision does not match');
  }
  return decision.decision;
}

function parseConfirmation(raw: string, authorizationId: string): void {
  if (Buffer.byteLength(raw, 'utf8') > CONTROL_RECORD_MAX_BYTES) {
    throw new Error('External start acknowledgement confirmation is oversized');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('External start acknowledgement confirmation is malformed');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('External start acknowledgement confirmation is malformed');
  }
  const confirmation = parsed as Record<string, unknown>;
  const allowedKeys = new Set(['protocol', 'authorizationId', 'acknowledged']);
  if (
    Object.keys(confirmation).some((key) => !allowedKeys.has(key)) ||
    confirmation.protocol !== 1 ||
    confirmation.authorizationId !== authorizationId ||
    confirmation.acknowledged !== true
  ) {
    throw new Error(
      'External start acknowledgement confirmation does not match',
    );
  }
}

/**
 * One-shot gate placed immediately before SDK query(). The host first persists
 * START. The runner reports consumption over stdout, then waits for a host-only
 * durable acknowledgement and read-only confirmation before returning.
 */
export class ExternalStartAuthorizationGate {
  private state: GateState = 'pending';

  constructor(
    private readonly authorization: StartAuthorization | undefined,
    private readonly dependencies: ExternalStartAuthorizationGateDependencies,
  ) {}

  async authorize(): Promise<void> {
    if (this.state !== 'pending') {
      this.state = 'failed';
      throw new Error('External start authorization gate was reused');
    }
    try {
      validateAuthorization(this.authorization);
      this.state = 'waiting';
      this.dependencies.emit({
        status: 'stream',
        result: null,
        runnerControl: {
          type: 'external_ready',
          protocol: 1,
          authorizationId: this.authorization.authorizationId,
        },
      });

      const readFile = this.dependencies.readFile ?? readBoundedControlFile;
      const now = this.dependencies.now ?? Date.now;
      const wait = this.dependencies.wait ?? defaultWait;
      const pollIntervalMs =
        this.dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      const hostDeadline = this.authorization.expiresAt;
      const runnerDeadline = this.dependencies.timeoutMs
        ? Math.min(hostDeadline, now() + this.dependencies.timeoutMs)
        : hostDeadline;

      const readUntilAvailable = async (filePath: string): Promise<string> => {
        for (;;) {
          if (now() >= runnerDeadline) {
            throw new Error('External start authorization timed out');
          }
          try {
            const raw = readFile(filePath);
            if (now() >= runnerDeadline) {
              throw new Error('External start authorization timed out');
            }
            return raw;
          } catch (error) {
            if (!isRetryableReadError(error)) throw error;
            await wait(
              Math.min(pollIntervalMs, Math.max(1, runnerDeadline - now())),
            );
          }
        }
      };

      const decision = parseDecision(
        await readUntilAvailable(this.dependencies.decisionPath),
        this.authorization.authorizationId,
      );
      if (decision !== 'start') {
        throw new Error('External start authorization was denied');
      }

      this.state = 'confirming';
      this.dependencies.emit({
        status: 'stream',
        result: null,
        runnerControl: {
          type: 'external_start_consumed',
          protocol: 1,
          authorizationId: this.authorization.authorizationId,
        },
      });
      parseConfirmation(
        await readUntilAvailable(this.dependencies.confirmationPath),
        this.authorization.authorizationId,
      );
      if (now() >= runnerDeadline) {
        throw new Error(
          'External start authorization expired while acknowledgement was confirmed',
        );
      }
      this.state = 'authorized';
    } catch (error) {
      this.state = 'failed';
      throw error;
    }
  }
}
