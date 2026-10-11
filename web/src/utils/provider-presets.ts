/**
 * Anthropic-compatible endpoints of common model vendors. Only public base
 * URLs live here — never keys — and the model is a starting suggestion,
 * because vendor model names change faster than this list.
 */
export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  oneMillionContext: boolean;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'kimi',
    label: 'Kimi',
    baseUrl: 'https://api.kimi.com/coding/',
    model: 'kimi-for-coding',
    oneMillionContext: true,
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    model: 'glm-5.3',
    oneMillionContext: true,
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    model: 'MiniMax-M3',
    oneMillionContext: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-v4-pro',
    oneMillionContext: true,
  },
  {
    id: 'ark',
    label: '火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    model: 'doubao-seed-2.1-turbo',
    oneMillionContext: false,
  },
  {
    id: 'aliyun',
    label: '阿里云',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    model: 'qwen3.7-max',
    oneMillionContext: true,
  },
  {
    id: 'mimo',
    label: '小米 MiMo',
    baseUrl: 'https://api.xiaomimimo.com/anthropic',
    model: 'mimo-v2.5-pro',
    oneMillionContext: true,
  },
  {
    id: 'stepfun',
    label: '阶跃星辰',
    baseUrl: 'https://api.stepfun.com/step_plan',
    model: 'step-3.7-flash',
    oneMillionContext: false,
  },
];

/** Warn about endpoint paths Claude Code would turn into `/v1/v1/messages`. */
export function describeBaseUrlProblem(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '请输入完整的 http(s):// 地址';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '只支持 http(s) 地址';
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  if (/\/v1\/messages$/i.test(path) || /\/v1$/i.test(path)) {
    return 'Claude Code 会自动追加 /v1/messages，端点通常不应以 /v1 或 /v1/messages 结尾';
  }
  return null;
}
