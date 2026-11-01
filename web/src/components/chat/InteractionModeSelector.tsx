import { Bot, CircleCheck, MessagesSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { InteractionMode } from '../../types';

interface InteractionModeSelectorProps {
  value: InteractionMode;
  onChange: (value: InteractionMode) => void;
  disabled?: boolean;
  name: string;
  description?: string;
  compact?: boolean;
}

const OPTIONS: Array<{
  value: InteractionMode;
  title: string;
  description: string;
  icon: typeof Bot;
}> = [
  {
    value: 'assistant',
    title: 'Assistant 模式（推荐）',
    description:
      '任务完成后由框架交付一条主回复。Web 可实时展示过程，飞书等渠道按能力使用流式卡片或消息气泡。',
    icon: Bot,
  },
  {
    value: 'proactive',
    title: '主动模式',
    description:
      '智能体在处理过程中主动发消息；每次发送立即形成一条独立消息，一轮可以发送多条。身份与语气仍由智能体配置决定。',
    icon: MessagesSquare,
  },
];

export function InteractionModeSelector({
  value,
  onChange,
  disabled = false,
  name,
  description = '选择由框架在任务结束时交付一条主回复，还是由智能体在处理过程中主动发出多条消息。身份、Skills、记忆与渠道响应范围不变。',
  compact = false,
}: InteractionModeSelectorProps) {
  return (
    <fieldset disabled={disabled}>
      <legend className="text-sm font-medium text-foreground">
        工作区回复模式
      </legend>
      <p
        className={cn(
          'mt-1 text-xs text-muted-foreground',
          !compact && 'leading-5',
        )}
      >
        {description}
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {OPTIONS.map((option) => {
          const Icon = option.icon;
          const selected = value === option.value;
          return (
            <label
              key={option.value}
              title={compact ? option.description : undefined}
              className={cn(
                'relative block min-w-0 cursor-pointer rounded-lg border bg-background transition-colors',
                compact ? 'p-2' : 'p-3',
                'hover:border-foreground/25 hover:bg-muted/30',
                disabled && 'cursor-not-allowed opacity-60',
                selected ? 'border-primary bg-primary/5' : 'border-border/80',
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={selected}
                onChange={() => onChange(option.value)}
                className="peer sr-only"
              />
              <span className="pointer-events-none absolute inset-0 rounded-lg peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2" />
              {selected && (
                <CircleCheck
                  aria-hidden="true"
                  className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-primary"
                />
              )}
              <span
                className={cn(
                  'flex items-start',
                  compact ? 'gap-2' : 'gap-2.5',
                )}
              >
                <Icon
                  aria-hidden="true"
                  className={cn(
                    compact
                      ? 'mt-0.5 h-3.5 w-3.5 shrink-0'
                      : 'mt-0.5 h-4 w-4 shrink-0',
                    selected ? 'text-primary' : 'text-muted-foreground',
                  )}
                />
                <span className="min-w-0">
                  <span
                    className={cn(
                      'block pr-6 font-medium text-foreground',
                      compact ? 'text-xs' : 'text-sm',
                    )}
                  >
                    {option.title}
                  </span>
                  {!compact && (
                    <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
