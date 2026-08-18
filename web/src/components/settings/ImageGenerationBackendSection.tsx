import { useEffect, useState } from 'react';
import { ImageIcon, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '../../api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getErrorMessage } from './types';
import { SettingsCard as Section } from './SettingsCard';

interface ImageGenerationBackendConfig {
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyMasked: string;
  defaultModel: string;
  updatedAt: string;
}

/**
 * Admin-only: the one OpenAI-compatible baseUrl+apiKey shared by every
 * Workspace that turns its own image generation switch on (see the
 * "生图能力" toggle in the workspace settings dialog). This is a platform
 * capability, not a per-user credential, so it lives in system settings
 * rather than Provider config.
 */
export function ImageGenerationBackendSection() {
  const [config, setConfig] = useState<ImageGenerationBackendConfig | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');

  const load = () => {
    setLoading(true);
    api
      .get<ImageGenerationBackendConfig>('/api/config/image-generation')
      .then((res) => {
        setConfig(res);
        setBaseUrl(res.baseUrl);
      })
      .catch((err) => toast.error(getErrorMessage(err, '加载生图后端配置失败')))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleSave = async () => {
    const trimmedBaseUrl = baseUrl.trim();
    const trimmedApiKey = apiKey.trim();
    if (!trimmedBaseUrl) {
      toast.error('请填写 baseUrl');
      return;
    }
    if (!trimmedApiKey && !config?.hasApiKey) {
      toast.error('请填写 API Key');
      return;
    }
    setSaving(true);
    try {
      const saved = await api.put<ImageGenerationBackendConfig>(
        '/api/config/image-generation',
        {
          baseUrl: trimmedBaseUrl,
          // Omit a blank field. The server preserves the secret internally;
          // the masked value is presentation-only and is never a credential.
          ...(trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
        },
      );
      setConfig(saved);
      setBaseUrl(saved.baseUrl);
      setApiKey('');
      toast.success('生图后端配置已保存');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      icon={ImageIcon}
      title="生图能力"
      desc="配置平台共享的 OpenAI 兼容生图后端；工作区在“工作区设置”中各自开关，无需重复安装 Skill。"
    >
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          加载中…
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="image-gen-base-url">Base URL</Label>
            <Input
              id="image-gen-base-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://your-openai-compatible-endpoint/v1"
              disabled={saving}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="image-gen-api-key">API Key</Label>
            <Input
              id="image-gen-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={config?.hasApiKey ? config.apiKeyMasked : '尚未配置'}
              disabled={saving}
            />
            <p className="text-xs text-muted-foreground">
              留空则保留当前已保存的 Key，只更新 Base URL。
            </p>
          </div>
          <div className="flex items-center justify-between pt-1">
            <p className="text-xs text-muted-foreground">
              默认模型：{config?.defaultModel ?? 'gpt-image-2'}
              {config?.updatedAt
                ? ` · 上次更新 ${new Date(config.updatedAt).toLocaleString()}`
                : ''}
            </p>
            <Button
              type="button"
              size="sm"
              onClick={() => void handleSave()}
              disabled={saving}
              aria-busy={saving}
            >
              {saving && (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              )}
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </>
      )}
    </Section>
  );
}
