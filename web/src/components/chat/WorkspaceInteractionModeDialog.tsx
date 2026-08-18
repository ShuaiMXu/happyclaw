import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { api } from '../../api/client';
import type { InteractionMode } from '../../types';
import { InteractionModeSelector } from './InteractionModeSelector';

const DEFAULT_OPTION = '__default__';

type ImageGenerationModel = 'gpt-image-1.5' | 'gpt-image-2';

interface ProviderOption {
  id: string;
  name: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
}

interface ImageGenerationOptions {
  configured: boolean;
  models: ImageGenerationModel[];
}

interface WorkspaceInteractionModeDialogProps {
  open: boolean;
  workspaceName: string;
  currentMode: InteractionMode;
  currentLockedModelId?: string | null;
  currentImageGenerationEnabled?: boolean;
  currentImageGenerationModel?: ImageGenerationModel | null;
  onClose: () => void;
  onSave: (
    mode: InteractionMode,
    lockedModelConfigId: string | null,
    imageGeneration?: {
      enabled: boolean;
      model: ImageGenerationModel | null;
    },
  ) => Promise<boolean>;
}

export function WorkspaceInteractionModeDialog({
  open,
  workspaceName,
  currentMode,
  currentLockedModelId,
  currentImageGenerationEnabled,
  currentImageGenerationModel,
  onClose,
  onSave,
}: WorkspaceInteractionModeDialogProps) {
  const [draftMode, setDraftMode] = useState(currentMode);
  const [draftLockedModel, setDraftLockedModel] = useState<string | null>(
    currentLockedModelId ?? null,
  );
  const [draftImageGenEnabled, setDraftImageGenEnabled] = useState(
    currentImageGenerationEnabled ?? false,
  );
  const [draftImageGenModel, setDraftImageGenModel] =
    useState<ImageGenerationModel>(
      currentImageGenerationModel ?? 'gpt-image-2',
    );
  const [saving, setSaving] = useState(false);
  const [options, setOptions] = useState<ProviderOption[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [imageGenOptions, setImageGenOptions] =
    useState<ImageGenerationOptions | null>(null);

  useEffect(() => {
    if (open) {
      setDraftMode(currentMode);
      setDraftLockedModel(currentLockedModelId ?? null);
      setDraftImageGenEnabled(currentImageGenerationEnabled ?? false);
      setDraftImageGenModel(currentImageGenerationModel ?? 'gpt-image-2');
      let cancelled = false;
      setOptionsLoading(true);
      api
        .get<{ providers: ProviderOption[] }>(
          '/api/config/claude/providers/options',
        )
        .then((res) => {
          if (!cancelled) setOptions(res.providers ?? []);
        })
        .catch(() => {
          if (!cancelled) setOptions([]);
        })
        .finally(() => {
          if (!cancelled) setOptionsLoading(false);
        });
      api
        .get<ImageGenerationOptions>('/api/config/image-generation/options')
        .then((res) => {
          if (!cancelled) setImageGenOptions(res);
        })
        .catch(() => {
          if (!cancelled) setImageGenOptions(null);
        });
      return () => {
        cancelled = true;
      };
    }
  }, [
    currentMode,
    currentLockedModelId,
    currentImageGenerationEnabled,
    currentImageGenerationModel,
    open,
  ]);

  // Enabled providers are directly selectable. A lock pointing at a disabled
  // provider is shown (greyed) so the owner can move off it; a lock pointing at
  // a deleted provider falls back to "default" with a warning.
  const enabledOptions = options.filter((p) => p.enabled);
  const disabledLocked = options.find(
    (p) => !p.enabled && p.id === currentLockedModelId,
  );
  const lockedMissing =
    !!currentLockedModelId &&
    options.length > 0 &&
    !options.some((p) => p.id === currentLockedModelId);

  const draftSelectValue = draftLockedModel ?? DEFAULT_OPTION;
  const lockedModelName = options.find((p) => p.id === draftLockedModel)?.name;

  const handleLockedModelChange = (value: string) => {
    setDraftLockedModel(value === DEFAULT_OPTION ? null : value);
  };

  const handleSave = async () => {
    const baselineLocked = currentLockedModelId ?? null;
    const baselineImageGenEnabled = currentImageGenerationEnabled ?? false;
    const baselineImageGenModel = currentImageGenerationModel ?? 'gpt-image-2';
    const modeChanged = draftMode !== currentMode;
    const lockChanged = draftLockedModel !== baselineLocked;
    const imageGenChanged =
      draftImageGenEnabled !== baselineImageGenEnabled ||
      (draftImageGenEnabled && draftImageGenModel !== baselineImageGenModel);
    if (!modeChanged && !lockChanged && !imageGenChanged) {
      onClose();
      return;
    }

    setSaving(true);
    try {
      const saved = await onSave(draftMode, draftLockedModel, {
        enabled: draftImageGenEnabled,
        model: draftImageGenEnabled ? draftImageGenModel : null,
      });
      if (!saved) {
        toast.error('保存失败，请重试');
        return;
      }
      const parts: string[] = [];
      if (modeChanged) {
        parts.push(
          `已切换为${draftMode === 'proactive' ? '主动模式' : 'Assistant 模式'}`,
        );
      }
      if (lockChanged) {
        parts.push(
          draftLockedModel
            ? `已锁定模型${lockedModelName ? `「${lockedModelName}」` : ''}`
            : '已切换为默认多模型按需调配',
        );
      }
      if (imageGenChanged) {
        parts.push(draftImageGenEnabled ? '已开启生图能力' : '已关闭生图能力');
      }
      toast.success(parts.join('；') || '工作区设置已更新');
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !saving) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>工作区设置</DialogTitle>
          <DialogDescription>
            设置“{workspaceName}”的回复模式与模型。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-foreground">回复模式</h3>
            <InteractionModeSelector
              value={draftMode}
              onChange={setDraftMode}
              name="workspace-interaction-mode"
              disabled={saving}
              description="同一模式会应用到该工作区的 Web、飞书和所有已绑定渠道；渠道只负责选择流式卡片、普通消息或消息气泡等具体呈现。"
            />
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium text-foreground">模型</h3>
            <Select
              value={draftSelectValue}
              onValueChange={handleLockedModelChange}
              disabled={saving || optionsLoading}
            >
              <SelectTrigger className="w-full" aria-label="工作区模型">
                <SelectValue placeholder="选择模型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_OPTION}>
                  默认（多个模型按需调配）
                </SelectItem>
                {enabledOptions.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                    {p.model ? ` · ${p.model}` : ''}
                    {p.isDefault ? '（默认）' : ''}
                  </SelectItem>
                ))}
                {disabledLocked && (
                  <SelectItem key={disabledLocked.id} value={disabledLocked.id}>
                    {disabledLocked.name}（已停用）
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            {optionsLoading && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
                正在加载模型列表…
              </p>
            )}
            {lockedMissing && (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                当前锁定的模型已被删除，保存后将切换为默认按需调配。
              </p>
            )}
            {!optionsLoading && (
              <p className="text-xs leading-5 text-muted-foreground">
                不锁定时，该工作区按系统默认在多个模型间按需调配；锁定后，工作区的所有对话都经过所选模型。
              </p>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium text-foreground">
                  生图能力
                </h3>
                <p className="text-xs leading-5 text-muted-foreground">
                  开启后，本工作区的对话可以直接生成图片，无需单独安装 Skill。
                </p>
              </div>
              <Switch
                checked={draftImageGenEnabled}
                onCheckedChange={setDraftImageGenEnabled}
                disabled={
                  saving ||
                  (imageGenOptions !== null && !imageGenOptions.configured)
                }
                aria-label="生图能力"
              />
            </div>
            {imageGenOptions && !imageGenOptions.configured && (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                管理员尚未配置生图后端，暂时无法开启；请联系管理员在系统设置中配置。
              </p>
            )}
            {draftImageGenEnabled && (
              <Select
                value={draftImageGenModel}
                onValueChange={(value) =>
                  setDraftImageGenModel(value as ImageGenerationModel)
                }
                disabled={saving}
              >
                <SelectTrigger className="w-full" aria-label="生图模型">
                  <SelectValue placeholder="选择生图模型" />
                </SelectTrigger>
                <SelectContent>
                  {(
                    imageGenOptions?.models ?? ['gpt-image-1.5', 'gpt-image-2']
                  ).map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>

        <p className="rounded-md bg-muted/60 px-3 py-2 text-xs leading-5 text-muted-foreground">
          切换会安全重启该工作区的智能体
          运行时；身份、Skills、记忆与渠道绑定保持不变。正在运行的任务会先停止，后续消息按新设置处理。
        </p>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={saving}
          >
            取消
          </Button>
          <Button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            aria-busy={saving}
          >
            {saving && (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            )}
            {saving ? '正在保存…' : '保存更改'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
