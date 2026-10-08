import { describe, expect, test } from 'vitest';

import { getExternalCapabilitySafeErrorMetadata } from '../src/external-capability-safe-error.js';

describe('external capability safe error metadata', () => {
  test('does not retain messages, stacks, paths, or business data', () => {
    const error = Object.assign(
      new Error(
        'customer-secret.xlsx failed at /private/vault/run with QUOTE_CONTENT',
      ),
      { code: 'EIO', path: '/private/vault/run/customer-secret.xlsx' },
    );

    const metadata = getExternalCapabilitySafeErrorMetadata(error);
    expect(metadata).toEqual({ errorName: 'Error', errorCode: 'EIO' });
    expect(JSON.stringify(metadata)).not.toContain('customer-secret.xlsx');
    expect(JSON.stringify(metadata)).not.toContain('/private/vault');
    expect(JSON.stringify(metadata)).not.toContain('QUOTE_CONTENT');
  });

  test('uses a stable class for non-error throws', () => {
    expect(
      getExternalCapabilitySafeErrorMetadata('caller business content'),
    ).toEqual({ errorName: 'UnknownError' });
  });
});
