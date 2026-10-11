import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, Cpu, Loader2, Settings2 } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api } from '../../api/client';
import { useAuthStore } from '../../stores/auth';

export interface SessionModelOption {
  id: string;
  name: string;
  kind: 'official' | 'third_party' | 'codex';
  enabled: boolean;
  model: string;
}

export interface SessionModelSelection {
  selectedModelConfigId: string | null;
  default: {
    source: 'agent' | 'single' | 'pool' | 'workspace_env' | 'none';
    modelConfigId: string | null;
    enabledCount: number;
  };
  options: SessionModelOption[];
}

const DEFAULT_VALUE = '__default__';

const KIND_LABELS: Record<SessionModelOption['kind'], string> = {
  official: 'Claude 官方',
  codex: 'ChatGPT 订阅',
  third_party: '兼容接口',
};

/** Human label for "what the default resolves to" in this conversation. */
export function describeDefaultModel(selection: SessionModelSelection): string {
  const { source, modelConfigId, enabledCount } = selection.default;
  const named = selection.options.find((option) => option.id === modelConfigId);
  switch (source) {
    case 'agent':
    case 'single':
      return named?.name ?? '默认';
    case 'pool':
      return `自动 · ${enabledCount} 个`;
    case 'workspace_env':
      return '工作区环境变量';
    default:
      return '系统默认';
  }
}

function defaultHint(selection: SessionModelSelection): string {
  switch (selection.default.source) {
    case 'agent':
      return '跟随智能体绑定的模型配置';
    case 'pool':
      return '在已启用的模型配置间自动选择';
    case 'workspace_env':
      return '使用工作区环境变量中的模型网关';
    case 'single':
      return '使用唯一启用的模型配置';
    default:
      return '使用系统设置';
  }
}

interface ModelSelectorProps {
  groupJid: string;
  /** Runtime Session id; null addresses the main conversation. */
  agentId: string | null;
  canChange: boolean;
}

export function ModelSelector({
  groupJid,
  agentId,
  canChange,
}: ModelSelectorProps) {
  const navigate = useNavigate();
  const canManageModels = useAuthStore((s) =>
    s.hasPermission('manage_system_config'),
  );
  const [selection, setSelection] = useState<SessionModelSelection | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const basePath = `/api/groups/${encodeURIComponent(groupJid)}/model-selection`;

  const load = useCallback(async () => {
    const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
    try {
      setSelection(await api.get<SessionModelSelection>(`${basePath}${query}`));
    } catch {
      // Older server or no access: the picker simply stays hidden.
      setSelection(null);
    }
  }, [agentId, basePath]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleChange = async (value: string) => {
    if (!selection || saving) return;
    const modelConfigId = value === DEFAULT_VALUE ? null : value;
    if (modelConfigId === selection.selectedModelConfigId) return;
    setSaving(true);
    try {
      const next = await api.put<SessionModelSelection>(basePath, {
        agentId,
        modelConfigId,
      });
      setSelection(next);
      const picked = next.options.find((option) => option.id === modelConfigId);
      toast.success(
        picked
          ? `已切换到「${picked.name}」，从下一条消息开始生效`
          : '已恢复默认模型，从下一条消息开始生效',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '切换模型失败');
      void load();
    } finally {
      setSaving(false);
    }
  };

  if (!selection || selection.options.length === 0) return null;

  const selected = selection.options.find(
    (option) => option.id === selection.selectedModelConfigId,
  );
  const triggerLabel = selected
    ? selected.name
    : `默认 · ${describeDefaultModel(selection)}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={!canChange || saving}
          aria-label={`模型：${triggerLabel}`}
          title={canChange ? '选择本会话使用的模型' : `模型：${triggerLabel}`}
          className={cn(
            'ml-0.5 inline-flex h-7 max-w-[min(46vw,220px)] min-w-0 cursor-pointer items-center gap-1 rounded-md px-2 text-micro font-medium text-muted-foreground transition-colors duration-100 hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted-foreground pointer-coarse:h-10',
            selected && 'text-foreground',
          )}
        >
          {saving ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
          ) : (
            <Cpu className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{triggerLabel}</span>
          {canChange && <ChevronDown className="size-3 shrink-0 opacity-60" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        className="w-72 max-w-[calc(100vw-2rem)]"
      >
        <DropdownMenuLabel>本会话使用的模型</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={selection.selectedModelConfigId ?? DEFAULT_VALUE}
          onValueChange={(value) => void handleChange(value)}
        >
          <DropdownMenuRadioItem value={DEFAULT_VALUE}>
            <span className="min-w-0">
              <span className="block truncate">
                默认 · {describeDefaultModel(selection)}
              </span>
              <span className="block truncate text-micro text-muted-foreground">
                {defaultHint(selection)}
              </span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {selection.options.map((option) => (
            <DropdownMenuRadioItem key={option.id} value={option.id}>
              <span className="min-w-0">
                <span className="block truncate">{option.name}</span>
                <span className="block truncate text-micro text-muted-foreground">
                  {KIND_LABELS[option.kind]}
                  {option.model ? ` · ${option.model}` : ''}
                  {option.enabled ? '' : ' · 未启用'}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <p className="px-2 py-1 text-micro leading-4 text-muted-foreground">
          切换到不同的模型配置会开启新的底层会话，并自动带上最近的对话记录。
        </p>
        {canManageModels && (
          <DropdownMenuItem onClick={() => navigate('/settings?tab=claude')}>
            <Settings2 />
            管理模型配置
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
