import { useEffect, useState } from 'react';
import {
  ArrowRight,
  FileSpreadsheet,
  FileText,
  Image,
  LockKeyhole,
  ShieldCheck,
  Tags,
  Webhook,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/common/PageHeader';
import { api } from '@/api/client';

interface ExternalCapabilityView {
  slug: string;
  name: string;
  description: string;
  lifecycleStatus: 'draft' | 'active' | 'paused' | 'retired';
  availability: 'available' | 'building';
  workspace: {
    name: string;
    folder: string;
    executionMode: 'container' | 'host';
    targetReady: boolean;
  };
  inputs: {
    schemaVersion: number;
    acceptedMimeTypes: string[];
    maxFileBytes: number;
    maxFilesPerRun: number;
    maxTotalBytes: number;
  };
}

const processingStages = [
  { icon: Image, label: '图片', detail: 'JPG、PNG、WebP' },
  { icon: FileSpreadsheet, label: '表格', detail: 'XLSX（不支持旧版 XLS）' },
  { icon: FileText, label: '结果', detail: '标准 XLSX 底表' },
];

export function ExternalCapabilitiesPage() {
  const [capability, setCapability] = useState<ExternalCapabilityView | null>(
    null,
  );
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let disposed = false;
    void api
      .get<{ capabilities: ExternalCapabilityView[] }>(
        '/api/external-capabilities',
      )
      .then((result) => {
        if (disposed) return;
        setCapability(
          result.capabilities.find(
            (item) => item.slug === 'quote-document-process',
          ) ?? null,
        );
      })
      .catch(() => {
        if (!disposed) setLoadError(true);
      });
    return () => {
      disposed = true;
    };
  }, []);

  const isAvailable = capability?.availability === 'available';
  const capabilityName = capability?.name ?? '报价单数据加工';
  const capabilityDescription =
    capability?.description ??
    '把图片或 Excel 报价单处理为可查询的标准明细、风险项和待确认项。';

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
      <PageHeader
        title="外调"
        subtitle="把平台能力整理成可安全对接的服务，供你的其他产品在服务端调用。"
      />

      <Card className="border-primary/20 bg-primary/[0.03]">
        <CardContent className="flex gap-3 p-4 text-sm text-muted-foreground sm:p-5">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" />
          <p className="leading-6">
            外调能力只允许由
            <strong className="font-medium text-foreground">服务端</strong>
            调用：密钥、用户信息和原始文件不会暴露给浏览器。每一项能力都会固定处理范围、输入标准、权限与回传格式。
          </p>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">能力中心</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            将可复用的处理能力封装为标准化服务，支持不同业务系统按统一接口安全接入。
          </p>
        </div>

        <Card>
          <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
            <div className="flex min-w-0 gap-3">
              <div className="rounded-lg bg-primary/10 p-2.5 text-primary">
                <Webhook className="size-5" />
              </div>
              <div className="min-w-0">
                <CardTitle className="text-base">{capabilityName}</CardTitle>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  {capabilityDescription}
                </p>
              </div>
            </div>
            <Badge
              variant={isAvailable ? 'default' : 'secondary'}
              className="shrink-0"
            >
              {isAvailable ? '已就绪' : capability ? '建设中' : '读取中'}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-3">
              {processingStages.map(({ icon: Icon, label, detail }) => (
                <div
                  key={label}
                  className="flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-3"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {label}
                    </p>
                    <p className="text-xs text-muted-foreground">{detail}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="grid gap-3 text-sm sm:grid-cols-3">
              <div className="flex gap-2.5">
                <Tags className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div>
                  <p className="font-medium text-foreground">用户归类标签</p>
                  <p className="mt-1 leading-5 text-muted-foreground">
                    使用 T2 服务端生成的不透明任务和用户标识，不传真实个人资料。
                  </p>
                </div>
              </div>
              <div className="flex gap-2.5">
                <LockKeyhole className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div>
                  <p className="font-medium text-foreground">服务端密钥</p>
                  <p className="mt-1 leading-5 text-muted-foreground">
                    密钥仅保存在服务端，创建后只显示一次，支持后续轮换和撤销。
                  </p>
                </div>
              </div>
              <div className="flex gap-2.5">
                <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div>
                  <p className="font-medium text-foreground">异步回传</p>
                  <p className="mt-1 leading-5 text-muted-foreground">
                    通过状态接口轮询任务，并认证下载生成的 XLSX
                    底表；失败会给出安全且可读的错误说明。
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-dashed bg-muted/20 px-3 py-3 text-sm leading-6 text-muted-foreground">
              {loadError
                ? '暂时无法读取能力状态。请刷新页面后重试；接口与密钥仍不会暴露到浏览器。'
                : isAvailable
                  ? `已绑定到「${capability?.workspace.name}」，将使用容器隔离处理。`
                  : capability
                    ? `目标工作区为「${capability.workspace.name}」。正在建设任务接口、文件校验、隔离执行和回传机制；接口与密钥尚未开放。`
                    : '正在读取能力状态。接口与密钥尚未开放，避免在能力未完整就绪时被误用。'}
            </div>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
