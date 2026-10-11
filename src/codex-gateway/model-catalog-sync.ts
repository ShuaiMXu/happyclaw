// ─── Codex 模型目录 — 上游同步层 ────────────────────────────────────
//
// model-catalog.ts 是离线兜底（baked-in）；本模块让目录"根据上游内容更新"：
// 定期 + 访问时拉取 openai/codex 仓库的 codex-rs/models-manager/models.json
// （codex CLI 自身捆绑的同一份目录），解析出在售模型、受支持的 reasoning
// effort 档位与请求形态字段。任何失败（网络、结构、校验）都保留当前目录，
// 绝不返回空目录。
//
// 缓存三级：内存（进程内即时生效）→ 磁盘（重启后免等待）→ baked-in 兜底。
//
// 另有按 provider（账号）的实时目录：与官方客户端一样请求
// GET /backend-api/codex/models?client_version=<版本>，后端按账号套餐与客户端
// 版本返回可用模型。实时目录只在内存缓存（1h），请求路径从不等待它。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  CODEX_CLIENT_VERSION,
  codexBackendClientHeaders,
} from './client-identity.js';
import {
  CODEX_KNOWN_EFFORTS,
  CODEX_MODEL_CATALOG,
  isCodexModelSupportedByClient,
  setActiveCodexCatalog,
  type CodexModelCatalogEntry,
  type CodexVerbosity,
} from './model-catalog.js';

const UPSTREAM_MODELS_URL =
  'https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json';

const UPSTREAM_FETCH_TIMEOUT_MS = 10_000;
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 拉取失败后的重试间隔：瞬时故障（断网/超时）不应换来整整 6 小时沉默。 */
const REFRESH_FAILURE_BACKOFF_MS = 5 * 60 * 1000;
/** 上游响应体硬上限：真实 models.json 远小于此，超限视为投毒/异常，拒绝解析。 */
const MAX_UPSTREAM_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_ENTRIES = 200;
const MAX_SLUG_LENGTH = 128;
const MAX_LABEL_LENGTH = 128;
const KNOWN_EFFORT_SET = new Set<string>(CODEX_KNOWN_EFFORTS);
const KNOWN_VERBOSITIES = new Set<string>(['low', 'medium', 'high']);
const MAX_PLAN_ENTRIES = 100;
const MAX_TOKEN_LENGTH = 64;
/** 磁盘缓存结构版本：缺少请求形态字段的旧缓存直接作废，回落 baked-in。 */
const DISK_CACHE_VERSION = 2;

/** 官方客户端拉取账号模型目录的端点（codex-rs/model-provider models_endpoint）。 */
const CODEX_BACKEND_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';
/** 官方 MODELS_REFRESH_TIMEOUT。 */
const LIVE_FETCH_TIMEOUT_MS = 5_000;
const LIVE_CATALOG_TTL_MS = 60 * 60 * 1000;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type CodexCatalogSource = 'builtin' | 'disk-cache' | 'upstream';

export interface ResolvedCodexCatalog {
  models: readonly CodexModelCatalogEntry[];
  source: CodexCatalogSource;
  fetchedAt: string | null;
}

interface UpstreamModelEntry {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  visibility?: unknown;
  priority?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
  use_responses_lite?: unknown;
  support_verbosity?: unknown;
  default_verbosity?: unknown;
  context_window?: unknown;
  minimal_client_version?: unknown;
  available_in_plans?: unknown;
  service_tiers?: unknown;
  web_search_tool_type?: unknown;
}

