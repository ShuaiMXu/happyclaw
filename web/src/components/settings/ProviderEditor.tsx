import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Eye,
  EyeOff,
  Key,
  Loader2,
  PlugZap,
  Plus,
  RotateCcw,
  TriangleAlert,
  X,
} from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { IconButton } from '@/components/common/IconButton';
import { SegmentedControl } from '@/components/common/SegmentedControl';
import { SettingsField } from './SettingsLayout';
import { ProviderEnvImportPanel } from './ProviderEnvImportPanel';
import {
  ProviderConnectivityResult,
  type ProviderConnectivityResponse,
} from './ProviderConnectivityResult';
import { api } from '../../api/client';
import {
  buildDefaultProviderEnv,
  buildProviderModel,
  parseProviderModel,
} from '../../utils/provider-model';
import type {
  ProviderAuthMode,
  ProviderEnvImport,
} from '../../utils/provider-env-import';
import {
  PROVIDER_PRESETS,
  describeBaseUrlProblem,
} from '../../utils/provider-presets';
import type { ProviderWithHealth, EnvRow } from './types';
import { getErrorMessage } from './types';

type ProviderType = 'official' | 'third_party' | 'codex';
type OfficialAuthTab = 'oauth' | 'setup_token' | 'api_key';

const RESERVED_ENV_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_MODEL',
]);

const DEFAULTED_THIRD_PARTY_ENV_KEYS = new Set(
  buildDefaultProviderEnv('', false).map((row) => row.key),
);

// ChatGPT 订阅型配置：目标 Codex 模型与推理力度（网关映射到上游请求）。
// 目录唯一真相源在后端 src/codex-gateway/model-catalog.ts（对齐上游 codex
// CLI 的 models.json），通过 GET /api/config/codex/model-catalog 获取；
// 下面这份只在目录接口不可用时兜底，保证编辑器离线也能渲染。
const CODEX_FULL_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;
const CODEX_CAPPED_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const CODEX_LEGACY_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;

// 每个模型支持的 reasoning.effort 档位不同（如 gpt-6-luna 无 ultra、gpt-5.5 无
// max/ultra），选了模型目录不支持的档位会被上游 Responses API 拒绝（400）。
const CODEX_FALLBACK_MODEL_OPTIONS: ReadonlyArray<{
  value: string;
  label: string;
  efforts: readonly string[];
}> = [
  {
    value: 'gpt-6-sol',
    label: 'gpt-6-sol（主力编码）',
    efforts: CODEX_FULL_EFFORTS,
  },
  {
    value: 'gpt-6-astra',
    label: 'gpt-6-astra（旗舰·最强推理）',
    efforts: CODEX_FULL_EFFORTS,
  },
  {
    value: 'gpt-6-luna',
    label: 'gpt-6-luna（快速轻量）',
    efforts: CODEX_CAPPED_EFFORTS,
  },
  {
    value: 'gpt-5.6-sol',
    label: 'gpt-5.6-sol（上一代编码）',
    efforts: CODEX_FULL_EFFORTS,
  },
  {
    value: 'gpt-5.6-terra',
    label: 'gpt-5.6-terra（上一代均衡）',
    efforts: CODEX_FULL_EFFORTS,
  },
  {
    value: 'gpt-5.6-luna',
    label: 'gpt-5.6-luna（上一代快速）',
    efforts: CODEX_CAPPED_EFFORTS,
  },
  {
    value: 'gpt-5.5',
    label: 'gpt-5.5（旧款）',
    efforts: CODEX_LEGACY_EFFORTS,
  },
] as const;
const CODEX_FALLBACK_DEFAULT_MODEL = 'gpt-6-sol';
const CODEX_FALLBACK_DEFAULT_EFFORT = 'medium';

interface CodexCatalog {
  models: ReadonlyArray<{
    value: string;
    label: string;
    efforts: readonly string[];
    defaultEffort?: string;
  }>;
  defaultModel: string;
  defaultEffort: string;
}

const CODEX_FALLBACK_CATALOG: CodexCatalog = {
  models: CODEX_FALLBACK_MODEL_OPTIONS,
  defaultModel: CODEX_FALLBACK_DEFAULT_MODEL,
  defaultEffort: CODEX_FALLBACK_DEFAULT_EFFORT,
};

const PROXY_ENV_KEY_RE = /^(https?|all|no)_proxy$/i;
const ONE_MILLION_SUFFIX_RE = /\[1m\]\s*$/i;

const MANAGED_ENV_SOURCE_LABELS = {
  model: '跟随模型',
  context: '跟随上下文',
  default: '系统默认',
} as const;

function buildCustomEnv(
  rows: EnvRow[],
  manageThirdPartyDefaults: boolean,
): {
  customEnv: Record<string, string>;
  error: string | null;
} {
  const customEnv: Record<string, string> = {};

  for (const [idx, row] of rows.entries()) {
    const key = row.key.trim();
    const value = row.value;

    if (!key && !value.trim()) continue;

    if (!key) {
      return { customEnv: {}, error: `第 ${idx + 1} 行环境变量 Key 不能为空` };
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return {
        customEnv: {},
        error: `环境变量 Key "${key}" 格式无效（需匹配 [A-Za-z_][A-Za-z0-9_]*）`,
      };
    }
    if (RESERVED_ENV_KEYS.has(key)) {
      return {
        customEnv: {},
        error: `${key} 由端点、密钥或模型字段管理，请在对应字段中填写`,
      };
    }
    if (manageThirdPartyDefaults && DEFAULTED_THIRD_PARTY_ENV_KEYS.has(key)) {
      return {
        customEnv: {},
        error: `${key} 已在系统预填列表中，请直接修改对应值`,
      };
    }
    if (customEnv[key] !== undefined) {
      return { customEnv: {}, error: `环境变量 Key "${key}" 重复` };
    }
    customEnv[key] = value;
  }

  return { customEnv, error: null };
}

/** Blank prefilled overrides mean "use the default"; never persist them. */
function nonBlank(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value.trim()),
  );
}

function hostnameOf(url: string): string {
  try {
    return new URL(url.trim()).hostname;
  } catch {
    return '';
  }
}

interface ProviderEditorProps {
  open: boolean;
  /** null 表示创建模式 */
  provider: ProviderWithHealth | null;
  onSave: () => void;
  onCancel: () => void;
  setNotice: (msg: string | null) => void;
  setError: (msg: string | null) => void;
}

