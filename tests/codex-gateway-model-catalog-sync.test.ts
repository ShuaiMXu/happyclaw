import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

const resolveCodexAccess = vi.hoisted(() => vi.fn());
vi.mock('../src/codex-gateway/token-manager.js', () => ({
  resolveCodexAccess,
}));

import {
  clampCodexEffortWithCatalog,
  getCodexModelTraits,
} from '../src/codex-gateway/model-catalog.js';
import {
  ensureCodexProviderCatalog,
  getCodexCatalogForProvider,
  getResolvedCodexCatalog,
  initCodexCatalogSync,
  maybeRefreshCodexCatalog,
  maybeRefreshCodexProviderCatalog,
  noteCodexModelsEtag,
  parseUpstreamModelCatalog,
  refreshCodexCatalog,
  refreshCodexProviderCatalog,
  resetCodexCatalogSyncForTests,
  resolveCodexCatalogForProvider,
  setCodexCatalogDiskCachePathForTests,
} from '../src/codex-gateway/model-catalog-sync.js';

/** 永不 resolve 的 fetch 桩：init 的后台刷新不触发真实网络、不产生迟到回调。 */
function neverSettleFetch(): Promise<Response> {
  return new Promise<Response>(() => {});
}

// 按真实上游 codex-rs/models-manager/models.json 的结构裁剪的 fixture。
const UPSTREAM_PAYLOAD = {
  models: [
    {
      slug: 'gpt-6-sol',
      display_name: 'GPT-6-Sol',
      description: 'Workhorse model for coding and everyday work.',
      visibility: 'list',
      supported_in_api: true,
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses' },
        { effort: 'medium', description: 'Balanced' },
        { effort: 'high', description: 'Greater depth' },
        { effort: 'xhigh', description: 'Extra high' },
        { effort: 'max', description: 'Maximum' },
        { effort: 'ultra', description: 'Maximum with delegation' },
      ],
    },
    {
      slug: 'gpt-9-aurora',
      display_name: 'GPT-9 Aurora',
      description: 'Future flagship model.',
      visibility: 'list',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses' },
        { effort: 'medium', description: 'Balanced' },
      ],
    },
    {
      slug: 'gpt-daybreak-red-latest',
      display_name: 'Daybreak Red',
      description: 'Cyber-permissive variant.',
      visibility: 'hide',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses' },
      ],
    },
    {
      slug: 'gpt-no-efforts',
      display_name: 'No Efforts',
      visibility: 'list',
      supported_reasoning_levels: [],
    },
  ],
};

function mockFetchWith(payload: unknown, status = 200) {
  return vi.fn(
    async () => new Response(JSON.stringify(payload), { status }),
  ) as unknown as typeof fetch;
}