/** 带硬上限地读响应体：先查 Content-Length，再流式累计，超限立即中断。 */
async function readBodyWithCap(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') ?? '');
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_UPSTREAM_BODY_BYTES
  ) {
    throw new Error(
      `Upstream catalog body too large: ${contentLength} bytes (cap ${MAX_UPSTREAM_BODY_BYTES})`,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Upstream catalog response has no body');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_UPSTREAM_BODY_BYTES) {
      void reader.cancel().catch(() => {});
      throw new Error(
        `Upstream catalog body exceeds ${MAX_UPSTREAM_BODY_BYTES} byte cap`,
      );
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function resolveDiskCachePath(): string {
  return (
    diskCachePathOverride ??
    path.join(DATA_DIR, 'config', 'codex-model-catalog.json')
  );
}

let diskCachePathOverride: string | null | undefined;

const curatedLabels = new Map(
  CODEX_MODEL_CATALOG.map((entry) => [entry.value, entry.label]),
);

/** 上游 token 型字符串（套餐名、service tier id）：短、单行、可打印。 */
function upstreamToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed &&
    trimmed.length <= MAX_TOKEN_LENGTH &&
    /^[\x21-\x7e]+$/.test(trimmed)
    ? trimmed
    : undefined;
}

/** minimal_client_version 在 models.json 是 "0.153.0"，/models 端点可能是 [0, 153, 0]。 */
function upstreamClientVersion(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d+(?:\.\d+){0,3}$/.test(value.trim()))
    return value.trim();
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 4 &&
    value.every((part) => Number.isSafeInteger(part) && part >= 0)
  )
    return value.join('.');
  return undefined;
}

/** 请求形态字段（缺失时按官方 ModelInfo 的 serde 默认值）。 */
function upstreamShape(
  item: UpstreamModelEntry,
): Omit<
  CodexModelCatalogEntry,
  'value' | 'label' | 'efforts' | 'defaultEffort'
> {
  const contextWindow =
    Number.isSafeInteger(item.context_window) &&
    (item.context_window as number) > 0
      ? (item.context_window as number)
      : undefined;
  const minimalClientVersion = upstreamClientVersion(
    item.minimal_client_version,
  );
  const plans = Array.isArray(item.available_in_plans)
    ? [
        ...new Set(
          item.available_in_plans
            .slice(0, MAX_PLAN_ENTRIES)
            .map(upstreamToken)
            .filter((plan): plan is string => !!plan)
            .map((plan) => plan.toLowerCase()),
        ),
      ]
    : undefined;
  const serviceTiers = Array.isArray(item.service_tiers)
    ? [
        ...new Set(
          item.service_tiers
            .map((tier) =>
              tier && typeof tier === 'object'
                ? upstreamToken((tier as { id?: unknown }).id)
                : undefined,
            )
            .filter((tier): tier is string => !!tier),
        ),
      ]
    : [];
  return {
    useResponsesLite: item.use_responses_lite === true,
    supportsVerbosity: item.support_verbosity === true,
    defaultVerbosity:
      typeof item.default_verbosity === 'string' &&
      KNOWN_VERBOSITIES.has(item.default_verbosity)
        ? (item.default_verbosity as CodexVerbosity)
        : null,
    ...(contextWindow ? { contextWindow } : {}),
    ...(minimalClientVersion ? { minimalClientVersion } : {}),
    ...(plans ? { availableInPlans: plans } : {}),
    serviceTiers,
    webSearchToolType:
      item.web_search_tool_type === 'text_and_image'
        ? 'text_and_image'
        : 'text',
  };
}

/**
 * 上游 models.json（或账号 /models 响应，同一结构）→ 目录条目。只保留
 * visibility=list 的在售模型，并剔除 minimal_client_version 高于网关所扮演
 * 客户端版本的模型（后端会拒绝）；effort 档位先经已知档位白名单过滤再按
 * 上游顺序采用（上游数据不可信，未知档位会被请求侧透传导致 400）；已知
 * 模型保留人工中文标注，新模型用 display_name 自动生成标签。slug 去重
 * （首见优先），结果按上游 priority 升序（同官方选择器）。
 */
