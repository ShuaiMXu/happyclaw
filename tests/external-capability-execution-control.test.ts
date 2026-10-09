import { describe, expect, test, vi } from 'vitest';

import {
  registerExternalCapabilityExecution,
  stopExternalCapabilityExecution,
} from '../src/external-capability-execution-control.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('external capability execution control', () => {
  test('awaits process-local termination verification', async () => {
    const termination = deferred<boolean>();
    const stop = vi.fn(() => termination.promise);
    const unregister = registerExternalCapabilityExecution('run-await', stop);
    try {
      const result = stopExternalCapabilityExecution('run-await');
      let settled = false;
      void result.then(() => {
        settled = true;
      });

      await Promise.resolve();
      expect(stop).toHaveBeenCalledOnce();
      expect(settled).toBe(false);

      termination.resolve(true);
      await expect(result).resolves.toBe('stopped');
    } finally {
      unregister();
    }
  });

  test('stops every process-local execution registered for the same run', async () => {
    const first = vi.fn(() => true);
    const second = vi.fn(async () => true);
    const unregisterFirst = registerExternalCapabilityExecution(
      'run-duplicate',
      first,
    );
    const unregisterSecond = registerExternalCapabilityExecution(
      'run-duplicate',
      second,
    );
    try {
      await expect(
        stopExternalCapabilityExecution('run-duplicate'),
      ).resolves.toBe('stopped');
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();

      unregisterSecond();
      await expect(
        stopExternalCapabilityExecution('run-duplicate'),
      ).resolves.toBe('stopped');
      expect(first).toHaveBeenCalledTimes(2);
      expect(second).toHaveBeenCalledOnce();
    } finally {
      unregisterFirst();
      unregisterSecond();
    }
  });

  test('fails closed if any registered termination is rejected or unverified', async () => {
    await expect(stopExternalCapabilityExecution('missing')).resolves.toBe(
      'not_found',
    );

    const unregisterUnverified = registerExternalCapabilityExecution(
      'run-unverified',
      () => false,
    );
    const unregisterRejected = registerExternalCapabilityExecution(
      'run-rejected',
      async () => {
        throw new Error('docker unavailable');
      },
    );
    try {
      await expect(
        stopExternalCapabilityExecution('run-unverified'),
      ).resolves.toBe('unverified');
      await expect(
        stopExternalCapabilityExecution('run-rejected'),
      ).resolves.toBe('unverified');
    } finally {
      unregisterUnverified();
      unregisterRejected();
    }
  });
});
