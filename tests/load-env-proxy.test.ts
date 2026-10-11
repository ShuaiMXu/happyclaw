import { afterEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setGlobalDispatcher: vi.fn(),
  setGlobalProxyFromEnv: vi.fn() as ReturnType<typeof vi.fn> | undefined,
}));

vi.mock('undici', () => ({
  setGlobalDispatcher: mocks.setGlobalDispatcher,
  EnvHttpProxyAgent: class {},
}));
vi.mock('node:http', () => ({
  default: {
    get setGlobalProxyFromEnv() {
      return mocks.setGlobalProxyFromEnv;
    },
  },
}));

const originalProxy = process.env.HTTPS_PROXY;

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  mocks.setGlobalDispatcher.mockReset();
  if (originalProxy === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = originalProxy;
});

async function loadWithProxy(): Promise<void> {
  process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
    throw new Error('no .env');
  });
  await import('../src/load-env.js');
}

describe('load-env proxy setup', () => {
  test('also enables Node’s own env proxy where fetch ignores undici 6', async () => {
    mocks.setGlobalProxyFromEnv = vi.fn();
    await loadWithProxy();
    expect(mocks.setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(mocks.setGlobalProxyFromEnv).toHaveBeenCalledTimes(1);
  });

  test('keeps the undici dispatcher alone on runtimes without the API', async () => {
    mocks.setGlobalProxyFromEnv = undefined;
    await loadWithProxy();
    expect(mocks.setGlobalDispatcher).toHaveBeenCalledTimes(1);
  });
});