export function parseUpstreamModelCatalog(
  raw: unknown,
): CodexModelCatalogEntry[] {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Upstream model catalog payload is not an object');
  }
  const models = (raw as { models?: unknown }).models;
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('Upstream model catalog has no models array');
  }
  const entries: Array<{ entry: CodexModelCatalogEntry; priority: number }> =
    [];
  const seenSlugs = new Set<string>();
  for (const item of models as UpstreamModelEntry[]) {
    if (!item || typeof item !== 'object') continue;
    const slug = typeof item.slug === 'string' ? item.slug.trim() : '';
    if (!slug || item.visibility !== 'list' || seenSlugs.has(slug)) continue;
    if (slug.length > MAX_SLUG_LENGTH) continue;
    const efforts = Array.isArray(item.supported_reasoning_levels)
      ? item.supported_reasoning_levels
          .map((level) =>
            level && typeof level === 'object'
              ? (level as { effort?: unknown }).effort
              : undefined,
          )
          .filter(
            (effort): effort is string =>
              typeof effort === 'string' && KNOWN_EFFORT_SET.has(effort),
          )
      : [];
    if (efforts.length === 0) continue;
    const shape = upstreamShape(item);
    if (!isCodexModelSupportedByClient(shape)) continue;
    const upstreamDefault =
      typeof item.default_reasoning_level === 'string' &&
      efforts.includes(item.default_reasoning_level)
        ? item.default_reasoning_level
        : undefined;
    const curated = curatedLabels.get(slug);
    const displayName =
      typeof item.display_name === 'string' &&
      item.display_name.trim().length <= MAX_LABEL_LENGTH
        ? item.display_name.trim()
        : '';
    seenSlugs.add(slug);
    entries.push({
      entry: {
        value: slug,
        label: curated ?? (displayName ? `${slug}（${displayName}）` : slug),
        efforts,
        ...(upstreamDefault ? { defaultEffort: upstreamDefault } : {}),
        ...shape,
      },
      priority:
        typeof item.priority === 'number' && Number.isFinite(item.priority)
          ? item.priority
          : Number.POSITIVE_INFINITY,
    });
    if (entries.length > MAX_CATALOG_ENTRIES) {
      throw new Error(
        `Upstream model catalog exceeds ${MAX_CATALOG_ENTRIES} entries`,
      );
    }
  }
  if (entries.length === 0) {
    throw new Error('Upstream model catalog produced no usable entries');
  }
  return entries
    .sort((a, b) =>
      a.priority === b.priority ? 0 : a.priority < b.priority ? -1 : 1,
    )
    .map(({ entry }) => entry);
}

let resolved: ResolvedCodexCatalog = {
  models: CODEX_MODEL_CATALOG,
  source: 'builtin',
  fetchedAt: null,
};

let inflight: Promise<boolean> | null = null;
let lastRefreshAt = 0;
let lastRefreshFailed = false;

export function getResolvedCodexCatalog(): ResolvedCodexCatalog {
  return resolved;
}

