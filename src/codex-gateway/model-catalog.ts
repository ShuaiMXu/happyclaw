/**
 * Codex 模型目录 — baked-in 离线兜底。
 *
 * 目录对齐 codex CLI 随版本捆绑的 models.json（上游移除模型后请求会直接
 * 400，例如 gpt-5.1 系列）。UI 下拉、请求侧 effort 钳制、请求形态（Responses
 * Lite、verbosity、service tier）、legacy 归一都以这里为准；前端通过
 * GET /api/config/codex/model-catalog 获取。
 *
 * 实时目录由 model-catalog-sync.ts 从上游 openai/codex 仓库与各账号的
 * /backend-api/codex/models 同步（本文件是拉取失败/首次启动时的兜底）；
 * 目录随上游更新通常无需改这个文件。
 */

import { CODEX_CLIENT_VERSION } from './client-identity.js';

export type CodexVerbosity = 'low' | 'medium' | 'high';

export interface CodexModelCatalogEntry {
  /** 上游 Responses API 接受的模型 slug。 */
  value: string;
  /** UI 展示文案。 */
  label: string;
  /** 该模型支持的 reasoning.effort 档位（不支持的档位上游 400）。 */
  efforts: readonly string[];
  /** 上游 default_reasoning_level；缺失时钳制兜底用 CODEX_DEFAULT_EFFORT。 */
  defaultEffort?: string;
  // 以下字段来自 models.json；旧磁盘缓存或测试构造的条目可能缺失，
  // 缺失时请求形态回落到下一级目录（见 getCodexModelTraits）。
  /** use_responses_lite：官方客户端对该模型发送 Responses Lite 形态。 */
  useResponsesLite?: boolean;
  /** support_verbosity：是否接受 text.verbosity。 */
  supportsVerbosity?: boolean;
  /** default_verbosity：官方客户端默认发送的 text.verbosity。 */
  defaultVerbosity?: CodexVerbosity | null;
  /** context_window（token）。 */
  contextWindow?: number;
  /** minimal_client_version：低于此版本的客户端不能使用该模型。 */
  minimalClientVersion?: string;
  /** available_in_plans：可用的 ChatGPT 套餐（JWT chatgpt_plan_type 原值）。 */
  availableInPlans?: readonly string[];
  /** service_tiers[].id：该模型接受的 service_tier（如 priority）。 */
  serviceTiers?: readonly string[];
  /** web_search_tool_type：text_and_image 时搜索同时返回图片结果。 */
  webSearchToolType?: 'text' | 'text_and_image';
}

export const CODEX_FULL_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;
export const CODEX_CAPPED_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export const CODEX_LEGACY_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;

/** 全部已知 effort 档位（不含已被上游移除的 minimal）。同步层用它过滤上游值。 */
export const CODEX_KNOWN_EFFORTS: readonly string[] = [
  ...new Set<string>([
    ...CODEX_FULL_EFFORTS,
    ...CODEX_CAPPED_EFFORTS,
    ...CODEX_LEGACY_EFFORTS,
  ]),
];

/** models.json 中多数现役模型共用的 available_in_plans。 */
const CODEX_STANDARD_PLANS = [
  'business',
  'edu',
  'edu_plus',
  'edu_pro',
  'education',
  'ent26',
  'enterprise',
  'enterprise_cbp_automation',
  'enterprise_cbp_trial',
  'enterprise_cbp_usage_based',
  'finserv',
  'free',
  'free_workspace',
  'go',
  'hc',
  'k12',
  'plus',
  'pro',
  'prolite',
  'promax',
  'quorum',
  'sci',
  'self_serve_business_prolite',
  'self_serve_business_usage_based',
  'team',
] as const;

/** 现役模型共同的请求形态（models.json：lite、low verbosity、272K、Fast 档）。 */
const CURRENT_MODEL_TRAITS = {
  useResponsesLite: true,
  supportsVerbosity: true,
  defaultVerbosity: 'low',
  contextWindow: 272_000,
  serviceTiers: ['priority'],
  webSearchToolType: 'text_and_image',
} as const;

