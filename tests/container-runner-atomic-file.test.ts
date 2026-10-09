import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import {
  buildExternalContainerCreateArgs,
  buildExternalContainerStartArgs,
  createContainerSpawnFailureForTest,
  externalCapabilityContainerName,
  ExternalContainerSpawnError,
  isRetryableExternalPreReadyOutput,
  writeAtomicFileForTest,
} from '../src/container-runner.js';

describe('container runner atomic file publication', () => {
  test('reapplies an exact cross-UID mode under a restrictive host umask', () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-atomic-mode-'),
    );
    const target = path.join(directory, 'decision.json');
    const previousUmask = process.umask(0o077);

    try {
      writeAtomicFileForTest(target, '{"decision":"start"}\n', 0o444);
      expect(fs.readFileSync(target, 'utf8')).toBe('{"decision":"start"}\n');
      expect(fs.statSync(target).mode & 0o777).toBe(0o444);
      expect(
        fs
          .readdirSync(directory)
          .filter((name) => name !== path.basename(target)),
      ).toEqual([]);
    } finally {
      process.umask(previousUmask);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('fsyncs both the published file and its parent directory', () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-atomic-fsync-'),
    );
    const fsync = vi.spyOn(fs, 'fsyncSync');
    try {
      writeAtomicFileForTest(
        path.join(directory, 'acknowledged.json'),
        '{"acknowledged":true}\n',
        0o444,
      );
      expect(fsync).toHaveBeenCalledTimes(2);
    } finally {
      fsync.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('external runner pre-READY failures', () => {
  test('retries only terminal initialization errors from an attested runner', () => {
    expect(
      isRetryableExternalPreReadyOutput({
        status: 'error',
        result: null,
        error: 'initialization failed',
      }),
    ).toBe(true);
    expect(
      isRetryableExternalPreReadyOutput({
        status: 'success',
        result: 'unexpected output',
      }),
    ).toBe(false);
    expect(
      isRetryableExternalPreReadyOutput({
        status: 'stream',
        result: null,
        runnerControl: {
          type: 'external_ready',
          protocol: 1,
          authorizationId: 'attempt-1',
        },
      }),
    ).toBe(false);
  });
});

describe('external container create/start split', () => {
  test('creates the Docker object before attaching to its process', () => {
    expect(externalCapabilityContainerName('run:1', 2, 7)).toMatch(
      /^happyclaw-[0-9a-f]{20}-external-run-1-2-7$/,
    );
    expect(
      buildExternalContainerCreateArgs([
        'run',
        '-i',
        '--rm',
        '--name',
        'happyclaw-external-run-1-1-1',
        'runner@example-digest',
      ]),
    ).toEqual([
      'create',
      '-i',
      '--rm',
      '--name',
      'happyclaw-external-run-1-1-1',
      'runner@example-digest',
    ]);
    expect(
      buildExternalContainerStartArgs('happyclaw-external-run-1-1-1'),
    ).toEqual([
      'start',
      '--attach',
      '--interactive',
      'happyclaw-external-run-1-1-1',
    ]);
  });

  test('refuses to reinterpret non-run Docker arguments', () => {
    expect(() =>
      buildExternalContainerCreateArgs(['start', 'unexpected']),
    ).toThrow('Expected Docker run arguments');
  });
});

describe('container runner spawn failures', () => {
  test('classifies external pre-spawn failures for bounded retry', () => {
    const failure = createContainerSpawnFailureForTest(
      Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }),
      true,
    );

    expect(failure).toBeInstanceOf(ExternalContainerSpawnError);
    expect(failure).toMatchObject({
      code: 'EXTERNAL_CONTAINER_SPAWN_FAILED',
      message: 'Container spawn failed',
    });
  });

  test('preserves the legacy non-external error result', () => {
    expect(
      createContainerSpawnFailureForTest(
        new Error('spawn docker EMFILE'),
        false,
      ),
    ).toEqual({
      status: 'error',
      result: null,
      error: 'Container spawn error: spawn docker EMFILE',
    });
  });
});