function applyResolved(next: ResolvedCodexCatalog): void {
  resolved = next;
  setActiveCodexCatalog(next.models);
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

function isValidCatalogEntry(entry: unknown): entry is CodexModelCatalogEntry {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = entry as Partial<CodexModelCatalogEntry>;
  return (
    typeof candidate.value === 'string' &&
    candidate.value.length > 0 &&
    typeof candidate.label === 'string' &&
    isStringArray(candidate.efforts) &&
    candidate.efforts.length > 0 &&
    (candidate.defaultEffort === undefined ||
      (typeof candidate.defaultEffort === 'string' &&
        candidate.efforts.includes(candidate.defaultEffort))) &&
    typeof candidate.useResponsesLite === 'boolean' &&
    typeof candidate.supportsVerbosity === 'boolean' &&
    (candidate.defaultVerbosity === null ||
      (typeof candidate.defaultVerbosity === 'string' &&
        KNOWN_VERBOSITIES.has(candidate.defaultVerbosity))) &&
    (candidate.contextWindow === undefined ||
      Number.isSafeInteger(candidate.contextWindow)) &&
    (candidate.minimalClientVersion === undefined ||
      typeof candidate.minimalClientVersion === 'string') &&
    (candidate.availableInPlans === undefined ||
      isStringArray(candidate.availableInPlans)) &&
    isStringArray(candidate.serviceTiers) &&
    (candidate.webSearchToolType === 'text' ||
      candidate.webSearchToolType === 'text_and_image')
  );
}

function loadDiskCache(): boolean {
  if (diskCachePathOverride === null) return false;
  try {
    const raw = readFileSync(resolveDiskCachePath(), 'utf8');
    if (raw.length > MAX_UPSTREAM_BODY_BYTES) {
      logger.warn(
        { bytes: raw.length },
        'Codex model catalog: disk cache too large, ignoring',
      );
      return false;
    }
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      models?: unknown;
      fetchedAt?: unknown;
    };
    if (parsed.version !== DISK_CACHE_VERSION) {
      logger.info(
        'Codex model catalog: disk cache predates request-shape fields, ignoring',
      );
      return false;
    }
    const models = Array.isArray(parsed.models) ? parsed.models : [];
    if (
      models.length === 0 ||
      models.length > MAX_CATALOG_ENTRIES ||
      models.some((entry) => !isValidCatalogEntry(entry))
    ) {
      logger.warn(
        'Codex model catalog: disk cache failed validation, ignoring',
      );
      return false;
    }
    applyResolved({
      models: models.filter((entry) => isCodexModelSupportedByClient(entry)),
      source: 'disk-cache',
      fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : null,
    });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger.warn(
        { err },
        'Codex model catalog: failed to read disk cache, ignoring',
      );
    }
    return false;
  }
}