describe('Codex model catalog upstream sync', () => {
  afterEach(() => {
    resetCodexCatalogSyncForTests();
    setCodexCatalogDiskCachePathForTests(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('parses upstream payload: keeps list-visible models with efforts', () => {
    const entries = parseUpstreamModelCatalog(UPSTREAM_PAYLOAD);
    expect(entries.map((entry) => entry.value)).toEqual([
      'gpt-6-sol',
      'gpt-9-aurora',
    ]);
    const sol = entries[0];
    expect(sol.efforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
  });

  test('keeps curated label for known slugs, derives label for new models', () => {
    const entries = parseUpstreamModelCatalog(UPSTREAM_PAYLOAD);
    expect(entries[0].label).toBe('gpt-6-sol（上一代编码）');
    expect(entries[1].label).toBe('gpt-9-aurora（GPT-9 Aurora）');
  });

  test('rejects malformed payloads', () => {
    expect(() => parseUpstreamModelCatalog(null)).toThrow();
    expect(() => parseUpstreamModelCatalog({})).toThrow();
    expect(() => parseUpstreamModelCatalog({ models: [] })).toThrow();
    expect(() =>
      parseUpstreamModelCatalog({
        models: [
          {
            slug: 'a',
            visibility: 'hide',
            supported_reasoning_levels: [{ effort: 'low' }],
          },
        ],
      }),
    ).toThrow();
  });

  test('refresh applies upstream catalog and reports upstream source', async () => {
    const fetchImpl = mockFetchWith(UPSTREAM_PAYLOAD);
    const ok = await refreshCodexCatalog({ fetchImpl });
    expect(ok).toBe(true);
    const resolved = getResolvedCodexCatalog();
    expect(resolved.source).toBe('upstream');
    expect(resolved.models.map((entry) => entry.value)).toContain(
      'gpt-9-aurora',
    );
  });

  test('failed refresh keeps the current catalog', async () => {
    const before = getResolvedCodexCatalog();
    const fetchImpl = mockFetchWith({ error: 'rate limited' }, 429);
    const ok = await refreshCodexCatalog({ fetchImpl });
    expect(ok).toBe(false);
    expect(getResolvedCodexCatalog()).toBe(before);
  });

  test('concurrent refreshes share a single upstream fetch (single-flight)', async () => {
    let resolveFetch: (value: Response) => void = () => {};
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ) as unknown as typeof fetch;
    const first = refreshCodexCatalog({ fetchImpl });
    const second = refreshCodexCatalog({ fetchImpl });
    resolveFetch(
      new Response(JSON.stringify(UPSTREAM_PAYLOAD), { status: 200 }),
    );
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('init loads disk cache synchronously and stays builtin on corruption', () => {
    // null 磁盘路径（测试环境禁写）→ init 后应停留在 baked-in 兜底
    setCodexCatalogDiskCachePathForTests(null);
    initCodexCatalogSync({ fetchImpl: neverSettleFetch });
    const resolved = getResolvedCodexCatalog();
    expect(resolved.source).toBe('builtin');
    expect(resolved.models.length).toBeGreaterThan(0);
  });

  test('clampCodexEffortWithCatalog honors resolved catalog efforts', () => {
    const catalog = parseUpstreamModelCatalog(UPSTREAM_PAYLOAD);
    // 上游目录里 gpt-6-sol 支持 ultra → 透传
    expect(clampCodexEffortWithCatalog(catalog, 'gpt-6-sol', 'ultra')).toBe(
      'ultra',
    );
    // 新模型 gpt-9-aurora 只有 low/medium 且无上游默认档 → high 归位第一个档
    expect(clampCodexEffortWithCatalog(catalog, 'gpt-9-aurora', 'high')).toBe(
      'low',
    );
    // 目录外模型透传
    expect(clampCodexEffortWithCatalog(catalog, 'gpt-8-future', 'ultra')).toBe(
      'ultra',
    );
  });

  test('filters upstream efforts through the known whitelist', () => {
    const entries = parseUpstreamModelCatalog({
      models: [
        {
          slug: 'm-junk-only',
          visibility: 'list',
          supported_reasoning_levels: [
            { effort: 'minimal' },
            { effort: 'turbo-junk' },
          ],
        },
        {
          slug: 'm-mixed',
          visibility: 'list',
          display_name: 'Mixed',
          supported_reasoning_levels: [
            { effort: 'junk' },
            { effort: 'low' },
            { effort: 'medium' },
          ],
        },
      ],
    });
    // 全部档位都不在白名单里的模型被跳过；混合档位只保留已知档
    expect(entries.map((entry) => entry.value)).toEqual(['m-mixed']);
    expect(entries[0].efforts).toEqual(['low', 'medium']);
  });

  test('captures per-model default effort and uses it as clamp fallback', () => {
    const catalog = parseUpstreamModelCatalog({
      models: [
        {
          slug: 'm-default-low',
          visibility: 'list',
          default_reasoning_level: 'low',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
        },
        {
          // 默认档不在 supported 列表里 → 视为无效，不落 defaultEffort
          slug: 'm-broken-default',
          visibility: 'list',
          default_reasoning_level: 'ultra',
          supported_reasoning_levels: [{ effort: 'low' }],
        },
      ],
    });
    expect(catalog[0].defaultEffort).toBe('low');
    expect(catalog[1].defaultEffort).toBeUndefined();
    // 支持的档位透传
    expect(clampCodexEffortWithCatalog(catalog, 'm-default-low', 'high')).toBe(
      'high',
    );
    // 不支持的档位归位该模型自己的默认档（而非全局 medium）
    expect(clampCodexEffortWithCatalog(catalog, 'm-default-low', 'ultra')).toBe(
      'low',
    );
    // 无有效默认档时归位第一个档位
    expect(
      clampCodexEffortWithCatalog(catalog, 'm-broken-default', 'ultra'),
    ).toBe('low');
  });

  test('dedupes duplicate slugs (first wins) and derives slug-only labels', () => {
    const entries = parseUpstreamModelCatalog({
      models: [
        {
          slug: 'dup',
          visibility: 'list',
          supported_reasoning_levels: [{ effort: 'low' }],
        },
        {
          slug: 'dup',
          visibility: 'list',
          supported_reasoning_levels: [{ effort: 'medium' }],
        },
        {
          slug: 'bare-slug',
          visibility: 'list',
          supported_reasoning_levels: [{ effort: 'low' }],
        },
      ],
    });
    expect(entries.map((entry) => entry.value)).toEqual(['dup', 'bare-slug']);
    expect(entries[0].efforts).toEqual(['low']);
    expect(entries[1].label).toBe('bare-slug');
  });

  test('rejects oversized upstream body and keeps current catalog', async () => {
    const before = getResolvedCodexCatalog();
    const fetchImpl = vi.fn(
      async () =>
        new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200 }),
    ) as unknown as typeof fetch;
    const ok = await refreshCodexCatalog({ fetchImpl });
    expect(ok).toBe(false);
    expect(getResolvedCodexCatalog()).toBe(before);
  });

  test('rejects when content-length header exceeds the cap', async () => {
    const before = getResolvedCodexCatalog();
    const fetchImpl = vi.fn(
      async () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-length': String(10 * 1024 * 1024) },
        }),
    ) as unknown as typeof fetch;
    const ok = await refreshCodexCatalog({ fetchImpl });
    expect(ok).toBe(false);
    expect(getResolvedCodexCatalog()).toBe(before);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('rejects catalogs with more than the entry cap', () => {
    const models = Array.from({ length: 201 }, (_, i) => ({
      slug: `m-${i}`,
      visibility: 'list',
      supported_reasoning_levels: [{ effort: 'low' }],
    }));
    expect(() => parseUpstreamModelCatalog({ models })).toThrow();
  });

  test('disk cache round-trips through a temp file', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-'));
    const cachePath = path.join(dir, 'catalog.json');
    try {
      setCodexCatalogDiskCachePathForTests(cachePath);
      const ok = await refreshCodexCatalog({
        fetchImpl: mockFetchWith(UPSTREAM_PAYLOAD),
      });
      expect(ok).toBe(true);
      // 内存态回 builtin（路径覆写也被 reset 清掉），再从磁盘恢复
      resetCodexCatalogSyncForTests();
      setCodexCatalogDiskCachePathForTests(cachePath);
      initCodexCatalogSync({ fetchImpl: neverSettleFetch });
      const resolved = getResolvedCodexCatalog();
      expect(resolved.source).toBe('disk-cache');
      expect(resolved.models.map((entry) => entry.value)).toContain(
        'gpt-9-aurora',
      );
      expect(resolved.fetchedAt).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ignores disk cache entries with invalid labels', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-'));
    const cachePath = path.join(dir, 'catalog.json');
    try {
      writeFileSync(
        cachePath,
        JSON.stringify({
          models: [{ value: 'x', label: 42, efforts: ['low'] }],
        }),
      );
      setCodexCatalogDiskCachePathForTests(cachePath);
      initCodexCatalogSync({ fetchImpl: neverSettleFetch });
      expect(getResolvedCodexCatalog().source).toBe('builtin');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('failed refresh retries after 5-minute backoff instead of 6h', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async () => new Response('nope', { status: 429 }),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const ok = await refreshCodexCatalog();
    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 刚失败：5 分钟内路由触发也不重试
    maybeRefreshCodexCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4 * 60 * 1000);
    maybeRefreshCodexCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 失败退避是 5 分钟，到点即重试
    vi.advanceTimersByTime(1 * 60 * 1000);
    maybeRefreshCodexCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('successful refresh keeps the full 6h TTL', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(UPSTREAM_PAYLOAD), { status: 200 }),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const ok = await refreshCodexCatalog();
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 成功后连失败退避窗口（5min）过去也不重试，必须满 6h TTL
    vi.advanceTimersByTime(5 * 60 * 1000);
    maybeRefreshCodexCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5 * 60 * 60 * 1000); // 累计 5h05m < 6h
    maybeRefreshCodexCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1 * 60 * 60 * 1000); // 累计 6h05m > 6h
    maybeRefreshCodexCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('parses official request-shape fields and drops models newer than the client', () => {
    const entries = parseUpstreamModelCatalog({
      models: [
        {
          slug: 'late',
          visibility: 'list',
          priority: 9,
          supported_reasoning_levels: [{ effort: 'low' }],
        },
        {
          slug: 'shaped',
          visibility: 'list',
          priority: 1,
          use_responses_lite: true,
          support_verbosity: true,
          default_verbosity: 'medium',
          context_window: 272000,
          minimal_client_version: [0, 153, 0],
          available_in_plans: ['Plus', 'pro', 'bad plan', 42],
          service_tiers: [{ id: 'priority', name: 'Fast' }, { name: 'x' }],
          web_search_tool_type: 'text_and_image',
          supported_reasoning_levels: [{ effort: 'low' }],
        },
        {
          slug: 'too-new',
          visibility: 'list',
          priority: 0,
          minimal_client_version: '0.999.0',
          supported_reasoning_levels: [{ effort: 'low' }],
        },
      ],
    });
    expect(entries.map((entry) => entry.value)).toEqual(['shaped', 'late']);
    expect(entries[0]).toEqual({
      value: 'shaped',
      label: 'shaped',
      efforts: ['low'],
      useResponsesLite: true,
      supportsVerbosity: true,
      defaultVerbosity: 'medium',
      contextWindow: 272000,
      minimalClientVersion: '0.153.0',
      availableInPlans: ['plus', 'pro'],
      serviceTiers: ['priority'],
      webSearchToolType: 'text_and_image',
    });
    // Missing fields take the official ModelInfo serde defaults.
    expect(entries[1]).toMatchObject({
      useResponsesLite: false,
      supportsVerbosity: false,
      defaultVerbosity: null,
      serviceTiers: [],
      webSearchToolType: 'text',
    });
  });

  test('refresh makes the synced catalog drive request traits', async () => {
    expect(getCodexModelTraits('gpt-9-aurora').known).toBe(false);
    await refreshCodexCatalog({ fetchImpl: mockFetchWith(UPSTREAM_PAYLOAD) });
    expect(getCodexModelTraits('gpt-9-aurora')).toMatchObject({
      known: true,
      useResponsesLite: false,
    });
    resetCodexCatalogSyncForTests();
    expect(getCodexModelTraits('gpt-9-aurora').known).toBe(false);
  });

  test('ignores disk caches written before the request-shape fields', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-'));
    const cachePath = path.join(dir, 'catalog.json');
    try {
      writeFileSync(
        cachePath,
        JSON.stringify({
          models: [{ value: 'gpt-6-sol', label: 'sol', efforts: ['low'] }],
          fetchedAt: '2026-01-01T00:00:00.000Z',
        }),
      );
      setCodexCatalogDiskCachePathForTests(cachePath);
      initCodexCatalogSync({ fetchImpl: neverSettleFetch });
      expect(getResolvedCodexCatalog().source).toBe('builtin');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('per-provider live Codex model catalog', () => {
  const LIVE_PAYLOAD = {
    models: [
      {
        slug: 'gpt-6.1-sol',
        visibility: 'list',
        priority: 1,
        use_responses_lite: true,
        support_verbosity: true,
        default_verbosity: 'low',
        service_tiers: [{ id: 'priority' }],
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
      },
    ],
  };
  const liveFetch = (etag = '"v1"') =>
    vi.fn(
      async () =>
        new Response(JSON.stringify(LIVE_PAYLOAD), {
          status: 200,
          headers: { etag },
        }),
    );

  afterEach(() => {
    resetCodexCatalogSyncForTests();
    setCodexCatalogDiskCachePathForTests(null);
    resolveCodexAccess.mockReset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('fetches the account catalog with the official client identity', async () => {
    resolveCodexAccess.mockResolvedValue({
      providerId: 'p1',
      accessToken: 'access-token',
      accountId: 'acct-1',
    });
    const fetchImpl = liveFetch();
    expect(await refreshCodexProviderCatalog('p1', { fetchImpl })).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'https://chatgpt.com/backend-api/codex/models?client_version=0.162.1',
    );
    const headers = init.headers as Record<string, string>;
    expect(headers).toMatchObject({
      Authorization: 'Bearer access-token',
      'ChatGPT-Account-ID': 'acct-1',
      originator: 'codex-tui',
      version: '0.162.1',
    });
    expect(headers['User-Agent']).toMatch(/^codex-tui\/0\.162\.1 /);
    expect(headers).not.toHaveProperty('If-None-Match');
    const live = resolveCodexCatalogForProvider('p1');
    expect(live.source).toBe('live');
    expect(live.models.map((entry) => entry.value)).toEqual(['gpt-6.1-sol']);
    expect(getCodexCatalogForProvider('p1', 'acct-1')).toBe(live.models);
    // Another account (re-login) never sees the old account's catalog.
    expect(getCodexCatalogForProvider('p1', 'acct-2')).toBe(
      getResolvedCodexCatalog().models,
    );
    expect(getCodexCatalogForProvider('p2')).toBe(
      getResolvedCodexCatalog().models,
    );
  });

  test('refreshes after an hour, backs off after failures and keeps the last catalog', async () => {
    vi.useFakeTimers();
    resolveCodexAccess.mockResolvedValue({
      providerId: 'p1',
      accessToken: 'token',
      accountId: null,
    });
    const fetchMock = liveFetch();
    vi.stubGlobal('fetch', fetchMock);
    maybeRefreshCodexProviderCatalog('p1');
    await vi.waitFor(() =>
      expect(resolveCodexCatalogForProvider('p1').source).toBe('live'),
    );
    maybeRefreshCodexProviderCatalog('p1');
    vi.advanceTimersByTime(59 * 60 * 1000);
    maybeRefreshCodexProviderCatalog('p1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementation(
      async () => new Response('busy', { status: 503 }),
    );
    vi.advanceTimersByTime(60 * 1000);
    maybeRefreshCodexProviderCatalog('p1');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(resolveCodexCatalogForProvider('p1').source).toBe('live');
    // A different account forces a refresh, still subject to the backoff.
    maybeRefreshCodexProviderCatalog('p1', { accountId: 'other' });
    vi.advanceTimersByTime(4 * 60 * 1000);
    maybeRefreshCodexProviderCatalog('p1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60 * 1000);
    maybeRefreshCodexProviderCatalog('p1');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  test('refreshes when x-models-etag changes and only then', async () => {
    resolveCodexAccess.mockResolvedValue({
      providerId: 'p1',
      accessToken: 'token',
      accountId: null,
    });
    const fetchMock = liveFetch('"v1"');
    vi.stubGlobal('fetch', fetchMock);
    await refreshCodexProviderCatalog('p1');
    noteCodexModelsEtag('p1', '"v1"');
    noteCodexModelsEtag('p1', '"v1"');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    noteCodexModelsEtag('p1', '"v2"');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // The models endpoint still reports v1: the same notice does not loop.
    noteCodexModelsEtag('p1', '"v2"');
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('waits for the first account fetch only when nothing is cached', async () => {
    resolveCodexAccess.mockRejectedValueOnce(new Error('login expired'));
    const failed = await ensureCodexProviderCatalog('p1', {
      fetchImpl: liveFetch(),
    });
    expect(failed.source).toBe('builtin');
    resolveCodexAccess.mockResolvedValue({
      providerId: 'p1',
      accessToken: 'token',
      accountId: null,
    });
    const fetchImpl = liveFetch();
    // Backoff after the failure: no fetch yet.
    expect((await ensureCodexProviderCatalog('p1', { fetchImpl })).source).toBe(
      'builtin',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    resetCodexCatalogSyncForTests();
    const first = await ensureCodexProviderCatalog('p1', { fetchImpl });
    expect(first.source).toBe('live');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
