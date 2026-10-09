import { describe, expect, test } from 'vitest';

import {
  EXTERNAL_CAPABILITY_MAX_BASE64_IMAGE_BYTES,
  EXTERNAL_CAPABILITY_MAX_RAW_IMAGE_BYTES,
  externalCapabilityBase64ByteLength,
} from '../src/external-capability-input-limits.js';

describe('external capability input limits', () => {
  test('keeps the largest admitted raw image within the encoded API limit', () => {
    expect(
      externalCapabilityBase64ByteLength(
        EXTERNAL_CAPABILITY_MAX_RAW_IMAGE_BYTES,
      ),
    ).toBeLessThanOrEqual(EXTERNAL_CAPABILITY_MAX_BASE64_IMAGE_BYTES);
    expect(
      externalCapabilityBase64ByteLength(
        EXTERNAL_CAPABILITY_MAX_RAW_IMAGE_BYTES + 1,
      ),
    ).toBeGreaterThan(EXTERNAL_CAPABILITY_MAX_BASE64_IMAGE_BYTES);
  });
});