export function ProviderEditor({
  open,
  provider,
  onSave,
  onCancel,
  setNotice,
  setError,
}: ProviderEditorProps) {
  const isCreate = provider === null;

  // 基础字段
  const [providerType, setProviderType] = useState<ProviderType>('third_party');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [oneMillionContext, setOneMillionContext] = useState(false);

  // ChatGPT 订阅型配置：目标模型与推理力度
  const [codexModel, setCodexModel] = useState<string>(
    CODEX_FALLBACK_DEFAULT_MODEL,
  );
  const [codexEffort, setCodexEffort] = useState<string>(
    CODEX_FALLBACK_DEFAULT_EFFORT,
  );
  // Codex 模型目录：唯一真相源在后端，打开编辑器时拉取；接口不可用时
  // 保留内置兜底目录（与后端当前版本一致）。
  const [codexCatalog, setCodexCatalog] = useState<CodexCatalog>(
    CODEX_FALLBACK_CATALOG,
  );
  const codexCatalogRef = useRef<CodexCatalog>(CODEX_FALLBACK_CATALOG);
  useEffect(() => {
    codexCatalogRef.current = codexCatalog;
  }, [codexCatalog]);
  useEffect(() => {
    let cancelled = false;
    api
      .get<CodexCatalog>('/api/config/codex/model-catalog')
      .then((catalog) => {
        if (
          cancelled ||
          !catalog ||
          !Array.isArray(catalog.models) ||
          catalog.models.length === 0
        ) {
          return;
        }
        const normalized: CodexCatalog = {
          models: catalog.models,
          defaultModel: catalog.defaultModel || CODEX_FALLBACK_DEFAULT_MODEL,
          defaultEffort: catalog.defaultEffort || CODEX_FALLBACK_DEFAULT_EFFORT,
        };
        setCodexCatalog(normalized);
        codexCatalogRef.current = normalized;
      })
      .catch(() => {
        // 目录接口不可用：静默保留兜底目录
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 官方认证
  const [authTab, setAuthTab] = useState<OfficialAuthTab>('oauth');
  const [setupToken, setSetupToken] = useState('');
  const [apiKey, setApiKey] = useState('');

  // OAuth 流程
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthState, setOauthState] = useState<string | null>(null);
  const [oauthCode, setOauthCode] = useState('');
  const [oauthExchanging, setOauthExchanging] = useState(false);

  // 第三方认证
  const [authToken, setAuthToken] = useState('');
  const [authTokenDirty, setAuthTokenDirty] = useState(false);
  const [clearTokenOnSave, setClearTokenOnSave] = useState(false);
  // 'legacy' = 旧配置未选择过认证方式，后端沿用旧的推断规则
  const [authMode, setAuthMode] = useState<ProviderAuthMode | 'legacy'>(
    'bearer',
  );

  // 测试连接
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] =
    useState<ProviderConnectivityResponse | null>(null);

  // 环境变量
  const [customEnvRows, setCustomEnvRows] = useState<EnvRow[]>([]);
  const [providerEnvOverrides, setProviderEnvOverrides] = useState<
    Record<string, string>
  >({});
  const [showCustomEnvValues, setShowCustomEnvValues] = useState<
    Record<number, boolean>
  >({});

  // 状态
  const [saving, setSaving] = useState(false);

  const defaultProviderEnv = buildDefaultProviderEnv(model, oneMillionContext);
  const effectiveCompactWindow =
    providerEnvOverrides.CLAUDE_CODE_AUTO_COMPACT_WINDOW?.trim() ||
    (oneMillionContext ? '1000000' : '200000');
  const baseUrlProblem = describeBaseUrlProblem(baseUrl);
  const customProxyKeys = customEnvRows
    .map((row) => row.key.trim())
    .filter((key) => PROXY_ENV_KEY_RE.test(key));

  // A result describes the draft it was run against; drop it once that changes.
  useEffect(() => {
    setTestResult(null);
  }, [baseUrl, authToken, authMode, model, oneMillionContext, open]);

  // 当前值不在预设里（如后端已配置其他模型，例如旧目录的 gpt-5.1-*）时，
  // 追加为额外选项，避免 select 显示空白。
  const selectedCodexModel = codexCatalog.models.find(
    (option) => option.value === codexModel,
  );
  const codexModelChoices: readonly { value: string; label: string }[] =
    selectedCodexModel
      ? codexCatalog.models
      : [{ value: codexModel, label: codexModel }, ...codexCatalog.models];
  // 推理力度档位按所选模型的目录过滤：不同模型支持的档位不同（见上方常量），
  // 选了模型不支持的档位会被上游拒绝。未识别的模型退回全量档位，避免选不了。
  const codexModelEfforts: readonly string[] =
    selectedCodexModel?.efforts ?? CODEX_FULL_EFFORTS;
  const codexEffortChoices: readonly string[] = codexModelEfforts.includes(
    codexEffort,
  )
    ? codexModelEfforts
    : [codexEffort, ...codexModelEfforts];

  // 初始化表单
  useEffect(() => {
    if (!open) return;
    setShowCustomEnvValues({});

    if (isCreate) {
      setProviderType('third_party');
      setName('');
      setBaseUrl('');
      setModel('');
      setOneMillionContext(false);
      setCodexModel(codexCatalogRef.current.defaultModel);
      setCodexEffort(codexCatalogRef.current.defaultEffort);
      setAuthTab('oauth');
      setSetupToken('');
      setApiKey('');
      setOauthState(null);
      setOauthCode('');
      setAuthToken('');
      setAuthTokenDirty(false);
      setClearTokenOnSave(false);
      setAuthMode('bearer');
      setCustomEnvRows([]);
      setProviderEnvOverrides({});
    } else {
      setProviderType(
        provider.hasCodexOAuthCredentials ? 'codex' : provider.type,
      );
      setName(provider.name);
      setBaseUrl(provider.anthropicBaseUrl || '');
      const modelSelection = parseProviderModel(provider.anthropicModel || '');
      setModel(modelSelection.model);
      setOneMillionContext(modelSelection.oneMillionContext);
      setCodexModel(
        provider.anthropicModel || codexCatalogRef.current.defaultModel,
      );
      setCodexEffort(
        provider.customEnv?.CODEX_REASONING_EFFORT ||
          codexCatalogRef.current.defaultEffort,
      );
      setAuthTab('oauth');
      setSetupToken('');
      setApiKey('');
      setOauthState(null);
      setOauthCode('');
      setAuthToken('');
      setAuthTokenDirty(false);
      setClearTokenOnSave(false);
      setAuthMode(provider.anthropicAuthMode ?? 'legacy');
      const providerCustomEnv = provider.customEnv || {};
      const defaultEnv = Object.fromEntries(
        buildDefaultProviderEnv(
          modelSelection.model,
          modelSelection.oneMillionContext,
        ).map((row) => [row.key, row.value]),
      );
      const initialProviderEnvOverrides: Record<string, string> = {};
      if (provider.type === 'third_party') {
        for (const [key, value] of Object.entries(providerCustomEnv)) {
          if (
            DEFAULTED_THIRD_PARTY_ENV_KEYS.has(key) &&
            value !== defaultEnv[key]
          ) {
            initialProviderEnvOverrides[key] = value;
          }
        }
      }
      setProviderEnvOverrides(initialProviderEnvOverrides);

      const envRows = Object.entries(providerCustomEnv)
        .filter(
          ([key]) =>
            provider.type !== 'third_party' ||
            !DEFAULTED_THIRD_PARTY_ENV_KEYS.has(key),
        )
        .map(([key, value]) => ({ key, value }));
      setCustomEnvRows(envRows);
    }
  }, [open, isCreate, provider]);

  const addRow = () =>
    setCustomEnvRows((prev) => [...prev, { key: '', value: '' }]);
  const removeRow = (index: number) =>
    setCustomEnvRows((prev) => prev.filter((_, i) => i !== index));
  const updateRow = (index: number, field: keyof EnvRow, value: string) =>
    setCustomEnvRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );

  const updateProviderEnv = (
    key: string,
    value: string,
    defaultValue: string,
  ) => {
    setProviderEnvOverrides((current) => {
      const next = { ...current };
      if (value === defaultValue) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  };

  const resetProviderEnv = (key: string) => {
    setProviderEnvOverrides((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  /** A pasted `glm-5.3[1m]` turns the 1M switch on instead of being lost. */
  const handleModelChange = (value: string) => {
    if (ONE_MILLION_SUFFIX_RE.test(value)) {
      setModel(value.replace(ONE_MILLION_SUFFIX_RE, ''));
      setOneMillionContext(true);
    } else {
      setModel(value);
    }
  };

  const applyPreset = (preset: (typeof PROVIDER_PRESETS)[number]) => {
    setBaseUrl(preset.baseUrl);
    if (!model.trim()) {
      setModel(preset.model);
      setOneMillionContext(preset.oneMillionContext);
    }
    if (!name.trim()) setName(preset.label);
  };

  const applyImport = (imported: ProviderEnvImport) => {
    if (imported.name && !name.trim()) setName(imported.name);
    if (imported.baseUrl) setBaseUrl(imported.baseUrl);
    if (imported.token) {
      setAuthToken(imported.token);
      setAuthTokenDirty(true);
      setClearTokenOnSave(false);
    }
    if (imported.authMode) setAuthMode(imported.authMode);
    if (imported.model !== null) {
      setModel(imported.model);
      setOneMillionContext(imported.oneMillionContext);
    }
    setProviderEnvOverrides(imported.envOverrides);
    const importedRows = Object.entries(imported.customEnv).map(
      ([key, value]) => ({ key, value }),
    );
    if (importedRows.length > 0) {
      setCustomEnvRows((current) => [
        ...current.filter(
          (row) => row.key.trim() && !(row.key.trim() in imported.customEnv),
        ),
        ...importedRows,
      ]);
    }
    setNotice('已从粘贴内容填入表单，请检查后保存');
  };

  // ─── 测试连接 ───────────────────────────────────────────────
  const handleTestConnection = async () => {
    const envResult = buildCustomEnv(customEnvRows, true);
    if (envResult.error) {
      setError(envResult.error);
      return;
    }
    setTesting(true);
    setError(null);
    try {
      const draftToken = authTokenDirty ? authToken.trim() : '';
      const result = await api.post<ProviderConnectivityResponse>(
        '/api/config/claude/providers/test',
        {
          ...(provider ? { providerId: provider.id } : {}),
          anthropicBaseUrl: baseUrl.trim(),
          ...(draftToken ? { anthropicAuthToken: draftToken } : {}),
          ...(authMode !== 'legacy' ? { anthropicAuthMode: authMode } : {}),
          anthropicModel: buildProviderModel(model, oneMillionContext),
          customEnv: {
            ...envResult.customEnv,
            ...nonBlank(providerEnvOverrides),
          },
        },
        60_000,
      );
      setTestResult(result);
    } catch (err) {
      setError(getErrorMessage(err, '测试连接失败'));
    } finally {
      setTesting(false);
    }
  };

  // ─── OAuth 流程 ─────────────────────────────────────────────
  // 'full' = 完整登录（自动续期）；'setup_token' = 1 年期、仅推理权限
  const handleOAuthStart = useCallback(
    async (profile: 'full' | 'setup_token' = 'full') => {
      setOauthLoading(true);
      setError(null);
      try {
        const body: Record<string, unknown> = {};
        // 编辑模式下传入目标提供商 ID
        if (!isCreate && provider) {
          body.targetProviderId = provider.id;
        }
        if (profile === 'setup_token') body.profile = 'setup_token';
        const data = await api.post<{ authorizeUrl: string; state: string }>(
          '/api/config/claude/oauth/start',
          Object.keys(body).length > 0 ? body : undefined,
        );
        setOauthState(data.state);
        setOauthCode('');
        window.open(data.authorizeUrl, '_blank', 'noopener,noreferrer');
      } catch (err) {
        setError(getErrorMessage(err, 'OAuth 授权启动失败'));
      } finally {
        setOauthLoading(false);
      }
    },
    [isCreate, provider, setError],
  );

  const handleOAuthCallback = useCallback(async () => {
    if (!oauthState || !oauthCode.trim()) {
      setError('请粘贴授权码');
      return;
    }
    setOauthExchanging(true);
    setError(null);
    try {
      await api.post('/api/config/claude/oauth/callback', {
        state: oauthState,
        code: oauthCode.trim(),
      });
      setOauthState(null);
      setOauthCode('');
      setNotice('OAuth 登录成功，凭据已保存。');
      onSave();
    } catch (err) {
      // A definitive rejection consumed the flow server-side; only transient
      // failures (retryable) can be retried with the same code.
      const retryable = (err as { body?: { retryable?: unknown } })?.body
        ?.retryable;
      if (retryable === false) {
        setOauthState(null);
        setOauthCode('');
      }
      setError(getErrorMessage(err, 'OAuth 授权码换取失败'));
    } finally {
      setOauthExchanging(false);
    }
  }, [oauthState, oauthCode, setError, setNotice, onSave]);

  // ─── Codex（ChatGPT 订阅）OAuth 流程 ────────────────────────
  const handleCodexOAuthStart = useCallback(async () => {
    setOauthLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      // 编辑模式下传入目标提供商 ID（重新登录）
      if (!isCreate && provider) {
        body.targetProviderId = provider.id;
      }
      const data = await api.post<{
        authorizeUrl: string;
        state: string;
        redirectHint: string;
      }>(
        '/api/config/codex/oauth/start',
        Object.keys(body).length > 0 ? body : undefined,
      );
      setOauthState(data.state);
      setOauthCode('');
      window.open(data.authorizeUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(getErrorMessage(err, 'ChatGPT 授权启动失败'));
    } finally {
      setOauthLoading(false);
    }
  }, [isCreate, provider, setError]);

  const handleCodexOAuthCallback = useCallback(async () => {
    if (!oauthState || !oauthCode.trim()) {
      setError('请粘贴回调地址');
      return;
    }
    setOauthExchanging(true);
    setError(null);
    try {
      await api.post('/api/config/codex/oauth/callback', {
        state: oauthState,
        code: oauthCode.trim(),
      });
      setOauthState(null);
      setOauthCode('');
      setNotice('ChatGPT 授权成功，凭据已保存。');
      onSave();
    } catch (err) {
      setError(getErrorMessage(err, 'ChatGPT 授权码换取失败'));
    } finally {
      setOauthExchanging(false);
    }
  }, [oauthState, oauthCode, setError, setNotice, onSave]);

  // ─── 保存 ──────────────────────────────────────────────────
  const handleSave = async () => {
    const normalizedModel =
      providerType === 'third_party'
        ? buildProviderModel(model, oneMillionContext)
        : model.trim();
    // An empty third-party model is a pass-through relay: Claude Code keeps
    // requesting its own model names and the relay routes them.
    const trimmedName =
      name.trim() ||
      (providerType === 'third_party'
        ? parseProviderModel(normalizedModel).model || hostnameOf(baseUrl)
        : '');
    if (!trimmedName) {
      setError('请填写模型配置名称');
      return;
    }

    // ChatGPT 订阅型配置：端点与凭据由后端网关管理，允许改名、选模型和推理力度。
    if (providerType === 'codex') {
      if (isCreate) {
        setError('请先完成 ChatGPT 授权，配置会在授权后自动创建');
        return;
      }
      setSaving(true);
      setError(null);
      try {
        // customEnv 为整体替换语义：保留其他既有变量，仅更新推理力度。
        const nextCustomEnv: Record<string, string> = {
          ...(provider?.customEnv ?? {}),
          CODEX_REASONING_EFFORT: codexEffort,
        };
        await api.patch(`/api/config/claude/providers/${provider!.id}`, {
          name: trimmedName,
          anthropicModel: codexModel.trim() || codexCatalog.defaultModel,
          customEnv: nextCustomEnv,
        });
        setNotice('模型配置已保存。');
        onSave();
      } catch (err) {
        setError(getErrorMessage(err, '保存模型配置失败'));
      } finally {
        setSaving(false);
      }
      return;
    }

    const trimmedBaseUrl = baseUrl.trim();
    if (providerType === 'third_party' && !trimmedBaseUrl) {
      setError('请填写 API 端点');
      return;
    }

    const envResult = buildCustomEnv(
      customEnvRows,
      providerType === 'third_party',
    );
    if (envResult.error) {
      setError(envResult.error);
      return;
    }
    const savedCustomEnv = {
      ...envResult.customEnv,
      ...(providerType === 'third_party' ? nonBlank(providerEnvOverrides) : {}),
    };

    setSaving(true);
    setError(null);

    try {
      if (isCreate) {
        // ── 创建模式 ──
        const createBody: Record<string, unknown> = {
          name: trimmedName,
          type: providerType,
          customEnv: savedCustomEnv,
        };

        if (providerType === 'third_party') {
          const trimmedToken = authToken.trim();
          if (!trimmedToken) {
            setError('新建第三方模型配置时必须填写 API 密钥');
            setSaving(false);
            return;
          }
          createBody.anthropicBaseUrl = trimmedBaseUrl;
          createBody.anthropicAuthToken = trimmedToken;
          if (authMode !== 'legacy') createBody.anthropicAuthMode = authMode;
        } else {
          // 官方模式 — 根据认证方式设置凭据
          if (authTab === 'setup_token') {
            const trimmed = setupToken.trim();
            if (!trimmed) {
              setError('请填写 setup-token 或粘贴 .credentials.json 内容');
              setSaving(false);
              return;
            }
            // .credentials.json 或 setup-token 原文交给服务端解析与校验
            createBody.claudeCredentialInput = trimmed;
          } else if (authTab === 'api_key') {
            const trimmed = apiKey.trim();
            if (!trimmed) {
              setError('请填写 Anthropic API Key');
              setSaving(false);
              return;
            }
            createBody.anthropicApiKey = trimmed;
          } else {
            // OAuth 模式 — 不需要凭据，通过 OAuth 流程设置
            // 允许不带凭据创建，用户之后通过 OAuth 流程补充
          }
        }

        if (normalizedModel) createBody.anthropicModel = normalizedModel;

        await api.post('/api/config/claude/providers', createBody);
        setNotice('模型配置已创建。');
      } else {
        // ── 编辑模式 ──
        const patchBody: Record<string, unknown> = {
          name: trimmedName,
          customEnv: savedCustomEnv,
        };

        if (providerType === 'third_party') {
          patchBody.anthropicBaseUrl = trimmedBaseUrl;
          if (authMode !== 'legacy') patchBody.anthropicAuthMode = authMode;
          // The key travels with the other fields: one request, one runner
          // restart, and never an endpoint saved without its key.
          if (clearTokenOnSave) {
            patchBody.clearAnthropicAuthToken = true;
          } else if (authTokenDirty && authToken.trim()) {
            patchBody.anthropicAuthToken = authToken.trim();
          }
        }
        patchBody.anthropicModel = normalizedModel;

        await api.patch(
          `/api/config/claude/providers/${provider!.id}`,
          patchBody,
        );

        // 官方配置的凭据仍走 /secrets
        const secretsBody: Record<string, unknown> = {};
        let hasSecretsChange = false;

        if (providerType === 'official') {
          // 官方模式编辑时更新凭据
          // 服务端解析粘贴原文，并保证官方配置只保留一种凭据
          if (authTab === 'setup_token' && setupToken.trim()) {
            secretsBody.claudeCredentialInput = setupToken.trim();
            hasSecretsChange = true;
          } else if (authTab === 'api_key' && apiKey.trim()) {
            secretsBody.anthropicApiKey = apiKey.trim();
            hasSecretsChange = true;
          }
        }

        if (hasSecretsChange) {
          await api.put(
            `/api/config/claude/providers/${provider!.id}/secrets`,
            secretsBody,
          );
        }

        setNotice('模型配置已保存。');
      }

      onSave();
    } catch (err) {
      setError(
        getErrorMessage(
          err,
          isCreate ? '创建模型配置失败' : '保存模型配置失败',
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (!saving && !oauthExchanging) {
      setOauthState(null);
      onCancel();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isCreate ? '添加模型配置' : `编辑模型配置：${provider?.name}`}
          </DialogTitle>
          <DialogDescription>
            {providerType === 'third_party'
              ? '填写端点、密钥和模型即可；Claude Code 运行参数会自动预填，也可在高级设置中调整。'
              : providerType === 'codex'
                ? '使用 ChatGPT Plus / Pro 订阅授权；凭据保存在服务端，经内嵌网关驱动 Claude Code。'
                : '配置 Claude 官方认证方式与默认模型。'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* 类型选择（仅创建模式） */}
          {isCreate && (
            <SettingsField label="模型配置类型">
              <SegmentedControl
                label="模型配置类型"
                value={providerType}
                onChange={setProviderType}
                options={[
                  { value: 'official', label: '官方' },
                  { value: 'third_party', label: '第三方' },
                  { value: 'codex', label: 'ChatGPT 订阅' },
                ]}
              />
            </SettingsField>
          )}

          {/* 名称（创建 ChatGPT 订阅配置时由 OAuth 回调自动命名，隐藏） */}
          {!(isCreate && providerType === 'codex') && (
            <SettingsField
              label={
                providerType === 'third_party' ? '配置名称（可选）' : '名称'
              }
              htmlFor="provider-name"
            >
              <Input
                id="provider-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={saving}
                placeholder={
                  providerType === 'official'
                    ? '如：Claude 官方'
                    : providerType === 'codex'
                      ? '如：ChatGPT 订阅'
                      : '留空时使用模型名称'
                }
              />
            </SettingsField>
          )}

          {/* ─── 官方模式 ─── */}
          {providerType === 'official' && (
            <div className="space-y-4">
              <SettingsField label="认证方式">
                <SegmentedControl
                  label="认证方式"
                  value={authTab}
                  onChange={setAuthTab}
                  options={[
                    { value: 'oauth', label: 'OAuth 登录' },
                    { value: 'setup_token', label: 'Setup Token' },
                    { value: 'api_key', label: 'API Key' },
                  ]}
                />
              </SettingsField>

              {authTab === 'oauth' && (
                <div className="space-y-3 rounded-lg border border-surface-border p-4">
                  <div>
                    <div className="text-label text-foreground">
                      一键登录 Claude（推荐）
                    </div>
                    <div className="mt-1 text-caption leading-5 text-muted-foreground">
                      点击按钮后会打开 claude.ai
                      授权页面，完成授权后将页面上显示的授权码粘贴回来。
                    </div>
                  </div>

                  {/* 编辑模式：需要重新登录 */}
                  {!isCreate && provider?.claudeOAuthNeedsReLogin && (
                    <div
                      role="alert"
                      className="flex gap-2 rounded-lg bg-error/10 px-3 py-2.5 text-caption leading-5 text-error"
                    >
                      <TriangleAlert
                        className="mt-0.5 size-4 shrink-0"
                        aria-hidden="true"
                      />
                      <div className="min-w-0">
                        <div className="font-medium">
                          {provider.claudeOAuthLastRefreshError?.kind ===
                          'account_mismatch'
                            ? '续期返回了另一个账号，已拒绝写入，请重新登录'
                            : '授权已失效，需要重新登录 Claude'}
                        </div>
                        {provider.claudeOAuthLastRefreshError?.message && (
                          <div className="break-words opacity-80">
                            {provider.claudeOAuthLastRefreshError.message}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* 编辑模式显示现有凭据 */}
                  {!isCreate && provider?.hasClaudeOAuthCredentials && (
                    <div className="space-y-1 rounded-lg bg-success/10 px-3 py-2.5 text-caption text-success">
                      {(provider.claudeOAuthAccountEmail ||
                        provider.claudeOAuthSubscriptionType) && (
                        <div>
                          账号：{provider.claudeOAuthAccountEmail ?? '未知'}
                          {provider.claudeOAuthSubscriptionType
                            ? `（${provider.claudeOAuthSubscriptionType}）`
                            : ''}
                          {provider.claudeOAuthOrganizationName
                            ? ` · ${provider.claudeOAuthOrganizationName}`
                            : ''}
                        </div>
                      )}
                      <div>
                        Access Token:{' '}
                        <span className="font-mono">
                          {provider.claudeOAuthCredentialsAccessTokenMasked ||
                            '***'}
                        </span>
                      </div>
                      {provider.claudeOAuthCredentialsExpiresAt && (
                        <div
                          className={
                            provider.claudeOAuthCredentialsExpiresAt <=
                            Date.now()
                              ? 'font-medium text-error'
                              : undefined
                          }
                        >
                          过期时间:{' '}
                          {new Date(
                            provider.claudeOAuthCredentialsExpiresAt,
                          ).toLocaleString('zh-CN')}
                          {provider.claudeOAuthCredentialsExpiresAt > Date.now()
                            ? ` (${Math.round((provider.claudeOAuthCredentialsExpiresAt - Date.now()) / 60000)} 分钟后)`
                            : ' (已过期)'}
                        </div>
                      )}
                      <div className="text-muted-foreground">
                        HappyClaw 会在过期前自动续期
                        {provider.claudeOAuthLastRefreshAt
                          ? `，上次续期 ${new Date(
                              provider.claudeOAuthLastRefreshAt,
                            ).toLocaleString('zh-CN')}`
                          : ''}
                        。
                      </div>
                    </div>
                  )}

                  {!oauthState ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        onClick={() => void handleOAuthStart('full')}
                        disabled={saving || oauthLoading}
                      >
                        {oauthLoading ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <ExternalLink />
                        )}
                        {!isCreate && provider?.hasClaudeOAuthCredentials
                          ? '重新登录 Claude'
                          : '一键登录 Claude'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleOAuthStart('setup_token')}
                        disabled={saving || oauthLoading}
                        title="与 claude setup-token 相同：1 年有效、仅推理权限，不支持用量查询"
                      >
                        改为获取 1 年期 Setup Token
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="rounded-lg bg-warning/10 px-3 py-2 text-caption leading-5 text-warning">
                        授权窗口已打开，请在 Claude
                        完成授权后，把页面上显示的授权码（或回调页完整地址）粘贴到下方。
                      </div>
                      <div className="flex gap-2">
                        <Input
                          type="text"
                          value={oauthCode}
                          onChange={(e) => setOauthCode(e.target.value)}
                          disabled={oauthExchanging}
                          placeholder="粘贴授权码或回调页地址"
                          aria-label="粘贴授权码"
                          className="flex-1"
                        />
                        <Button
                          variant="outline"
                          onClick={handleOAuthCallback}
                          disabled={oauthExchanging || !oauthCode.trim()}
                        >
                          {oauthExchanging && (
                            <Loader2 className="animate-spin" />
                          )}
                          确认
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setOauthState(null);
                            setOauthCode('');
                          }}
                        >
                          取消
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {authTab === 'setup_token' && (
                <SettingsField
                  label={
                    <>
                      setup-token 或 .credentials.json{' '}
                      {!isCreate && provider?.hasClaudeCodeOauthToken && (
                        <span className="font-mono font-normal text-muted-foreground">
                          ({provider.claudeCodeOauthTokenMasked})
                        </span>
                      )}
                    </>
                  }
                  htmlFor="provider-setup-token"
                  description={
                    <>
                      支持粘贴{' '}
                      <code className="rounded bg-muted px-1 font-mono">
                        cat ~/.claude/.credentials.json
                      </code>{' '}
                      的 JSON 内容
                    </>
                  }
                >
                  <Input
                    id="provider-setup-token"
                    type="password"
                    value={setupToken}
                    onChange={(e) => setSetupToken(e.target.value)}
                    disabled={saving}
                    placeholder={
                      !isCreate &&
                      (provider?.hasClaudeCodeOauthToken ||
                        provider?.hasClaudeOAuthCredentials)
                        ? '输入新值覆盖'
                        : '粘贴 setup-token 或 cat ~/.claude/.credentials.json 输出'
                    }
                  />
                </SettingsField>
              )}

              {authTab === 'api_key' && (
                <SettingsField
                  label={
                    <span className="flex items-center gap-1.5">
                      <Key className="size-3.5 text-muted-foreground" />
                      ANTHROPIC_API_KEY{' '}
                      {!isCreate && provider?.hasAnthropicApiKey && (
                        <span className="font-mono font-normal text-muted-foreground">
                          ({provider.anthropicApiKeyMasked})
                        </span>
                      )}
                    </span>
                  }
                  htmlFor="provider-api-key"
                  description={
                    <>
                      直接使用 Anthropic 官方 API Key，从{' '}
                      <a
                        href="https://console.anthropic.com/settings/keys"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary-text underline underline-offset-2"
                      >
                        console.anthropic.com
                      </a>{' '}
                      获取
                    </>
                  }
                >
                  <Input
                    id="provider-api-key"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    disabled={saving}
                    placeholder={
                      !isCreate && provider?.hasAnthropicApiKey
                        ? '输入新值覆盖'
                        : 'sk-ant-api03-...'
                    }
                    className="font-mono"
                  />
                </SettingsField>
              )}
            </div>
          )}

          {/* ─── ChatGPT 订阅模式 ─── */}
          {providerType === 'codex' && (
            <div className="space-y-3 rounded-lg border border-surface-border p-4">
              <div>
                <div className="text-label text-foreground">
                  使用 ChatGPT 订阅登录
                </div>
                <div className="mt-1 text-caption leading-5 text-muted-foreground">
                  点击按钮打开 ChatGPT 登录页（需要 Plus / Pro / Team
                  订阅）。完成授权后浏览器会跳转到{' '}
                  <code className="rounded bg-muted px-1 font-mono">
                    localhost:1455
                  </code>{' '}
                  ——该页面打不开是正常的，把浏览器地址栏的完整地址复制粘贴到下方即可。
                </div>
              </div>

              {/* 编辑模式显示现有凭据 */}
              {!isCreate && provider?.hasCodexOAuthCredentials && (
                <div className="space-y-1 rounded-lg bg-success/10 px-3 py-2.5 text-caption text-success">
                  {provider.codexOAuthCredentialsEmail && (
                    <div>
                      账号：{provider.codexOAuthCredentialsEmail}
                      {provider.codexOAuthCredentialsPlanType
                        ? `（${provider.codexOAuthCredentialsPlanType}）`
                        : ''}
                    </div>
                  )}
                  {provider.codexOAuthCredentialsExpiresAt && (
                    <div
                      className={
                        provider.codexOAuthCredentialsExpiresAt <= Date.now()
                          ? 'font-medium text-error'
                          : undefined
                      }
                    >
                      过期时间:{' '}
                      {new Date(
                        provider.codexOAuthCredentialsExpiresAt,
                      ).toLocaleString('zh-CN')}
                      {provider.codexOAuthCredentialsExpiresAt > Date.now()
                        ? ` (${Math.round((provider.codexOAuthCredentialsExpiresAt - Date.now()) / 60000)} 分钟后)`
                        : ' (已过期)'}
                    </div>
                  )}
                  <div className="text-muted-foreground">
                    网关会在 token 过期时自动刷新。
                  </div>
                </div>
              )}

              {/* 编辑模式：目标模型与推理力度（由网关映射到上游请求） */}
              {!isCreate && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <SettingsField
                    label="模型"
                    htmlFor="codex-model-select"
                    description="SDK 请求的 Claude 模型名会由网关统一映射为此模型。"
                  >
                    <NativeSelect
                      id="codex-model-select"
                      value={codexModel}
                      onChange={(e) => {
                        const nextModel = e.target.value;
                        setCodexModel(nextModel);
                        const nextModelEntry = codexCatalog.models.find(
                          (option) => option.value === nextModel,
                        );
                        const nextEfforts =
                          nextModelEntry?.efforts ?? CODEX_FULL_EFFORTS;
                        if (!nextEfforts.includes(codexEffort)) {
                          // 归位优先该模型自己的上游默认档，缺省用全局默认。
                          const nextDefault =
                            nextModelEntry?.defaultEffort ??
                            codexCatalog.defaultEffort;
                          setCodexEffort(
                            nextEfforts.includes(nextDefault)
                              ? nextDefault
                              : nextEfforts[0],
                          );
                        }
                      }}
                      disabled={saving}
                      className="w-full font-mono"
                    >
                      {codexModelChoices.map((m) => (
                        <NativeSelectOption key={m.value} value={m.value}>
                          {m.value === codexCatalog.defaultModel
                            ? `${m.label}·默认`
                            : m.label}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </SettingsField>
                  <SettingsField
                    label="推理力度"
                    htmlFor="codex-effort-select"
                    description="对应上游 reasoning.effort，越高越慢但推理越深。"
                  >
                    <NativeSelect
                      id="codex-effort-select"
                      value={codexEffort}
                      onChange={(e) => setCodexEffort(e.target.value)}
                      disabled={saving}
                      className="w-full font-mono"
                    >
                      {codexEffortChoices.map((effort) => (
                        <NativeSelectOption key={effort} value={effort}>
                          {effort ===
                          (selectedCodexModel?.defaultEffort ??
                            codexCatalog.defaultEffort)
                            ? `${effort}（默认）`
                            : effort}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </SettingsField>
                </div>
              )}

              {!oauthState ? (
                <Button
                  variant={isCreate ? 'default' : 'outline'}
                  onClick={handleCodexOAuthStart}
                  disabled={saving || oauthLoading}
                >
                  {oauthLoading ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <ExternalLink />
                  )}
                  {!isCreate && provider?.hasCodexOAuthCredentials
                    ? '重新登录 ChatGPT'
                    : '登录 ChatGPT'}
                </Button>
              ) : (
                <div className="space-y-2">
                  <div className="rounded-lg bg-warning/10 px-3 py-2 text-caption leading-5 text-warning">
                    授权窗口已打开，请在 ChatGPT
                    完成登录授权后，将跳转页面的完整地址粘贴到下方。
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="text"
                      value={oauthCode}
                      onChange={(e) => setOauthCode(e.target.value)}
                      disabled={oauthExchanging}
                      placeholder="粘贴 localhost:1455 回调完整地址"
                      aria-label="粘贴 localhost:1455 回调完整地址"
                      className="flex-1"
                    />
                    <Button
                      variant={isCreate ? 'default' : 'outline'}
                      onClick={handleCodexOAuthCallback}
                      disabled={oauthExchanging || !oauthCode.trim()}
                    >
                      {oauthExchanging && <Loader2 className="animate-spin" />}
                      确认
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setOauthState(null);
                        setOauthCode('');
                      }}
                    >
                      取消
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ─── 第三方模式 ─── */}
          {providerType === 'third_party' && (
            <div className="space-y-4">
              <ProviderEnvImportPanel disabled={saving} onApply={applyImport} />

              <SettingsField
                label={<FieldLabel text="API 端点" hint="ANTHROPIC_BASE_URL" />}
                htmlFor="provider-base-url"
                description={
                  baseUrlProblem ? (
                    <span className="flex gap-1.5 text-warning">
                      <TriangleAlert
                        className="mt-0.5 size-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      {baseUrlProblem}
                    </span>
                  ) : (
                    '填写 Anthropic 兼容接口的地址，或点选常用服务商。'
                  )
                }
              >
                <div
                  className="flex flex-wrap gap-1.5"
                  role="group"
                  aria-label="常用服务商"
                >
                  {PROVIDER_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => applyPreset(preset)}
                      disabled={saving}
                      aria-pressed={baseUrl.trim() === preset.baseUrl}
                      className="inline-flex h-7 items-center rounded-md px-2 text-caption text-muted-foreground ring-1 ring-surface-border transition-colors duration-100 hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none aria-pressed:bg-surface-selected aria-pressed:text-foreground pointer-coarse:h-9"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <Input
                  id="provider-base-url"
                  type="url"
                  inputMode="url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  disabled={saving}
                  placeholder="https://api.example.com/anthropic"
                  autoComplete="off"
                  aria-invalid={baseUrlProblem ? true : undefined}
                />
              </SettingsField>

              <SettingsField
                label={
                  <FieldLabel
                    text="API 密钥"
                    hint={
                      !isCreate && provider?.hasAnthropicAuthToken
                        ? `当前 ${provider.anthropicAuthTokenMasked}`
                        : authMode === 'x-api-key'
                          ? 'ANTHROPIC_API_KEY'
                          : 'ANTHROPIC_AUTH_TOKEN'
                    }
                  />
                }
                htmlFor="provider-auth-token"
              >
                <Input
                  id="provider-auth-token"
                  type="password"
                  value={authToken}
                  onChange={(e) => {
                    setAuthToken(e.target.value);
                    setAuthTokenDirty(true);
                    setClearTokenOnSave(false);
                  }}
                  disabled={saving || clearTokenOnSave}
                  placeholder={
                    isCreate
                      ? '输入 API 密钥'
                      : provider?.hasAnthropicAuthToken
                        ? '留空保留当前密钥；输入新值覆盖'
                        : '输入 API 密钥'
                  }
                  autoComplete="new-password"
                />
                {!isCreate && provider?.hasAnthropicAuthToken && (
                  <label
                    htmlFor="provider-clear-auth-token"
                    className="flex min-h-8 w-fit cursor-pointer items-center gap-2 text-caption text-muted-foreground"
                  >
                    <Checkbox
                      id="provider-clear-auth-token"
                      checked={clearTokenOnSave}
                      onCheckedChange={(next) => {
                        const checked = next === true;
                        setClearTokenOnSave(checked);
                        if (checked) {
                          setAuthToken('');
                          setAuthTokenDirty(false);
                        }
                      }}
                      disabled={saving}
                    />
                    保存时清空当前密钥
                  </label>
                )}
              </SettingsField>

              <SettingsField
                label="认证方式"
                description={
                  authMode === 'x-api-key'
                    ? '以 x-api-key 请求头发送，等同 ANTHROPIC_API_KEY。'
                    : authMode === 'bearer'
                      ? '以 Authorization: Bearer 发送，等同 ANTHROPIC_AUTH_TOKEN，大多数服务商和 alias 用这种方式。'
                      : '旧配置沿用原规则：密钥以 Bearer 开头时用 Authorization，否则用 x-api-key。选择一种即可固定下来。'
                }
              >
                <SegmentedControl
                  label="认证方式"
                  value={authMode}
                  onChange={setAuthMode}
                  options={[
                    { value: 'bearer', label: 'Bearer' },
                    { value: 'x-api-key', label: 'x-api-key' },
                    ...(authMode === 'legacy'
                      ? [{ value: 'legacy' as const, label: '自动（旧规则）' }]
                      : []),
                  ]}
                />
              </SettingsField>

              <SettingsField
                label={<FieldLabel text="模型名称" hint="ANTHROPIC_MODEL" />}
                htmlFor="provider-model"
                description="留空表示透传：Claude Code 继续请求 Claude 模型名，由中转站自行路由。"
              >
                <Input
                  id="provider-model"
                  type="text"
                  value={model}
                  onChange={(e) => handleModelChange(e.target.value)}
                  disabled={saving}
                  placeholder="例如 glm-5.3、kimi-for-coding、deepseek-v4-pro"
                  autoComplete="off"
                />
              </SettingsField>

              <div className="divide-y divide-surface-border rounded-lg ring-1 ring-surface-border">
                <div className="flex items-center justify-between gap-4 px-3 py-2.5">
                  <label
                    htmlFor="provider-one-million-context"
                    className="min-w-0 cursor-pointer"
                  >
                    <span className="block text-label text-foreground">
                      1M 上下文
                    </span>
                    <span className="mt-0.5 block text-caption text-muted-foreground">
                      自动添加 [1m]；粘贴带 [1m] 的模型名会自动打开
                    </span>
                  </label>
                  <Switch
                    id="provider-one-million-context"
                    checked={oneMillionContext}
                    onCheckedChange={setOneMillionContext}
                    disabled={saving || !model.trim()}
                    aria-label="启用 1M 上下文"
                  />
                </div>

                <div className="flex items-start gap-2.5 px-3 py-2.5">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                  <div className="min-w-0">
                    <div className="text-label text-foreground">
                      系统预填 Claude Code 运行环境
                    </div>
                    <p className="mt-1 text-caption leading-5 text-muted-foreground">
                      实际模型：
                      <code className="break-all font-mono font-medium text-foreground">
                        {buildProviderModel(model, oneMillionContext) ||
                          '透传 Claude 模型名'}
                      </code>
                      {' · '}
                      压缩窗口：
                      {Number(effectiveCompactWindow).toLocaleString(
                        'en-US',
                      )}{' '}
                      tokens
                    </p>
                    <p className="mt-0.5 text-caption leading-5 text-faint-foreground">
                      默认同步 Opus / Sonnet / Haiku / 子 Agent
                      模型映射、压缩窗口、请求超时与兼容参数；可在高级设置中调整。
                    </p>
                  </div>
                </div>
              </div>

              {testResult && <ProviderConnectivityResult result={testResult} />}
            </div>
          )}

          {/* ─── 官方模型选择 ─── */}
          {providerType === 'official' && (
            <SettingsField
              label="模型"
              htmlFor="provider-official-model"
              description="别名自动解析为最新版本，留空使用 default。"
            >
              <NativeSelect
                id="provider-official-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={saving}
                className="w-full font-mono"
              >
                {/* prettier-ignore */}
                <NativeSelectOption value="">default（默认）</NativeSelectOption>
                <NativeSelectOption value="opus">opus</NativeSelectOption>
                <NativeSelectOption value="sonnet">sonnet</NativeSelectOption>
                <NativeSelectOption value="haiku">haiku</NativeSelectOption>
                <NativeSelectOption value="fable">fable</NativeSelectOption>
              </NativeSelect>
            </SettingsField>
          )}

          {/* ─── 环境变量 ─── */}
          {providerType !== 'codex' && (
            <details className="group/env overflow-hidden rounded-lg ring-1 ring-surface-border">
              <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 text-label text-foreground outline-none transition-colors duration-100 select-none hover:bg-surface-hover focus-visible:bg-surface-hover [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-open/env:rotate-90"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">
                  {providerType === 'third_party'
                    ? '高级设置 · 环境变量'
                    : '高级设置 · 自定义环境变量'}
                </span>
                {providerType === 'third_party' && (
                  <span className="shrink-0 text-caption text-muted-foreground">
                    {defaultProviderEnv.length} 项默认配置
                  </span>
                )}
                {customEnvRows.length > 0 && (
                  <span className="shrink-0 text-caption text-muted-foreground">
                    {customEnvRows.length} 项自定义
                  </span>
                )}
              </summary>

              <div className="space-y-5 border-t border-surface-border px-3 py-4">
                {providerType === 'third_party' && (
                  <section aria-labelledby="default-provider-env-heading">
                    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                      <div>
                        <h3
                          id="default-provider-env-heading"
                          className="text-label text-foreground"
                        >
                          系统预填环境变量
                        </h3>
                        <p className="mt-0.5 text-caption leading-5 text-muted-foreground">
                          默认值会随模型和上下文更新；修改后以你的自定义值为准。
                        </p>
                      </div>
                      <Badge variant="neutral">
                        {defaultProviderEnv.length} 项
                      </Badge>
                    </div>

                    <div className="divide-y divide-surface-border overflow-hidden rounded-lg ring-1 ring-surface-border">
                      {defaultProviderEnv.map((row, index) => {
                        const hasOverride = Object.hasOwn(
                          providerEnvOverrides,
                          row.key,
                        );
                        const value = hasOverride
                          ? providerEnvOverrides[row.key]
                          : row.value;
                        const inputId = `provider-env-default-${index}`;

                        return (
                          <div
                            key={row.key}
                            className="grid min-w-0 gap-2 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.8fr)] sm:items-center sm:gap-4"
                          >
                            <div className="flex min-w-0 items-center justify-between gap-2">
                              <label
                                htmlFor={inputId}
                                className="min-w-0 font-mono text-micro break-words text-foreground"
                              >
                                <EnvKey name={row.key} />
                              </label>
                              <Badge
                                variant={hasOverride ? 'info' : 'outline'}
                                className="shrink-0"
                              >
                                {hasOverride
                                  ? '已自定义'
                                  : MANAGED_ENV_SOURCE_LABELS[row.source]}
                              </Badge>
                            </div>
                            <div className="flex min-w-0 items-center gap-1">
                              <Input
                                id={inputId}
                                type="text"
                                value={value}
                                onChange={(event) =>
                                  updateProviderEnv(
                                    row.key,
                                    event.target.value,
                                    row.value,
                                  )
                                }
                                disabled={saving}
                                placeholder={
                                  row.source === 'model'
                                    ? '跟随 Claude Code 默认（透传）'
                                    : '使用默认值'
                                }
                                autoComplete="off"
                                className="min-w-0 font-mono text-caption md:text-caption"
                              />
                              {hasOverride && (
                                <IconButton
                                  label="恢复默认值"
                                  aria-label={`恢复 ${row.key} 的默认值`}
                                  icon={<RotateCcw />}
                                  onClick={() => resetProviderEnv(row.key)}
                                  disabled={saving}
                                  className="pointer-coarse:size-11"
                                />
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}

                <section
                  aria-labelledby="custom-provider-env-heading"
                  className={
                    providerType === 'third_party'
                      ? 'border-t border-surface-border pt-4'
                      : undefined
                  }
                >
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <div>
                      <h3
                        id="custom-provider-env-heading"
                        className="text-label text-foreground"
                      >
                        自定义环境变量
                      </h3>
                      <p className="mt-0.5 text-caption leading-5 text-muted-foreground">
                        用于
                        ANTHROPIC_CUSTOM_HEADERS、CLAUDE_CODE_MAX_CONTEXT_TOKENS
                        等特殊需求。
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={addRow}
                      className="shrink-0 pointer-coarse:min-h-11"
                    >
                      <Plus />
                      添加
                    </Button>
                  </div>

                  {customProxyKeys.length > 0 && (
                    <p className="mb-2 flex gap-1.5 text-caption leading-5 text-warning">
                      <TriangleAlert
                        className="mt-0.5 size-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      {customProxyKeys.join('、')}
                      会作用于 Agent 的全部网络请求（包括 Bash 和
                      MCP）；Container 模式下 127.0.0.1
                      指向容器自身。建议改在系统或工作区层面配置代理。
                    </p>
                  )}
                  {customEnvRows.length === 0 ? (
                    <p className="text-caption text-muted-foreground">
                      没有自定义环境变量，大多数配置无需添加。
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {customEnvRows.map((row, idx) => (
                        <div
                          key={idx}
                          className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center"
                        >
                          <Input
                            type="text"
                            value={row.key}
                            onChange={(e) =>
                              updateRow(idx, 'key', e.target.value)
                            }
                            placeholder="KEY"
                            aria-label={`第 ${idx + 1} 行环境变量 Key`}
                            className="w-full font-mono text-caption sm:w-[38%] md:text-caption"
                          />
                          <div className="flex min-w-0 flex-1 items-center gap-1">
                            {row.key.trim() === 'ANTHROPIC_CUSTOM_HEADERS' ? (
                              // Claude Code reads one `Name: value` per line.
                              <Textarea
                                value={row.value}
                                onChange={(e) =>
                                  updateRow(idx, 'value', e.target.value)
                                }
                                rows={2}
                                spellCheck={false}
                                placeholder={'X-Header: value\nX-Other: value'}
                                aria-label={`第 ${idx + 1} 行环境变量值`}
                                className="min-h-9 min-w-0 flex-1 font-mono text-caption md:text-caption"
                              />
                            ) : (
                              <Input
                                type={
                                  showCustomEnvValues[idx] ? 'text' : 'password'
                                }
                                value={row.value}
                                onChange={(e) =>
                                  updateRow(idx, 'value', e.target.value)
                                }
                                placeholder="value"
                                aria-label={`第 ${idx + 1} 行环境变量值`}
                                className="min-w-0 flex-1 font-mono text-caption md:text-caption"
                              />
                            )}
                            <IconButton
                              label={
                                showCustomEnvValues[idx]
                                  ? '隐藏环境变量值'
                                  : '显示环境变量值'
                              }
                              icon={
                                showCustomEnvValues[idx] ? <EyeOff /> : <Eye />
                              }
                              onClick={() =>
                                setShowCustomEnvValues((current) => ({
                                  ...current,
                                  [idx]: !current[idx],
                                }))
                              }
                            />
                            <IconButton
                              label="删除环境变量"
                              icon={<X />}
                              onClick={() => removeRow(idx)}
                              className="hover:text-destructive"
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            </details>
          )}
        </div>

        {/* ─── 操作按钮 ─── */}
        <DialogFooter>
          {providerType === 'third_party' && (
            <Button
              variant="ghost"
              onClick={() => void handleTestConnection()}
              disabled={saving || testing || !baseUrl.trim()}
              className="sm:mr-auto"
            >
              {testing ? <Loader2 className="animate-spin" /> : <PlugZap />}
              测试连接
            </Button>
          )}
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={saving || oauthExchanging}
          >
            取消
          </Button>
          {/* OAuth 模式下创建时不需要保存按钮（OAuth 回调会自动触发 onSave） */}
          {!(isCreate && providerType === 'codex') && (
            <Button onClick={handleSave} disabled={saving || oauthExchanging}>
              {saving && <Loader2 className="animate-spin" />}
              {isCreate ? '创建' : '保存'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Env var name that wraps after underscores instead of mid-word. */
function EnvKey({ name }: { name: string }) {
  const parts = name.split('_');
  return parts.map((part, index) => (
    <Fragment key={index}>
      {part}
      {index < parts.length - 1 && (
        <>
          _<wbr />
        </>
      )}
    </Fragment>
  ));
}

function FieldLabel({ text, hint }: { text: string; hint: string }) {
  return (
    <span className="flex items-center justify-between gap-3">
      <span>{text}</span>
      <span className="truncate font-mono text-micro font-normal text-faint-foreground">
        {hint}
      </span>
    </span>
  );
}
