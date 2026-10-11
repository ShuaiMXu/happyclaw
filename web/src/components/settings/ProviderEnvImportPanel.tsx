import { useState } from 'react';
import { ClipboardPaste, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  parseProviderEnvImport,
  type ProviderEnvImport,
} from '../../utils/provider-env-import';

interface ProviderEnvImportPanelProps {
  disabled?: boolean;
  onApply: (imported: ProviderEnvImport) => void;
}

function maskToken(token: string): string {
  return token.length <= 8 ? '***' : `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/** Paste a shell alias / env block and preview what it fills in. */
export function ProviderEnvImportPanel({
  disabled = false,
  onApply,
}: ProviderEnvImportPanelProps) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<ProviderEnvImport | null>(null);

  const rows: Array<[string, string]> = preview
    ? [
        ...(preview.name ? [['名称', preview.name] as [string, string]] : []),
        ...(preview.baseUrl
          ? [['API 端点', preview.baseUrl] as [string, string]]
          : []),
        ...(preview.token
          ? [
              [
                '密钥',
                `${maskToken(preview.token)}（${
                  preview.authMode === 'x-api-key' ? 'x-api-key' : 'Bearer'
                }）`,
              ] as [string, string],
            ]
          : []),
        [
          '模型',
          preview.model
            ? `${preview.model}${preview.oneMillionContext ? ' · 1M 上下文' : ''}`
            : '未指定（透传 Claude 模型名）',
        ],
        ...Object.entries(preview.envOverrides).map(
          ([key, value]) => [key, value] as [string, string],
        ),
        ...Object.entries(preview.customEnv).map(
          ([key, value]) => [key, value] as [string, string],
        ),
      ]
    : [];
  const applicable =
    !!preview &&
    (!!preview.baseUrl ||
      !!preview.token ||
      !!preview.model ||
      Object.keys(preview.envOverrides).length > 0 ||
      Object.keys(preview.customEnv).length > 0);

  return (
    <details className="group/import overflow-hidden rounded-lg ring-1 ring-surface-border">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 text-label text-foreground outline-none select-none hover:bg-surface-hover focus-visible:bg-surface-hover [&::-webkit-details-marker]:hidden">
        <ClipboardPaste
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">从 alias / 环境变量导入</span>
        <span className="shrink-0 text-caption text-muted-foreground">
          粘贴 ~/.zshrc 里的 alias 一键填好
        </span>
      </summary>
      <div className="space-y-3 border-t border-surface-border px-3 py-3">
        <Textarea
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setPreview(null);
          }}
          disabled={disabled}
          rows={3}
          spellCheck={false}
          aria-label="粘贴 alias 或环境变量"
          placeholder={
            'alias glm="ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic ANTHROPIC_AUTH_TOKEN=... ANTHROPIC_MODEL=glm-5.3[1m] claude"\n也支持 export 行、.env 和 settings.json 的 env 块'
          }
          className="max-h-48 font-mono text-caption md:text-caption"
        />
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || !text.trim()}
            onClick={() => setPreview(parseProviderEnvImport(text))}
          >
            解析
          </Button>
          {preview && (
            <Button
              type="button"
              size="sm"
              disabled={disabled || !applicable}
              onClick={() => {
                onApply(preview);
                setText('');
                setPreview(null);
              }}
            >
              填入表单
            </Button>
          )}
        </div>

        {preview && (
          <div className="space-y-2">
            {rows.length > 0 && (
              <dl className="divide-y divide-surface-border overflow-hidden rounded-lg ring-1 ring-surface-border">
                {rows.map(([label, value]) => (
                  <div
                    key={label}
                    className="grid gap-1 px-3 py-1.5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:gap-3"
                  >
                    <dt className="min-w-0 font-mono text-micro break-all text-muted-foreground">
                      {label}
                    </dt>
                    <dd className="min-w-0 font-mono text-micro break-all text-foreground">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {[
              ...preview.rejected.map(
                (item) => `${item.key} 未导入：${item.reason}`,
              ),
              ...preview.warnings,
            ].map((message) => (
              <p
                key={message}
                className="flex gap-1.5 text-caption leading-5 text-warning"
              >
                <TriangleAlert
                  className="mt-0.5 size-3.5 shrink-0"
                  aria-hidden="true"
                />
                <span className="min-w-0 break-words">{message}</span>
              </p>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}
