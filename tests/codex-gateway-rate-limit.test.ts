import { describe, expect, test } from 'vitest';
import { CodexProviderRateLimiter } from '../src/codex-gateway/provider-rate-limit.js';

describe('bounded provider rate windows', () => {
  test('counts requests per provider and resets only after expiry', () => {
    const limiter = new CodexProviderRateLimiter(2, 2, 1000);
    expect(limiter.isLimited('provider', 100)).toBe(false);
    expect(limiter.isLimited('provider', 101)).toBe(false);
    expect(limiter.isLimited('provider', 102)).toBe(true);
    expect(limiter.isLimited('provider', 1100)).toBe(false);
    expect(limiter.size).toBe(1);
  });

  test('capacity is a hard bound; live windows are not evicted to reset budgets', () => {
    const limiter = new CodexProviderRateLimiter(2, 1, 1000);
    expect(limiter.isLimited('one', 0)).toBe(false);
    expect(limiter.isLimited('two', 1)).toBe(false);
    for (let i = 0; i < 2048; i++)
      expect(limiter.isLimited(`other-${i}`, 2)).toBe(true);
    expect(limiter.size).toBe(2);
    expect(limiter.isLimited('one', 3)).toBe(true);
    expect(limiter.isLimited('new', 1001)).toBe(false);
    expect(limiter.size).toBe(1);
  });

  test('reports when a limited key may retry', () => {
    const limiter = new CodexProviderRateLimiter(2, 1, 1000);
    expect(limiter.retryAfterMs('runner', 0)).toBe(0);
    expect(limiter.isLimited('runner', 100)).toBe(false);
    expect(limiter.isLimited('runner', 400)).toBe(true);
    expect(limiter.retryAfterMs('runner', 400)).toBe(700);
    // A full table points at the oldest live window.
    expect(limiter.isLimited('other', 500)).toBe(false);
    expect(limiter.isLimited('third', 600)).toBe(true);
    expect(limiter.retryAfterMs('third', 600)).toBe(500);
  });
});
