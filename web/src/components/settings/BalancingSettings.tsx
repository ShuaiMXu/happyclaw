import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Input } from '@/components/ui/input';
import type { BalancingConfig } from './types';

interface BalancingSettingsProps {
  balancing: BalancingConfig;
  onChange: (updates: Partial<BalancingConfig>) => void;
  disabled: boolean;
  saving: boolean;
}

function clampInteger(
  value: string,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number.parseInt(value, 10);
  return Math.max(
    min,
    Math.min(max, Number.isFinite(parsed) ? parsed : fallback),
  );
}

export function BalancingSettings({
  balancing,
  onChange,
  disabled,
  saving,
}: BalancingSettingsProps) {
  const [expanded, setExpanded] = useState(false);
  const [unhealthyDraft, setUnhealthyDraft] = useState(
    String(balancing.unhealthyThreshold),
  );
  const [recoveryDraft, setRecoveryDraft] = useState(
    String(Math.round(balancing.recoveryIntervalMs / 1000)),
  );

  useEffect(() => {
    setUnhealthyDraft(String(balancing.unhealthyThreshold));
  }, [balancing.unhealthyThreshold]);

  useEffect(() => {
    setRecoveryDraft(String(Math.round(balancing.recoveryIntervalMs / 1000)));
  }, [balancing.recoveryIntervalMs]);

  const commitUnhealthyThreshold = () => {
    const next = clampInteger(
      unhealthyDraft,
      balancing.unhealthyThreshold,
      1,
      20,
    );
    setUnhealthyDraft(String(next));
    if (next !== balancing.unhealthyThreshold) {
      onChange({ unhealthyThreshold: next });
    }
  };

  const commitRecoveryInterval = () => {
    const currentSeconds = Math.round(balancing.recoveryIntervalMs / 1000);
    const nextSeconds = clampInteger(recoveryDraft, currentSeconds, 30, 3600);
    setRecoveryDraft(String(nextSeconds));
    if (nextSeconds !== currentSeconds) {
      onChange({ recoveryIntervalMs: nextSeconds * 1000 });
    }
  };

  return (
    <div
      className="border border-border rounded-lg overflow-hidden"
      aria-busy={saving}
    >
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 bg-muted/50 hover:bg-muted transition-colors cursor-pointer"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls="balancing-settings-panel"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">负载均衡设置</span>
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-teal-100 text-teal-800">
            {balancing.strategy === 'round-robin'
              ? '轮询'
              : balancing.strategy === 'weighted-round-robin'
                ? '加权轮询'
                : '故障转移'}
          </span>
        </div>
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div
          id="balancing-settings-panel"
          className="p-4 space-y-4"
          role="region"
          aria-label="负载均衡设置"
        >
          <div className="text-xs text-muted-foreground mb-2">
            启用多个提供商后，系统会根据以下策略自动分配会话请求。
          </div>

          {/* 策略选择 */}
          <div>
            <label
              htmlFor="balancing-strategy"
              className="text-sm font-medium block mb-1"
            >
              策略
            </label>
            <select
              id="balancing-strategy"
              className="w-full border border-border rounded-md px-3 py-1.5 text-sm bg-background"
              value={balancing.strategy}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  strategy: e.target.value as BalancingConfig['strategy'],
                })
              }
            >
              <option value="round-robin">轮询</option>
              <option value="weighted-round-robin">加权轮询</option>
              <option value="failover">故障转移</option>
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              {balancing.strategy === 'round-robin'
                ? '按顺序轮流分配给每个启用的提供商'
                : balancing.strategy === 'weighted-round-robin'
                  ? '根据提供商的权重值按比例分配请求'
                  : '优先使用第一个健康的提供商，失败时自动切换到下一个'}
            </p>
            {balancing.strategy === 'weighted-round-robin' && (
              <div className="mt-2 px-3 py-2 rounded-md border border-teal-200 dark:border-teal-900/40 bg-teal-50 dark:bg-teal-950/30 text-xs text-teal-800 dark:text-teal-300">
                💡
                上方提供商列表已显示每家的「权重」徽标。点击对应提供商的「编辑」按钮可调整。
                所有提供商默认权重为 1（均匀分配），调整权重后流量按比例分配。
              </div>
            )}
          </div>

          {/* 高级参数 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="balancing-unhealthy-threshold"
                className="text-xs text-muted-foreground block mb-1"
              >
                不健康阈值（连续失败次数）
              </label>
              <Input
                id="balancing-unhealthy-threshold"
                type="number"
                min={1}
                max={20}
                value={unhealthyDraft}
                disabled={disabled}
                onChange={(e) => setUnhealthyDraft(e.target.value)}
                onBlur={commitUnhealthyThreshold}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                className="h-8 text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                连续失败达到该次数后，提供商标记为不健康。
              </p>
            </div>
            <div>
              <label
                htmlFor="balancing-recovery-interval"
                className="text-xs text-muted-foreground block mb-1"
              >
                自动恢复间隔（秒）
              </label>
              <Input
                id="balancing-recovery-interval"
                type="number"
                min={30}
                max={3600}
                value={recoveryDraft}
                disabled={disabled}
                onChange={(e) => setRecoveryDraft(e.target.value)}
                onBlur={commitRecoveryInterval}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                className="h-8 text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                不健康提供商经过该时间后自动恢复为健康状态，重新接受请求。
              </p>
            </div>
          </div>
          {saving && (
            <p className="text-xs text-muted-foreground" role="status">
              正在保存负载均衡设置…
            </p>
          )}
        </div>
      )}
    </div>
  );
}