function writeDiskCache(models: readonly CodexModelCatalogEntry[]): void {
  if (diskCachePathOverride === null) return;
  const file = resolveDiskCachePath();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    // 先写临时文件再原子改名：进程中断不会留下半截缓存被下次启动读走。
    const tmpFile = `${file}.tmp`;
    writeFileSync(
      tmpFile,
      JSON.stringify(
        {
          version: DISK_CACHE_VERSION,
          models,
          fetchedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    renameSync(tmpFile, file);
  } catch (err) {
    logger.warn({ err }, 'Codex model catalog: failed to persist disk cache');
  }
}

/**
 * 拉取并应用上游目录。成功返回 true；任何失败保留当前目录。
 * 单飞：并发调用共享同一次拉取，避免重复请求。
 */
export async function refreshCodexCatalog(
  options: { fetchImpl?: FetchLike } = {},
): Promise<boolean> {
  if (inflight) return inflight;
  const doRefresh = async (): Promise<boolean> => {
    const fetchImpl = options.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(UPSTREAM_MODELS_URL, {
        headers: { 'User-Agent': 'happyclaw-codex-gateway' },
        signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Upstream catalog HTTP ${response.status}`);
      }
      const entries = parseUpstreamModelCatalog(
        JSON.parse(await readBodyWithCap(response)),
      );
      applyResolved({
        models: entries,
        source: 'upstream',
        fetchedAt: new Date().toISOString(),
      });
      lastRefreshAt = Date.now();
      lastRefreshFailed = false;
      writeDiskCache(entries);
      logger.info(
        { count: entries.length },
        'Codex model catalog refreshed from upstream',
      );
      return true;
    } catch (err) {
      // 失败也推进时间戳，但用更短的后隔（避免瞬时故障被 6h TTL 惩罚）。
      lastRefreshAt = Date.now();
      lastRefreshFailed = true;
      logger.warn(
        { err },
        'Codex model catalog: upstream refresh failed, keeping current catalog',
      );
      return false;
    }
  };
  inflight = doRefresh().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** TTL 内不重复拉取；由目录路由与启动路径调用，fire-and-forget。 */
export function maybeRefreshCodexCatalog(
  options: { force?: boolean } = {},
): void {
  const interval = lastRefreshFailed
    ? REFRESH_FAILURE_BACKOFF_MS
    : REFRESH_INTERVAL_MS;
  const stale = Date.now() - lastRefreshAt >= interval;
  if (!stale && !options.force) return;
  if (inflight) return;
  void refreshCodexCatalog();
}

/**
 * 启动时调用：先同步读磁盘缓存（重启后立即可用），再后台拉一次上游。
 * 永不抛错、不阻塞启动。fetchImpl 供测试注入，避免测试触发真实网络。
 */
export function initCodexCatalogSync(
  options: { fetchImpl?: FetchLike } = {},
): void {
  if (loadDiskCache()) {
    logger.info(
      { count: resolved.models.length },
      'Codex model catalog loaded from disk cache',
    );
  }
  void refreshCodexCatalog(options);
}

// ─── 按 provider 的实时目录（GET /backend-api/codex/models）────────────

interface LiveCodexCatalog {
  /** 拉取时凭据对应的 ChatGPT 账号；账号变化后旧目录作废。 */
  accountId: string | null;
  models: readonly CodexModelCatalogEntry[] | null;
  fetchedAt: number;
  attemptedAt: number;
  failed: boolean;
  /** x-models-etag 通报目录已变，下次检查时刷新。 */
  stale: boolean;
  /** 最近一次 /models 响应的 ETag。 */
  etag: string | null;
  /** 最近一次 Responses 响应头 x-models-etag 通报的值。 */
  notedEtag: string | null;
  inflight: Promise<boolean> | null;
}

const liveCatalogs = new Map<string, LiveCodexCatalog>();

function liveState(providerId: string): LiveCodexCatalog {
  let state = liveCatalogs.get(providerId);
  if (!state) {
    state = {
      accountId: null,
      models: null,
      fetchedAt: 0,
      attemptedAt: 0,
      failed: false,
      stale: false,
      etag: null,
      notedEtag: null,
      inflight: null,
    };
    liveCatalogs.set(providerId, state);
  }
  return state;
}

export type ProviderCodexCatalog = Omit<ResolvedCodexCatalog, 'source'> & {
  source: CodexCatalogSource | 'live';
};

/**
 * Provider 当前可用的目录：账号实时目录（过期也照用，刷新在后台）优先，
 * 其次全局目录。accountId 给出且与缓存账号不同时不使用旧账号的目录。
 * 同步、从不发网络请求，网关请求路径可放心调用。
 */
export function resolveCodexCatalogForProvider(
  providerId: string,
  accountId?: string | null,
): ProviderCodexCatalog {
  const state = liveCatalogs.get(providerId);
  if (
    state?.models &&
    (accountId === undefined || accountId === state.accountId)
  ) {
    return {
      models: state.models,
      source: 'live',
      fetchedAt: new Date(state.fetchedAt).toISOString(),
    };
  }
  return resolved;
}

export function getCodexCatalogForProvider(
  providerId: string,
  accountId?: string | null,
): readonly CodexModelCatalogEntry[] {
  return resolveCodexCatalogForProvider(providerId, accountId).models;
}

/**
 * 拉取一个 provider 的账号目录，请求头与官方客户端一致。成功返回 true；
 * 任何失败保留旧目录。按 provider 单飞。
 */
export async function refreshCodexProviderCatalog(
  providerId: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<boolean> {
  const state = liveState(providerId);
  if (state.inflight) return state.inflight;
  const doRefresh = async (): Promise<boolean> => {
    state.attemptedAt = Date.now();
    try {
      // 动态导入：token-manager 依赖 runtime-config，而 runtime-config 静态
      // 依赖本模块；运行时才取用可避免模块环。
      const { resolveCodexAccess } = await import('./token-manager.js');
      const access = await resolveCodexAccess(providerId);
      const fetchImpl = options.fetchImpl ?? fetch;
      const response = await fetchImpl(
        `${CODEX_BACKEND_MODELS_URL}?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`,
        {
          headers: {
            Authorization: `Bearer ${access.accessToken}`,
            ...(access.accountId
              ? { 'ChatGPT-Account-ID': access.accountId }
              : {}),
            ...codexBackendClientHeaders(),
          },
          signal: AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Codex models endpoint HTTP ${response.status}`);
      }
      const models = parseUpstreamModelCatalog(
        JSON.parse(await readBodyWithCap(response)),
      );
      state.accountId = access.accountId;
      state.models = models;
      state.fetchedAt = Date.now();
      state.failed = false;
      state.stale = false;
      state.etag = response.headers.get('etag');
      logger.info(
        { providerId, count: models.length },
        'Codex model catalog refreshed from the account models endpoint',
      );
      return true;
    } catch (err) {
      state.failed = true;
      logger.warn(
        { providerId, err: err instanceof Error ? err.message : String(err) },
        'Codex model catalog: account refresh failed, keeping current catalog',
      );
      return false;
    }
  };
  state.inflight = doRefresh().finally(() => {
    state.inflight = null;
  });
  return state.inflight;
}

function liveCatalogStale(
  state: LiveCodexCatalog | undefined,
  accountId?: string | null,
): boolean {
  if (!state) return true;
  if (state.failed)
    return Date.now() - state.attemptedAt >= REFRESH_FAILURE_BACKOFF_MS;
  if (!state.models || state.stale) return true;
  if (accountId !== undefined && accountId !== state.accountId) return true;
  return Date.now() - state.fetchedAt >= LIVE_CATALOG_TTL_MS;
}

/** 账号目录过期（1h）、换账号或从未拉取时后台刷新；fire-and-forget。 */
export function maybeRefreshCodexProviderCatalog(
  providerId: string,
  options: { accountId?: string | null; fetchImpl?: FetchLike } = {},
): void {
  const state = liveCatalogs.get(providerId);
  if (state?.inflight || !liveCatalogStale(state, options.accountId)) return;
  void refreshCodexProviderCatalog(providerId, options);
}

/**
 * 管理页面用：账号目录从未成功拉取时等待一次（受 5s 超时约束），
 * 否则按 TTL 后台刷新，立即返回现有目录。
 */
export async function ensureCodexProviderCatalog(
  providerId: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ProviderCodexCatalog> {
  const state = liveCatalogs.get(providerId);
  if (!state?.models && liveCatalogStale(state)) {
    await refreshCodexProviderCatalog(providerId, options);
  } else {
    maybeRefreshCodexProviderCatalog(providerId, options);
  }
  return resolveCodexCatalogForProvider(providerId);
}

/**
 * Responses 响应头 x-models-etag 变化且与缓存目录的 ETag 不同时，同官方
 * 客户端一样刷新账号目录。只在通报值变化时动作，两种 ETag 写法不一致也
 * 不会每个请求都刷新。官方不对 /models 发 If-None-Match，这里也不发。
 */
export function noteCodexModelsEtag(
  providerId: string,
  etag: string | null | undefined,
): void {
  const value = etag?.trim();
  if (!value || value.length > 256) return;
  const state = liveState(providerId);
  if (state.notedEtag === value) return;
  state.notedEtag = value;
  if (state.etag === value) return;
  state.stale = true;
  if (state.failed) state.attemptedAt = 0;
  maybeRefreshCodexProviderCatalog(providerId);
}

/** Provider 删除或重新登录后丢弃其账号目录。 */
export function forgetCodexProviderCatalog(providerId: string): void {
  liveCatalogs.delete(providerId);
}

/** 测试专用：重置内存状态与磁盘缓存路径覆写。 */
export function resetCodexCatalogSyncForTests(): void {
  applyResolved({
    models: CODEX_MODEL_CATALOG,
    source: 'builtin',
    fetchedAt: null,
  });
  inflight = null;
  lastRefreshAt = 0;
  lastRefreshFailed = false;
  diskCachePathOverride = undefined;
  liveCatalogs.clear();
}

/** 测试专用：覆写磁盘缓存路径（null 关闭磁盘读写）。 */
export function setCodexCatalogDiskCachePathForTests(
  value: string | null,
): void {
  diskCachePathOverride = value;
}
