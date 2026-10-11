import { afterEach, describe, expect, test } from 'vitest';

import { CODEX_CLIENT_VERSION } from '../src/codex-gateway/client-identity.js';
import {
  clampCodexEffort,
  CODEX_DEFAULT_EFFORT,
  CODEX_DEFAULT_MODEL,
  CODEX_MODEL_CATALOG,
  compareCodexClientVersions,
  filterCodexCatalogByPlan,
  getCodexModelTraits,
  isCodexModelSupportedByClient,
  resolveCodexCatalogEntry,
  setActiveCodexCatalog,
} from '../src/codex-gateway/model-catalog.js';

describe('Codex model catalog', () => {
  test('default model/effort exist in the catalog', () => {
    const entry = resolveCodexCatalogEntry(CODEX_DEFAULT_MODEL);
    expect(entry).toBeDefined();
    expect(entry?.efforts).toContain(CODEX_DEFAULT_EFFORT);
  });

  test('catalog values are unique and efforts non-empty', () => {
    const values = CODEX_MODEL_CATALOG.map((entry) => entry.value);
    expect(new Set(values).size).toBe(values.length);
    for (const entry of CODEX_MODEL_CATALOG) {
      expect(entry.efforts.length).toBeGreaterThan(0);
      expect(entry.label).toContain(entry.value);
    }
  });

  test('gpt-6 family is the primary catalog with legacy gpt-5.5 kept', () => {
    const values = CODEX_MODEL_CATALOG.map((entry) => entry.value);
    expect(values).toEqual(
      expect.arrayContaining([
        'gpt-6-sol',
        'gpt-6-astra',
        'gpt-6-luna',
        'gpt-5.5',
      ]),
    );
  });

  test('clampCodexEffort resets unsupported efforts to the catalog default', () => {
    // gpt-6-luna 没有 ultra 档
    expect(clampCodexEffort('gpt-6-luna', 'ultra')).toBe(CODEX_DEFAULT_EFFORT);
    // gpt-5.5 没有 max/ultra
    expect(clampCodexEffort('gpt-5.5', 'max')).toBe(CODEX_DEFAULT_EFFORT);
    // 支持的档位透传
    expect(clampCodexEffort('gpt-6-sol', 'xhigh')).toBe('xhigh');
    // 未配置时原样返回（undefined 语义由 normalizeCodexEffort 兜底）
    expect(clampCodexEffort('gpt-6-sol', undefined)).toBeUndefined();
  });

  test('clampCodexEffort passes through models outside the catalog', () => {
    // 上游新模型尚未收录时不应被本地目录误伤
    expect(clampCodexEffort('gpt-7-future', 'ultra')).toBe('ultra');
  });

  test('baked-in catalog mirrors the official models.json picker order and shape', () => {
    expect(CODEX_MODEL_CATALOG.map((entry) => entry.value)).toEqual([
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
    ]);
    for (const entry of CODEX_MODEL_CATALOG) {
      expect(entry.useResponsesLite).toBe(entry.value !== 'gpt-5.5');
      expect(entry).toMatchObject({
        supportsVerbosity: true,
        defaultVerbosity: 'low',
        contextWindow: 272_000,
        serviceTiers: ['priority'],
      });
      expect(isCodexModelSupportedByClient(entry)).toBe(true);
    }
    expect(resolveCodexCatalogEntry('gpt-6.1-sol')?.availableInPlans).toContain(
      'law',
    );
    expect(
      resolveCodexCatalogEntry('gpt-6-sol')?.availableInPlans,
    ).not.toContain('promax');
  });
});

describe('Codex model traits', () => {
  afterEach(() => setActiveCodexCatalog(CODEX_MODEL_CATALOG));

  test('derive the request shape from the catalog, classic for unknown models', () => {
    expect(getCodexModelTraits('gpt-6-sol')).toEqual({
      useResponsesLite: true,
      defaultVerbosity: 'low',
      serviceTiers: ['priority'],
      webSearchContentTypes: ['text', 'image'],
      known: true,
    });
    expect(getCodexModelTraits('gpt-5.5').useResponsesLite).toBe(false);
    expect(getCodexModelTraits('gpt-9-future')).toEqual({
      useResponsesLite: false,
      defaultVerbosity: null,
      serviceTiers: [],
      webSearchContentTypes: null,
      known: false,
    });
  });

  test('prefer an explicit catalog, then the active catalog, then the baked-in one', () => {
    const shaped = {
      value: 'gpt-6-sol',
      label: 'sol',
      efforts: ['low'],
      useResponsesLite: false,
      supportsVerbosity: false,
      defaultVerbosity: 'high' as const,
      serviceTiers: [],
    };
    expect(getCodexModelTraits('gpt-6-sol', [shaped])).toMatchObject({
      useResponsesLite: false,
      defaultVerbosity: null,
      serviceTiers: [],
    });
    // Entries without shape data (old disk caches, tests) fall through.
    expect(
      getCodexModelTraits('gpt-6-sol', [
        { value: 'gpt-6-sol', label: 'sol', efforts: ['low'] },
      ]).useResponsesLite,
    ).toBe(true);
    setActiveCodexCatalog([{ ...shaped, value: 'gpt-9-future' }]);
    expect(getCodexModelTraits('gpt-9-future').known).toBe(true);
  });

  test('compare client versions numerically', () => {
    expect(
      compareCodexClientVersions('0.153.0', CODEX_CLIENT_VERSION),
    ).toBeLessThan(0);
    expect(compareCodexClientVersions('0.162.10', '0.162.9')).toBeGreaterThan(
      0,
    );
    expect(compareCodexClientVersions('1', '1.0.0')).toBe(0);
    expect(
      isCodexModelSupportedByClient({ minimalClientVersion: '0.170.0' }),
    ).toBe(false);
    expect(isCodexModelSupportedByClient({})).toBe(true);
  });
});

describe('ChatGPT plan filtering', () => {
  const values = (plan: string | null) =>
    filterCodexCatalogByPlan(CODEX_MODEL_CATALOG, plan).map(
      (entry) => entry.value,
    );

  test('hides models a plan cannot use', () => {
    expect(values('promax')).not.toContain('gpt-6-sol');
    expect(values('promax')).not.toContain('gpt-6-luna');
    expect(values('promax')).toContain('gpt-6.1-sol');
    expect(values('PLUS')).toHaveLength(CODEX_MODEL_CATALOG.length);
    expect(values('law')).toEqual(['gpt-6.1-sol']);
  });

  test('applies the official plan aliases and never filters unknown plans', () => {
    const catalog = [
      {
        value: 'ent',
        label: 'ent',
        efforts: ['low'],
        availableInPlans: ['hc'],
      },
      {
        value: 'edu',
        label: 'edu',
        efforts: ['low'],
        availableInPlans: ['education'],
      },
      { value: 'open', label: 'open', efforts: ['low'] },
    ];
    const names = (plan: string | null) =>
      filterCodexCatalogByPlan(catalog, plan).map((entry) => entry.value);
    expect(names('enterprise')).toEqual(['ent', 'open']);
    expect(names('edu')).toEqual(['edu', 'open']);
    expect(names('brand-new-plan')).toEqual(['ent', 'edu', 'open']);
    expect(names(null)).toEqual(['ent', 'edu', 'open']);
  });
});
