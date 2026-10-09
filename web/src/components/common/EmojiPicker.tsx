import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  FLUENT_EMOJI_CATEGORIES,
  FLUENT_EMOJI_ITEMS,
  getFluentEmojiSrc,
  isFluentEmojiToken,
  normalizeFluentEmojiCode,
} from '@/data/fluent-emoji';

export interface EmojiPickerProps {
  value?: string;
  onChange: (emoji: string) => void;
}

const EMOJI_CATEGORIES: { label: string; emojis: string[] }[] = [
  {
    label: '动物',
    emojis: [
      '🐱',
      '🐶',
      '🐭',
      '🐹',
      '🐰',
      '🦊',
      '🐻',
      '🐼',
      '🐻‍❄️',
      '🐨',
      '🐯',
      '🦁',
      '🐮',
      '🐷',
      '🐸',
      '🐵',
      '🙈',
      '🙉',
      '🙊',
      '🐒',
      '🐔',
      '🐧',
      '🐦',
      '🐤',
      '🐣',
      '🐥',
      '🦆',
      '🦅',
      '🦉',
      '🦇',
      '🐺',
      '🐗',
      '🐴',
      '🦄',
      '🐝',
      '🪱',
      '🐛',
      '🦋',
      '🐌',
      '🐞',
      '🐜',
      '🪰',
      '🪲',
      '🪳',
      '🦟',
      '🦗',
      '🕷️',
      '🦂',
      '🐢',
      '🐍',
      '🦎',
      '🦖',
      '🦕',
      '🐙',
      '🦑',
      '🦐',
      '🦞',
      '🦀',
      '🐡',
      '🐠',
      '🐟',
      '🐬',
      '🐳',
      '🐋',
      '🦈',
      '🐊',
      '🐅',
      '🐆',
      '🦓',
      '🦍',
      '🦧',
      '🐘',
      '🦛',
      '🦏',
      '🐪',
      '🐫',
      '🦒',
      '🦘',
      '🦬',
      '🐃',
      '🐂',
      '🐄',
      '🐎',
      '🐖',
      '🐏',
      '🐑',
      '🦙',
      '🐐',
      '🦌',
      '🐕',
      '🐩',
      '🦮',
      '🐕‍🦺',
      '🐈',
      '🐈‍⬛',
      '🪶',
      '🐓',
      '🦃',
      '🦤',
      '🦚',
      '🦜',
      '🦢',
      '🦩',
      '🕊️',
      '🐇',
      '🦝',
      '🦨',
      '🦡',
      '🦫',
      '🦦',
      '🦥',
      '🐁',
      '🐀',
      '🐿️',
      '🦔',
      '🐾',
      '🐉',
      '🐲',
      '🦠',
    ],
  },
  {
    label: '表情',
    emojis: [
      '😀',
      '😃',
      '😄',
      '😁',
      '😆',
      '😅',
      '🤣',
      '😂',
      '🙂',
      '😉',
      '😊',
      '😇',
      '🥰',
      '😍',
      '🤩',
      '😘',
      '😎',
      '🤓',
      '🧐',
      '🤔',
      '🤗',
      '🤭',
      '😈',
      '👻',
      '💀',
      '🤖',
      '👽',
      '👾',
      '🎃',
      '😺',
      '😸',
      '😻',
    ],
  },
  {
    label: '自然',
    emojis: [
      '🌸',
      '🌺',
      '🌻',
      '🌹',
      '🌷',
      '🌼',
      '💐',
      '🪻',
      '🌿',
      '🍀',
      '🍁',
      '🍂',
      '🍃',
      '🪴',
      '🌵',
      '🌲',
      '🌳',
      '🌴',
      '🌱',
      '🌾',
      '☘️',
      '🪹',
      '🪺',
      '🍄',
      '🌍',
      '🌎',
      '🌏',
      '🌈',
      '☀️',
      '🌤️',
      '⛅',
      '🌙',
      '⭐',
      '🌟',
      '💫',
      '✨',
      '☄️',
      '🔥',
      '💧',
      '🌊',
      '❄️',
      '🌪️',
      '🌈',
    ],
  },
  {
    label: '食物',
    emojis: [
      '🍎',
      '🍊',
      '🍋',
      '🍇',
      '🍓',
      '🫐',
      '🍑',
      '🍒',
      '🥝',
      '🍌',
      '🥑',
      '🍕',
      '🍔',
      '🌮',
      '🍣',
      '🍩',
      '🎂',
      '🧁',
      '🍫',
      '🍭',
      '🍬',
      '☕',
      '🧋',
      '🍵',
    ],
  },
  {
    label: '物品',
    emojis: [
      '💎',
      '🔮',
      '🪄',
      '🎯',
      '🎨',
      '🎭',
      '🎪',
      '🎬',
      '🎵',
      '🎸',
      '🎹',
      '🥁',
      '🎺',
      '🎻',
      '🎮',
      '🕹️',
      '🎲',
      '🧩',
      '🎰',
      '📚',
      '💻',
      '📱',
      '⌨️',
      '🖥️',
      '💡',
      '🔦',
      '🏮',
      '🕯️',
      '🧲',
      '🔧',
      '⚙️',
      '🛠️',
      '🚀',
      '🛸',
      '✈️',
      '🚁',
      '🏎️',
      '🚂',
      '⛵',
      '🎈',
      '🎁',
      '🏆',
      '🥇',
      '🎖️',
      '👑',
      '💍',
      '🧸',
      '🪅',
    ],
  },
  {
    label: '符号',
    emojis: [
      '❤️',
      '🧡',
      '💛',
      '💚',
      '💙',
      '💜',
      '🖤',
      '🤍',
      '💔',
      '❣️',
      '💕',
      '💞',
      '💓',
      '💗',
      '💖',
      '💘',
      '💝',
      '☮️',
      '✝️',
      '☯️',
      '♾️',
      '🔱',
      '⚡',
      '💥',
      '💢',
      '💦',
      '💨',
      '🕳️',
      '🫧',
      '🎵',
      '🎶',
      '✅',
      '❌',
      '⭕',
      '💯',
      '🔴',
      '🟠',
      '🟡',
      '🟢',
      '🔵',
      '🟣',
    ],
  },
];

