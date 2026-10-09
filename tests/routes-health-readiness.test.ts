import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  databaseHealthy: true,
  deps: null as null | { queue?: object; startupReady?: boolean },
}));

vi.mock('../src/db.js', () => ({
  getRouterState: vi.fn(() => {
    if (!state.databaseHealthy) throw new Error('database unavailable');
    return null;
  }),
  getAllRegisteredGroups: vi.fn(() => ({})),
  getRegisteredGroup: vi.fn(() => undefined),
  getUserById: vi.fn(() => undefined),
  hasContainerModeGroups: vi.fn(() => false),
}));
vi.mock('../src/web-context.js', () => ({
  getWebDeps: vi.fn(() => state.deps),
  isHostExecutionGroup: vi.fn(() => false),
  hasHostExecutionPermission: vi.fn(() => false),
}));
vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: vi.fn(),
  systemConfigMiddleware: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const routes = (await import('../src/routes/monitor.js')).default;

beforeEach(() => {
  state.databaseHealthy = true;
  state.deps = { queue: {}, startupReady: false };
});

describe('GET /health startup readiness', () => {
  test('returns 503 until durable startup recovery completes', async () => {
    const response = await routes.request('/health');

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: 'unhealthy',
      checks: {
        database: true,
        queue: true,
        startup: false,
      },
    });
  });

  test('returns 200 only when database, queue, and startup are ready', async () => {
    state.deps = { queue: {}, startupReady: true };

    const response = await routes.request('/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'healthy',
      checks: {
        database: true,
        queue: true,
        startup: true,
      },
    });
  });

  test('fails closed when readiness wiring is absent', async () => {
    state.deps = { queue: {} };

    const response = await routes.request('/health');

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      checks: { startup: false },
    });
  });

  test('preserves database failure as unhealthy after startup', async () => {
    state.databaseHealthy = false;
    state.deps = { queue: {}, startupReady: true };

    const response = await routes.request('/health');

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: 'unhealthy',
      checks: {
        database: false,
        queue: true,
        startup: true,
      },
    });
  });
});