// 顺序同官方选择器（models.json priority 升序）。
export const CODEX_MODEL_CATALOG: readonly CodexModelCatalogEntry[] = [
  {
    value: 'gpt-6.1-sol',
    label: 'gpt-6.1-sol（主力编码）',
    efforts: CODEX_FULL_EFFORTS,
    defaultEffort: 'low',
    ...CURRENT_MODEL_TRAITS,
    minimalClientVersion: '0.153.0',
    availableInPlans: [...CODEX_STANDARD_PLANS, 'law'].sort(),
  },
  {
    value: 'gpt-6-astra',
    label: 'gpt-6-astra（旗舰·最强推理）',
    efforts: CODEX_FULL_EFFORTS,
    defaultEffort: 'low',
    ...CURRENT_MODEL_TRAITS,
    minimalClientVersion: '0.153.0',
    availableInPlans: CODEX_STANDARD_PLANS,
  },
  {
    value: 'gpt-6-sol',
    label: 'gpt-6-sol（上一代编码）',
    efforts: CODEX_FULL_EFFORTS,
    defaultEffort: 'medium',
    ...CURRENT_MODEL_TRAITS,
    minimalClientVersion: '0.155.0',
    availableInPlans: CODEX_STANDARD_PLANS.filter((plan) => plan !== 'promax'),
  },
  {
    value: 'gpt-6-luna',
    label: 'gpt-6-luna（快速轻量）',
    efforts: CODEX_CAPPED_EFFORTS,
    defaultEffort: 'medium',
    ...CURRENT_MODEL_TRAITS,
    minimalClientVersion: '0.155.0',
    availableInPlans: CODEX_STANDARD_PLANS.filter((plan) => plan !== 'promax'),
  },
  {
    value: 'gpt-5.6-sol',
    label: 'gpt-5.6-sol（旧款编码）',
    efforts: CODEX_FULL_EFFORTS,
    defaultEffort: 'low',
    ...CURRENT_MODEL_TRAITS,
    minimalClientVersion: '0.144.0',
    availableInPlans: CODEX_STANDARD_PLANS,
  },
  {
    value: 'gpt-5.6-terra',
    label: 'gpt-5.6-terra（旧款均衡）',
    efforts: CODEX_FULL_EFFORTS,
    defaultEffort: 'medium',
    ...CURRENT_MODEL_TRAITS,
    minimalClientVersion: '0.144.0',
    availableInPlans: CODEX_STANDARD_PLANS,
  },
  {
    value: 'gpt-5.6-luna',
    label: 'gpt-5.6-luna（旧款快速）',
    efforts: CODEX_CAPPED_EFFORTS,
    defaultEffort: 'medium',
    ...CURRENT_MODEL_TRAITS,
    minimalClientVersion: '0.144.0',
    availableInPlans: CODEX_STANDARD_PLANS,
  },
  {
    value: 'gpt-5.5',
    label: 'gpt-5.5（遗留）',
    efforts: CODEX_LEGACY_EFFORTS,
    defaultEffort: 'medium',
    ...CURRENT_MODEL_TRAITS,
    useResponsesLite: false,
    minimalClientVersion: '0.124.0',
    availableInPlans: CODEX_STANDARD_PLANS,
  },
];

/** Official picker default: the highest-priority listed model. */
export const CODEX_DEFAULT_MODEL = 'gpt-6.1-sol';
export const CODEX_DEFAULT_EFFORT = 'medium';

export function resolveCodexCatalogEntry(
  model: string,
): CodexModelCatalogEntry | undefined {
  return CODEX_MODEL_CATALOG.find((entry) => entry.value === model);
}

/**
 * 模型的钳制兜底档：优先上游 per-model default（且必须在该模型支持的档位里），
 * 其次该模型第一个档位，最后全局默认。避免"不支持 → 兜底档也不支持"仍然 400。
 */
function resolveEntryFallbackEffort(entry: CodexModelCatalogEntry): string {
  if (entry.defaultEffort && entry.efforts.includes(entry.defaultEffort)) {
    return entry.defaultEffort;
  }
  return entry.efforts[0] ?? CODEX_DEFAULT_EFFORT;
}

/**
 * 请求侧 effort 钳制（纵深防御，与前端"切模型归位默认档"语义一致）：
 * 模型在目录中且配置的 effort 不受支持时，回落到该模型的默认档。
 * 目录外模型（上游新模型尚未收录）不做钳制，保持透传。
 * catalog 参数供上游同步层传入解析后的实时目录；缺省用 baked-in 目录。
 */
export function clampCodexEffortWithCatalog(
  catalog: readonly CodexModelCatalogEntry[],
  model: string,
  effort: string | undefined,
): string | undefined {
  if (!effort) return effort;
  const entry = catalog.find((candidate) => candidate.value === model);
  if (!entry) return effort;
  return entry.efforts.includes(effort)
    ? effort
    : resolveEntryFallbackEffort(entry);
}

export function clampCodexEffort(
  model: string,
  effort: string | undefined,
): string | undefined {
  return clampCodexEffortWithCatalog(CODEX_MODEL_CATALOG, model, effort);
}

/** 档位从低到高的固定顺序，用于在模型支持的档位里找最低档。 */
const EFFORT_RANK = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

/**
 * 模型支持的最低档。thinking 被显式关闭时用它代替上游不接受的 `none`；
 * 目录外模型无法确认支持集合，用所有现役模型都支持的 low。
 */
export function lowestCodexEffortWithCatalog(
  catalog: readonly CodexModelCatalogEntry[],
  model: string,
): string {
  const entry = catalog.find((candidate) => candidate.value === model);
  if (!entry?.efforts.length) return 'low';
  return [...entry.efforts].sort((a, b) => {
    const rankA = EFFORT_RANK.indexOf(a);
    const rankB = EFFORT_RANK.indexOf(b);
    return (
      (rankA < 0 ? EFFORT_RANK.length : rankA) -
      (rankB < 0 ? EFFORT_RANK.length : rankB)
    );
  })[0];
}

/**
 * Provider 级默认推理档：显式配置的 CODEX_REASONING_EFFORT（minimal 归一为 low）
 * 按目录钳制；未配置时取模型的目录默认档。设置页展示与网关请求共用这一份结果。
 */