type Style = '3d' | 'classic';

function FluentEmojiImage({
  code,
  label,
  className,
}: {
  code: string;
  label: string;
  className: string;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [code]);

  if (failed) {
    return (
      <span
        aria-label={`${label}图片不可用`}
        className={cn(
          className,
          'flex items-center justify-center rounded-full bg-muted text-xs text-muted-foreground',
        )}
      >
        ?
      </span>
    );
  }

  return (
    <img
      src={getFluentEmojiSrc(code)}
      alt={label}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}

export function EmojiPicker({ value, onChange }: EmojiPickerProps) {
  const fluentCode = normalizeFluentEmojiCode(value);
  const fluentToken = isFluentEmojiToken(value);
  const inferredStyle: Style =
    value && !fluentCode && !fluentToken ? 'classic' : '3d';
  const [style, setStyle] = useState<Style>(inferredStyle);
  const [activeCategory, setActiveCategory] = useState(0);
  const [activeFluentCategory, setActiveFluentCategory] = useState<string>(
    FLUENT_EMOJI_CATEGORIES[0],
  );
  const [customInput, setCustomInput] = useState('');

  useEffect(() => {
    setStyle(inferredStyle);
  }, [inferredStyle]);

  const fluentItemsInCategory = useMemo(
    () =>
      FLUENT_EMOJI_ITEMS.filter((it) => it.category === activeFluentCategory),
    [activeFluentCategory],
  );

  const handleCustomSubmit = () => {
    const trimmed = customInput.trim();
    if (!trimmed) return;

    const normalizedFluentCode = normalizeFluentEmojiCode(trimmed);
    if (normalizedFluentCode) {
      onChange(normalizedFluentCode);
      setStyle('3d');
      setCustomInput('');
      return;
    }
    if (isFluentEmojiToken(trimmed)) return;

    onChange(trimmed);
    setCustomInput('');
  };

  return (
    <div className="space-y-3">
      {/* 风格切换：3D 质感 素材 vs 经典 Unicode emoji */}
      <div className="flex gap-1 rounded-md bg-muted p-0.5">
        {(
          [
            ['3d', '3D 质感'],
            ['classic', '经典'],
          ] as const
        ).map(([key, text]) => (
          <button
            key={key}
            type="button"
            onClick={() => setStyle(key)}
            className={cn(
              'flex-1 rounded px-2 py-1 text-xs font-medium transition-colors cursor-pointer',
              style === key
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {text}
          </button>
        ))}
      </div>

      {style === '3d' ? (
        <>
          {/* Category tabs */}
          <div className="flex gap-1 overflow-x-auto pb-1">
            {FLUENT_EMOJI_CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setActiveFluentCategory(cat)}
                className={cn(
                  'px-2.5 py-1 text-xs rounded-md whitespace-nowrap transition-colors cursor-pointer',
                  activeFluentCategory === cat
                    ? 'bg-brand-50 text-primary font-medium'
                    : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* 3D emoji grid */}
          <div className="grid grid-cols-6 gap-1 max-h-48 overflow-y-auto p-1">
            {fluentItemsInCategory.map((item) => (
              <button
                key={item.code}
                type="button"
                title={item.label}
                onClick={() => onChange(item.code)}
                className={cn(
                  'w-10 h-10 flex items-center justify-center rounded-md hover:bg-muted transition-colors cursor-pointer',
                  fluentCode === item.code &&
                    'ring-2 ring-primary ring-offset-1 bg-brand-50',
                )}
              >
                <FluentEmojiImage
                  code={item.code}
                  label={item.label}
                  className="h-8 w-8 object-contain"
                />
              </button>
            ))}
          </div>

          {/* Current selection indicator */}
          {fluentCode && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>当前选择：</span>
              <FluentEmojiImage
                code={fluentCode}
                label="当前选择"
                className="h-6 w-6 object-contain"
              />
            </div>
          )}
        </>
      ) : (
        <>
          {/* Category tabs */}
          <div className="flex gap-1 overflow-x-auto pb-1">
            {EMOJI_CATEGORIES.map((cat, i) => (
              <button
                key={cat.label}
                type="button"
                onClick={() => setActiveCategory(i)}
                className={cn(
                  'px-2.5 py-1 text-xs rounded-md whitespace-nowrap transition-colors cursor-pointer',
                  activeCategory === i
                    ? 'bg-brand-50 text-primary font-medium'
                    : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* Emoji grid */}
          <div className="grid grid-cols-8 gap-1 max-h-48 overflow-y-auto p-1">
            {EMOJI_CATEGORIES[activeCategory].emojis.map((emoji, i) => (
              <button
                key={`${emoji}-${i}`}
                type="button"
                onClick={() => onChange(emoji)}
                className={cn(
                  'w-8 h-8 flex items-center justify-center rounded-md text-lg hover:bg-muted transition-colors cursor-pointer',
                  value === emoji &&
                    'ring-2 ring-primary ring-offset-1 bg-brand-50',
                )}
              >
                {emoji}
              </button>
            ))}
          </div>

          {/* Custom input */}
          <div className="flex items-center gap-2 pt-1 border-t border-border">
            <input
              type="text"
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCustomSubmit()}
              placeholder="输入任意 emoji..."
              className="flex-1 px-2.5 py-1.5 text-sm border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
              maxLength={8}
            />
            <button
              type="button"
              onClick={handleCustomSubmit}
              disabled={!customInput.trim()}
              className="px-3 py-1.5 text-xs font-medium bg-brand-50 text-primary rounded-md hover:bg-brand-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              确认
            </button>
          </div>

          {/* Current selection indicator */}
          {value && !fluentCode && !fluentToken && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>当前选择：</span>
              <span className="text-lg">{value}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
