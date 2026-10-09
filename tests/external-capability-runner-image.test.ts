import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  assertExternalCapabilityRunnerImageForTest,
  isExternalCapabilityRunnerImageReady,
  resetExternalCapabilityRunnerImageCacheForTest,
  verifyExternalCapabilityRunnerImageForTest,
} from '../src/external-capability-runner-image.js';

const IMAGE = `registry.example/happyclaw-agent@sha256:${'a'.repeat(64)}`;

describe('external capability runner image attestation', () => {
  beforeEach(() => resetExternalCapabilityRunnerImageCacheForTest());

  test('accepts a digest-pinned image with image-owned protocol metadata', async () => {
    const inspectImage = vi.fn(async () => ({ ok: true, stdout: '1\n' }));

    await expect(
      verifyExternalCapabilityRunnerImageForTest(IMAGE, { inspectImage }),
    ).resolves.toBeUndefined();
    expect(inspectImage).toHaveBeenCalledWith(IMAGE);
  });

  test('tracks positive readiness only after a successful local inspection', async () => {
    const inspectImage = vi.fn(async () => ({ ok: true, stdout: '1\n' }));

    expect(isExternalCapabilityRunnerImageReady(IMAGE)).toBe(false);
    await expect(
      assertExternalCapabilityRunnerImageForTest(IMAGE, { inspectImage }),
    ).resolves.toBeUndefined();
    expect(isExternalCapabilityRunnerImageReady(IMAGE)).toBe(true);

    await expect(
      assertExternalCapabilityRunnerImageForTest(IMAGE, { inspectImage }),
    ).resolves.toBeUndefined();
    expect(inspectImage).toHaveBeenCalledOnce();
  });

  test('forced inspection invalidates stale readiness when the local image disappears', async () => {
    const inspectImage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, stdout: '1\n' })
      .mockResolvedValueOnce({ ok: false, stdout: '' });

    await assertExternalCapabilityRunnerImageForTest(IMAGE, { inspectImage });
    expect(isExternalCapabilityRunnerImageReady(IMAGE)).toBe(true);

    await expect(
      assertExternalCapabilityRunnerImageForTest(
        IMAGE,
        { inspectImage },
        { force: true },
      ),
    ).rejects.toThrow(/does not attest/);
    expect(isExternalCapabilityRunnerImageReady(IMAGE)).toBe(false);
    expect(inspectImage).toHaveBeenCalledTimes(2);
  });

  test('rejects mutable, missing, and stale protocol images', async () => {
    const inspectImage = vi.fn(async () => ({ ok: true, stdout: '1\n' }));
    await expect(
      verifyExternalCapabilityRunnerImageForTest(
        'registry.example/happyclaw-agent:latest',
        { inspectImage },
      ),
    ).rejects.toThrow(/not immutable/);
    expect(inspectImage).not.toHaveBeenCalled();

    await expect(
      verifyExternalCapabilityRunnerImageForTest(IMAGE, {
        inspectImage: async () => ({ ok: false, stdout: '' }),
      }),
    ).rejects.toThrow(/does not attest/);
    await expect(
      verifyExternalCapabilityRunnerImageForTest(IMAGE, {
        inspectImage: async () => ({ ok: true, stdout: '0\n' }),
      }),
    ).rejects.toThrow(/does not attest/);
  });
});