export function resolveCodexDefaultEffort(
  catalog: readonly CodexModelCatalogEntry[],
  model: string,
  configured?: string,
): string {
  const normalized = configured?.trim().toLowerCase();
  if (normalized) {
    return clampCodexEffortWithCatalog(
      catalog,
      model,
      normalized === 'minimal' ? 'low' : normalized,
    )!;
  }
  const entry = catalog.find((candidate) => candidate.value === model);
  return entry ? resolveEntryFallbackEffort(entry) : CODEX_DEFAULT_EFFORT;
}

/**
 * Request-shape traits of one upstream model, taken from the official
 * models.json (`use_responses_lite`, `default_verbosity`, ...). Unknown
 * models get the conservative classic Responses shape.
 */
export interface CodexModelTraits {
  /** Official clients send the Responses Lite shape for this model. */
  useResponsesLite: boolean;
  /** `text.verbosity` the official client sends; null = omit. */
  defaultVerbosity: CodexVerbosity | null;
  /** `service_tier` values the model accepts; others are never sent. */
  serviceTiers: readonly string[];
  /** Hosted web_search `search_content_types`; null = omit (text only). */
  webSearchContentTypes: readonly string[] | null;
  /** Whether any catalog describes the model's request shape. */
  known: boolean;
}

/**
 * Catalog the gateway currently runs on (synced upstream catalog, else the
 * baked-in one). model-catalog-sync.ts replaces it; kept here so the pure
 * request converter never imports the sync layer.
 */
let activeCodexCatalog: readonly CodexModelCatalogEntry[] = CODEX_MODEL_CATALOG;

export function setActiveCodexCatalog(
  catalog: readonly CodexModelCatalogEntry[],
): void {
  activeCodexCatalog = catalog;
}

/**
 * The first entry for `model` that carries request-shape data, searching an
 * explicit (e.g. per-account live) catalog, then the active catalog, then the
 * baked-in one. Entries without shape data come from old disk caches or tests.
 */
function findShapedEntry(
  model: string,
  catalog?: readonly CodexModelCatalogEntry[],
): CodexModelCatalogEntry | undefined {
  for (const candidates of [catalog, activeCodexCatalog, CODEX_MODEL_CATALOG]) {
    const entry = candidates?.find(
      (candidate) =>
        candidate.value === model && candidate.useResponsesLite !== undefined,
    );
    if (entry) return entry;
  }
  return undefined;
}

export function getCodexModelTraits(
  model: string,
  catalog?: readonly CodexModelCatalogEntry[],
): CodexModelTraits {
  const entry = findShapedEntry(model, catalog);
  if (!entry)
    return {
      useResponsesLite: false,
      defaultVerbosity: null,
      serviceTiers: [],
      webSearchContentTypes: null,
      known: false,
    };
  return {
    useResponsesLite: entry.useResponsesLite === true,
    defaultVerbosity: entry.supportsVerbosity
      ? (entry.defaultVerbosity ?? null)
      : null,
    serviceTiers: entry.serviceTiers ?? [],
    // hosted_spec.rs: TextAndImage → ["text", "image"].
    webSearchContentTypes:
      entry.webSearchToolType === 'text_and_image' ? ['text', 'image'] : null,
    known: true,
  };
}

/** Compare dotted numeric versions (`0.153.0`); missing parts count as 0. */
export function compareCodexClientVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Whether the client version this gateway presents may use the model. */
export function isCodexModelSupportedByClient(
  entry: Pick<CodexModelCatalogEntry, 'minimalClientVersion'>,
  clientVersion: string = CODEX_CLIENT_VERSION,
): boolean {
  return (
    !entry.minimalClientVersion ||
    compareCodexClientVersions(entry.minimalClientVersion, clientVersion) <= 0
  );
}

/**
 * ChatGPT plan claim → names that may appear in `available_in_plans`.
 * Official PlanType::from_raw_value lowercases the claim and treats `hc` as
 * enterprise and `education` as edu; the catalog lists both spellings.
 */
const PLAN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  hc: ['hc', 'enterprise'],
  enterprise: ['enterprise', 'hc'],
  education: ['education', 'edu'],
  edu: ['edu', 'education'],
};

/**
 * Catalog entries the given ChatGPT plan may use. A missing plan, a plan no
 * entry lists, or an entry without plan data is never filtered: the backend
 * stays the final authority and the UI must not hide a model it cannot judge.
 */
export function filterCodexCatalogByPlan(
  catalog: readonly CodexModelCatalogEntry[],
  planType: string | null | undefined,
): CodexModelCatalogEntry[] {
  const plan = planType?.trim().toLowerCase();
  if (!plan) return [...catalog];
  const names = PLAN_ALIASES[plan] ?? [plan];
  const listsPlan = (entry: CodexModelCatalogEntry): boolean =>
    !!entry.availableInPlans?.some((candidate) => names.includes(candidate));
  if (!catalog.some(listsPlan)) return [...catalog];
  return catalog.filter(
    (entry) => !entry.availableInPlans?.length || listsPlan(entry),
  );
}
