import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

// Real database in a temp DATA_DIR; provider configuration is mocked so the
// container-runner selection functions run their actual decision branches.
const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-session-model-'),
);

const mocks = vi.hoisted(() => ({
  providers: [] as Array<{
    id: string;
    enabled: boolean;
    weight: number;
    anthropicModel: string;
  }>,
  strategy: 'round-robin' as
    | 'round-robin'
    | 'weighted-round-robin'
    | 'failover',
}));

vi.mock('../src/config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/config.js')>(
      '../src/config.js',
    );
  return {
    ...actual,
    DATA_DIR: tmpRoot,
    STORE_DIR: path.join(tmpRoot, 'db'),
    GROUPS_DIR: path.join(tmpRoot, 'groups'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/runtime-config.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/runtime-config.js')
  >('../src/runtime-config.js');
  return {
    ...actual,
    getProviders: () => mocks.providers,
    getEnabledProviders: () => mocks.providers.filter((p) => p.enabled),
    getContainerEnvConfig: () => ({}),
    getBalancingConfig: () => ({
      strategy: mocks.strategy,
      unhealthyThreshold: 3,
      recoveryIntervalMs: 300_000,
    }),
    resolveProviderById: (id: string) => ({
      config: { anthropicBaseUrl: `https://${id}.example` },
      customEnv: {},
    }),
  };
});

const db = await import('../src/db.ts');
const runner = await import('../src/container-runner.ts');
const { providerPool } = await import('../src/provider-pool.ts');

function setProviders(...entries: Array<[string, boolean]>) {
  mocks.providers = entries.map(([id, enabled]) => ({
    id,
    enabled,
    weight: 1,
    anthropicModel: `${id}-model`,
  }));
  for (const [id] of entries) providerPool.resetHealth(id);
}

beforeAll(() => {
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  db.deleteAllSessionsForFolder('grp');
  db.setSessionModelSelection('grp', null, null);
  db.setSessionModelSelection('grp', 'agent-1', null);
  mocks.strategy = 'round-robin';
  setProviders(['A', true], ['B', true], ['C', false]);
});

describe('session model selection storage', () => {
  test('is scoped per conversation and cleared by null', () => {
    db.setSessionModelSelection('grp', null, 'A', 'user-1');
    db.setSessionModelSelection('grp', 'agent-1', 'B', 'user-1');
    expect(db.getSessionModelSelection('grp', null)).toBe('A');
    expect(db.getSessionModelSelection('grp', '')).toBe('A');
    expect(db.getSessionModelSelection('grp', 'agent-1')).toBe('B');

    db.setSessionModelSelection('grp', null, null);
    expect(db.getSessionModelSelection('grp', null)).toBeNull();
    expect(db.getSessionModelSelection('grp', 'agent-1')).toBe('B');
  });

  test('survives a context reset, unlike the SDK resume row', () => {
    db.setSession('grp', 'sess-1', null);
    db.setSessionModelSelection('grp', null, 'B');
    db.deleteSession('grp', null);
    expect(db.getSessionModelSelection('grp', null)).toBe('B');
  });

  test('deleting a model configuration clears every selection of it', () => {
    db.setSessionModelSelection('grp', null, 'B');
    db.setSessionModelSelection('grp', 'agent-1', 'B');
    expect(db.countSessionModelSelectionsForModelConfig('B')).toBe(2);
    expect(db.clearSessionModelSelectionsForModelConfig('B')).toBe(2);
    expect(db.getSessionModelSelection('grp', null)).toBeNull();
    expect(db.getSessionModelSelection('grp', 'agent-1')).toBeNull();
  });
});

describe('session model selection drives provider choice', () => {
  test('a stale selection degrades to the default', () => {
    db.setSessionModelSelection('grp', null, 'deleted');
    expect(runner.resolveSessionModelSelection('grp', null)).toBeNull();
    db.setSessionModelSelection('grp', null, 'C');
    expect(runner.resolveSessionModelSelection('grp', null)).toBe('C');
  });

  test('outranks the Agent binding and may use a disabled configuration', () => {
    db.setSessionModelSelection('grp', null, 'C');
    const result = runner.trySelectPoolProvider('grp', null, 'A');
    expect(result?.profileId).toBe('C');
    providerPool.releaseSession('C');
  });

  test('only applies to its own conversation', () => {
    db.setSessionModelSelection('grp', 'agent-1', 'C');
    const result = runner.trySelectPoolProvider('grp', null, 'A');
    expect(result?.profileId).toBe('A');
    providerPool.releaseSession('A');
  });

  test('switching the selection resets the bound session and predicts it', () => {
    db.setSessionProviderId('grp', null, 'A');
    db.setSessionModelSelection('grp', null, 'B');
    expect(runner.willClearSessionOnProviderSwitch('grp', null)).toBe(true);

    const result = runner.trySelectPoolProvider('grp', null);
    expect(result).toMatchObject({
      profileId: 'B',
      previousProviderId: 'A',
      resetSession: true,
    });
    providerPool.releaseSession('B');
    expect(runner.willClearSessionOnProviderSwitch('grp', null)).toBe(false);
  });

  test('a pinned conversation no longer rotates through the pool', () => {
    expect(runner.shouldRotatePoolProviderAfterTurn('grp', null)).toBe(true);
    db.setSessionModelSelection('grp', 'agent-1', 'A');
    expect(runner.shouldRotatePoolProviderAfterTurn('grp', null)).toBe(true);
    expect(
      runner.shouldRotatePoolProviderAfterTurn('grp', null, 'agent-1'),
    ).toBe(false);
  });
});
