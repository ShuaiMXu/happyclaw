import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createBoundedRescanScheduler,
  MAX_PENDING_RESCAN_TARGETS,
} from '../container/session-permissions-rescan-queue.mjs';

afterEach(() => {
  vi.useRealTimers();
});

describe('bounded permission rescan scheduler', () => {
  test('deduplicates hot targets and drains them once', () => {
    vi.useFakeTimers();
    const scanned: string[] = [];
    const scheduler = createBoundedRescanScheduler({
      runTarget: (target: string) => scanned.push(target),
      runFull: () => scanned.push('FULL'),
      onError: (error: unknown) => {
        throw error;
      },
    });

    for (let index = 0; index < 10_000; index += 1) {
      scheduler.enqueueTarget('hot', 'hot');
    }
    expect(scheduler.getPendingTargetCount()).toBe(1);

    vi.runAllTimers();
    expect(scanned).toEqual(['hot']);
  });

  test('collapses an unbounded unique-path burst into one full scan', () => {
    vi.useFakeTimers();
    const scanned: string[] = [];
    const scheduler = createBoundedRescanScheduler({
      runTarget: (target: string) => scanned.push(target),
      runFull: () => scanned.push('FULL'),
      onError: (error: unknown) => {
        throw error;
      },
    });

    for (let index = 0; index < 100_000; index += 1) {
      scheduler.enqueueTarget(`target-${index}`, `target-${index}`);
    }
    expect(scheduler.getPendingTargetCount()).toBe(0);
    expect(scheduler.isFullScanPending()).toBe(true);

    vi.runAllTimers();
    expect(scanned).toEqual(['FULL']);
  });

  test('accepts new targeted work after an overflow scan', () => {
    vi.useFakeTimers();
    const scanned: string[] = [];
    const scheduler = createBoundedRescanScheduler({
      runTarget: (target: string) => scanned.push(target),
      runFull: () => scanned.push('FULL'),
      onError: (error: unknown) => {
        throw error;
      },
    });

    for (let index = 0; index <= MAX_PENDING_RESCAN_TARGETS; index += 1) {
      scheduler.enqueueTarget(`first-${index}`, `first-${index}`);
    }
    vi.runAllTimers();
    scheduler.enqueueTarget('after-overflow', 'after-overflow');
    vi.runAllTimers();

    expect(scanned).toEqual(['FULL', 'after-overflow']);
  });

  test('stop clears queued paths and prevents later scans', () => {
    vi.useFakeTimers();
    const scanned: string[] = [];
    const scheduler = createBoundedRescanScheduler({
      runTarget: (target: string) => scanned.push(target),
      runFull: () => scanned.push('FULL'),
      onError: (error: unknown) => {
        throw error;
      },
    });

    scheduler.enqueueTarget('queued', 'queued');
    scheduler.stop();
    vi.runAllTimers();

    expect(scheduler.getPendingTargetCount()).toBe(0);
    expect(scheduler.isFullScanPending()).toBe(false);
    expect(scanned).toEqual([]);
  });
});
