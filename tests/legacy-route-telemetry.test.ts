import { describe, expect, test, vi } from 'vitest';

const info = vi.fn();
vi.mock('../src/logger.js', () => ({
  logger: { info },
}));

const { getLegacyUserImRouteCounts, recordLegacyUserImRoute } =
  await import('../src/legacy-route-telemetry.js');

describe('legacy user-im route telemetry', () => {
  test('aggregates dynamic identifiers without recording them', () => {
    recordLegacyUserImRoute(
      'PUT',
      '/api/config/user-im/bindings/feishu%3Asecret-chat',
    );
    recordLegacyUserImRoute('PUT', '/api/config/user-im/bindings/another-chat');

    const entries = [...getLegacyUserImRouteCounts().entries()];
    expect(entries).toContainEqual([
      'PUT /api/config/user-im/bindings/:imJid',
      2,
    ]);
    expect(JSON.stringify(entries)).not.toContain('secret-chat');
    expect(info).toHaveBeenCalledTimes(2);
  });
});
