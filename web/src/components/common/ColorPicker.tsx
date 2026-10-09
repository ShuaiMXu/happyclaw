import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ColorPickerProps {
  value?: string;
  onChange: (color: string) => void;
}

// 不分类，纯色值列表：基础色 + 潘通年度色历史 + 奥运五环色 + 网红色。
const COLORS = [
  // 基础色
  '#ff6600',
  '#0ea5e9',
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#f43f5e',
  '#ef4444',
  '#0d9488',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#64748b',
  // 潘通年度代表色 2000-2026
  '#9bb7d4',
  '#c74375',
  '#bf1932',
  '#7bc4e2',
  '#e2583e',
  '#53b0ae',
  '#decdbe',
  '#9b1b30',
  '#5a5b9f',
  '#efc050',
  '#45b5aa',
  '#d94f70',
  '#dd4132',
  '#009473',
  '#b163a3',
  '#964f4c',
  '#f7cac9',
  '#92a8d1',
  '#88b04b',
  '#5f4b8b',
  '#ff6f61',
  '#0f4c81',
  '#f5df4d',
  '#939597',
  '#6667ab',
  '#bb2649',
  '#ffbe98',
  '#a47764',
  '#f0eee9',
  // 历届奥运会主题色（各主办城市 Look of the Games，非五环通用色）
  // 北京 2008：中国红/迎春黄/青绿/天蓝（约值，官方色卡未公开精确色号）
  '#e3232c',
  '#ffd400',
  '#8dc63f',
  '#00a9e0',
  // 伦敦 2012：亮粉/橙/蓝/绿（约值）
  '#ed0080',
  '#f35b23',
  '#00aeef',
  '#92d400',
  // 索契 2014：主视觉藏青
  '#006ab3',
  // 里约 2016：官方色卡实色
  '#2b9935',
  '#57b52f',
  '#f2511c',
  '#fccc06',
  '#3fa3da',
  '#4abfee',
  // 平昌 2018：官方色卡实色
  '#060606',
  '#00963f',
  '#0079c2',
  '#e61b44',
  '#f9b320',
  // 东京 2020：会徽蓝（藍色/AI色）
  '#202b5a',
  // 北京 2022：霞光红/迎春黄/天霁蓝/长城灰/瑞雪白（约值，官方色卡未公开精确色号）
  '#de3f24',
  '#ffc20e',
  '#4f97bb',
  '#6e7274',
  '#f5f3ee',
  // 巴黎 2024：官方色卡实色
  '#d6c278',
  '#000000',
  '#0082c7',
  '#e8384f',
  '#fcb030',
  '#00a652',
  // 网红色
  '#0abab5',
  '#e0218a',
  '#f6c6ca',
  '#002fa7',
  '#833ab4',
  '#fd1d1d',
  '#f77737',
  '#25f4ee',
  '#fe2c55',
  '#f40009',
];

export function ColorPicker({ value, onChange }: ColorPickerProps) {
  return (
    <div className="grid grid-cols-6 gap-2 max-h-48 overflow-y-auto p-1">
      {COLORS.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={`选择颜色 ${color}`}
          onClick={() => onChange(color)}
          className={cn(
            'w-8 h-8 rounded-full cursor-pointer transition-transform hover:scale-110 flex items-center justify-center',
            value === color &&
              'ring-2 ring-primary ring-offset-2 ring-offset-background',
          )}
          style={{ backgroundColor: color }}
        >
          {value === color && (
            <Check className="w-4 h-4 text-white" strokeWidth={2.5} />
          )}
        </button>
      ))}
    </div>
  );
}
