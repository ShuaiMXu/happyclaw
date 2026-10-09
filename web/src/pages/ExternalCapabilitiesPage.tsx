import { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Copy,
  FileSpreadsheet,
  FileText,
  Image,
  KeyRound,
  Loader2,
  LockKeyhole,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Tags,
  Trash2,
  Webhook,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { PageHeader } from '@/components/common/PageHeader';
import { api, type ApiError } from '@/api/client';

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
    storageReady: boolean;
    releaseEnabled: boolean;
    networkReady: boolean;
    imageReady: boolean;
  };
  inputs: {
    schemaVersion: number;
    acceptedMimeTypes: string[];
    maxFileBytes: number;
    maxFilesPerRun: number;
    maxTotalBytes: number;
  };
}

interface ExternalCapabilityKey {
  id: string;
  capability_slug: string;
  label: string;
  key_prefix: string;
  status: 'active' | 'revoked';
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

type PendingAction =
  | { kind: 'status'; status: 'active' | 'paused' | 'retired' }
  | { kind: 'revoke'; key: ExternalCapabilityKey };

const CAPABILITY_SLUG = 'quote-document-process';

const processingStages = [
  { icon: Image, label: '图片', detail: 'JPEG、PNG、WebP' },
  { icon: FileSpreadsheet, label: '表格', detail: '受限 XLSX（不支持 XLS）' },
  { icon: FileText, label: '结果', detail: '认证下载的标准 XLSX' },
];

const lifecycleLabels: Record<
  ExternalCapabilityView['lifecycleStatus'],
  string
> = {
  draft: '草稿',
  active: '运行中',
  paused: '已暂停',
  retired: '已退役',
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024))} MiB`;
  }
  return `${Math.round(bytes / 1024)} KiB`;
}

function formatDate(value: string | null): string {
  if (!value) return '从未使用';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function errorMessage(error: unknown): string {
  const apiError = error as Partial<ApiError>;
  return apiError.message || '操作失败，请稍后重试。';
}

export function ExternalCapabilitiesPage() {
  const [capability, setCapability] = useState<ExternalCapabilityView | null>(
    null,
  );
  const [keys, setKeys] = useState<ExternalCapabilityKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null,
  );
  const [actionLoading, setActionLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [keyLabel, setKeyLabel] = useState('');
  const [secret, setSecret] = useState<string | null>(null);

  const loadCapability = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await api.get<{ capabilities: ExternalCapabilityView[] }>(
        '/api/external-capabilities',
      );
      const nextCapability =
        result.capabilities.find((item) => item.slug === CAPABILITY_SLUG) ??
        null;
      setCapability(nextCapability);
      if (!nextCapability) {
        setKeys([]);
        return;
      }
      const keyResult = await api.get<{ keys: ExternalCapabilityKey[] }>(
        `/api/external-capabilities/${nextCapability.slug}/keys`,
      );
      setKeys(keyResult.keys);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCapability();
  }, [loadCapability]);

  const updateStatus = async (status: 'active' | 'paused' | 'retired') => {
    if (!capability) return;
    setActionLoading(true);
    try {
      const result = await api.patch<{ capability: ExternalCapabilityView }>(
        `/api/external-capabilities/${capability.slug}`,
        { status },
      );
      setCapability(result.capability);
      setPendingAction(null);
      toast.success(`能力已切换为“${lifecycleLabels[status]}”`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setActionLoading(false);
    }
  };

  const createKey = async () => {
    if (!capability || !keyLabel.trim()) return;
    setActionLoading(true);
    try {
      const result = await api.post<{
        key: ExternalCapabilityKey;
        secret: string;
      }>(`/api/external-capabilities/${capability.slug}/keys`, {
        label: keyLabel.trim(),
      });
      setKeys((current) => [result.key, ...current]);
      setKeyLabel('');
      setCreateOpen(false);
      setSecret(result.secret);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setActionLoading(false);
    }
  };

  const revokeKey = async (key: ExternalCapabilityKey) => {
    if (!capability) return;
    setActionLoading(true);
    try {
      await api.delete(
        `/api/external-capabilities/${capability.slug}/keys/${key.id}`,
      );
      setKeys((current) =>
        current.map((item) =>
          item.id === key.id
            ? {
                ...item,
                status: 'revoked',
                revoked_at: new Date().toISOString(),
              }
            : item,
        ),
      );
      setPendingAction(null);
      toast.success('密钥已撤销');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setActionLoading(false);
    }
  };

  const executePendingAction = () => {
    if (!pendingAction) return;
    if (pendingAction.kind === 'status') {
      void updateStatus(pendingAction.status);
    } else {
      void revokeKey(pendingAction.key);
    }
  };

  const copySecret = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      toast.success('密钥已复制');
    } catch {
      toast.error('无法自动复制，请手动选择密钥。');
    }
  };

  const activeKeys = keys.filter((key) => key.status === 'active');
  const isAvailable = capability?.availability === 'available';
  const activationReady = Boolean(
    capability?.workspace.targetReady &&
    capability.workspace.storageReady &&
    capability.workspace.networkReady &&
    capability.workspace.imageReady &&
    capability.workspace.releaseEnabled,
  );
  const canCreateKey =
    capability?.lifecycleStatus === 'draft' ||
    capability?.lifecycleStatus === 'active';

  const readiness = capability
    ? [
        {
          label: '目标工作区',
          ready: capability.workspace.targetReady,
          detail: capability.workspace.targetReady
            ? `${capability.workspace.name} · 容器模式`
            : '工作区绑定或执行模式不符合要求',
        },
        {
          label: '私有存储',
          ready: capability.workspace.storageReady,
          detail: capability.workspace.storageReady
            ? 'Vault 配置可用'
            : 'Vault 尚未就绪',
        },
        {
          label: '隔离网络',
          ready: capability.workspace.networkReady,
          detail: capability.workspace.networkReady
            ? '专用网络已配置'
            : '专用网络尚未配置',
        },
        {
          label: '运行镜像',
          ready: capability.workspace.imageReady,
          detail: capability.workspace.imageReady
            ? '运行镜像已固定到不可变 sha256 摘要'
            : '运行镜像未固定到 sha256 摘要，不能启用或受理请求',
        },
        {
          label: '宿主发布闸门',
          ready: capability.workspace.releaseEnabled,
          detail: capability.workspace.releaseEnabled
            ? '发布闸门已打开'
            : '发布闸门保持关闭',
        },
      ]
    : [];

  const pendingTitle =
    pendingAction?.kind === 'revoke'
      ? `撤销密钥“${pendingAction.key.label}”？`
      : pendingAction?.status === 'active'
        ? '启用外调能力？'
        : pendingAction?.status === 'paused'
          ? '暂停外调能力？'
          : '永久退役外调能力？';
  const pendingMessage =
    pendingAction?.kind === 'revoke'
      ? '撤销后，调用方将无法再使用此密钥提交、查询、取消或下载任务；此操作不可恢复。'
      : pendingAction?.status === 'active'
        ? '启用后，持有有效服务端密钥的调用方可以提交任务。请仅在隔离、配额、监控和发布验收全部完成后继续。'
        : pendingAction?.status === 'paused'
          ? '暂停会停止新任务受理和领取；已开始的任务仍按围栏规则结算。'
          : '退役会永久停止该能力，且无法恢复。未开始的任务将被取消；请先确认调用方已完成迁移。';

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
      <PageHeader
        title="外调"
        subtitle="把平台能力整理成可安全对接的服务，供其他产品从服务端调用。"
        actions={
          <Button
            variant="outline"
            onClick={() => void loadCapability()}
            disabled={loading}
          >
            <RefreshCw className={loading ? 'animate-spin' : ''} />
            刷新
          </Button>
        }
      />

      <Card className="border-primary/20 bg-primary/[0.03]">
        <CardContent className="flex gap-3 p-4 text-sm text-muted-foreground sm:p-5">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" />
          <p className="leading-6">
            外调能力只允许由
            <strong className="font-medium text-foreground">服务端</strong>
            调用。浏览器控制面仅用于生命周期和密钥管理；密钥明文只在创建后显示一次，不会再次读取。
          </p>
        </CardContent>
      </Card>

      {loading && !capability ? (
        <Card>
          <CardContent className="flex items-center justify-center gap-2 py-14 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在读取能力状态
          </CardContent>
        </Card>
      ) : loadError ? (
        <Card className="border-destructive/30">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <CircleAlert className="size-6 text-destructive" />
            <div>
              <p className="font-medium text-foreground">能力状态读取失败</p>
              <p className="mt-1 text-sm text-muted-foreground">{loadError}</p>
            </div>
            <Button variant="outline" onClick={() => void loadCapability()}>
              重试
            </Button>
          </CardContent>
        </Card>
      ) : !capability ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="font-medium text-foreground">没有可管理的外调能力</p>
            <p className="mt-1 text-sm text-muted-foreground">
              当前账号没有目标工作区的修改权，或能力尚未配置。
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <section className="space-y-3">
            <div>
              <h2 className="text-base font-semibold text-foreground">
                能力中心
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                生命周期状态与基础设施就绪状态相互独立；只有两者都允许时才会受理请求。
              </p>
            </div>

            <Card>
              <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
                <div className="flex min-w-0 gap-3">
                  <div className="rounded-lg bg-primary/10 p-2.5 text-primary">
                    <Webhook className="size-5" />
                  </div>
                  <div className="min-w-0">
                    <CardTitle className="text-base">
                      {capability.name}
                    </CardTitle>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      {capability.description}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-2">
                  <Badge variant="outline">
                    {lifecycleLabels[capability.lifecycleStatus]}
                  </Badge>
                  <Badge variant={isAvailable ? 'default' : 'secondary'}>
                    {isAvailable ? '可调用' : '不可调用'}
                  </Badge>
                </div>
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
                        <p className="text-xs text-muted-foreground">
                          {detail}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="grid gap-3 text-sm sm:grid-cols-3">
                  <div className="flex gap-2.5">
                    <Tags className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div>
                      <p className="font-medium text-foreground">
                        不透明业务引用
                      </p>
                      <p className="mt-1 leading-5 text-muted-foreground">
                        调用方应生成任务、租户和账户引用，不得传入姓名、电话等个人资料。
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2.5">
                    <LockKeyhole className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div>
                      <p className="font-medium text-foreground">
                        一次性密钥明文
                      </p>
                      <p className="mt-1 leading-5 text-muted-foreground">
                        创建后仅在本次控制面响应中显示，请立即保存到调用方服务端的秘密管理系统。
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2.5">
                    <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div>
                      <p className="font-medium text-foreground">异步结果</p>
                      <p className="mt-1 leading-5 text-muted-foreground">
                        调用方轮询任务状态，并用同一密钥认证下载保留期内的 XLSX
                        结果。
                      </p>
                    </div>
                  </div>
                </div>

                <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 text-sm sm:grid-cols-3">
                  <div>
                    <p className="text-xs text-muted-foreground">文件限制</p>
                    <p className="mt-1 font-medium text-foreground">
                      每次最多 {capability.inputs.maxFilesPerRun} 个
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">单文件上限</p>
                    <p className="mt-1 font-medium text-foreground">
                      {formatBytes(capability.inputs.maxFileBytes)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">总输入上限</p>
                    <p className="mt-1 font-medium text-foreground">
                      {formatBytes(capability.inputs.maxTotalBytes)}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 border-t pt-4">
                  {capability.lifecycleStatus === 'draft' && (
                    <Button
                      onClick={() =>
                        setPendingAction({ kind: 'status', status: 'active' })
                      }
                      disabled={!activationReady}
                    >
                      <Play />
                      启用能力
                    </Button>
                  )}
                  {capability.lifecycleStatus === 'active' && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        setPendingAction({ kind: 'status', status: 'paused' })
                      }
                    >
                      <Pause />
                      暂停受理
                    </Button>
                  )}
                  {capability.lifecycleStatus === 'paused' && (
                    <Button
                      onClick={() =>
                        setPendingAction({ kind: 'status', status: 'active' })
                      }
                      disabled={!activationReady}
                    >
                      <Play />
                      恢复能力
                    </Button>
                  )}
                  {capability.lifecycleStatus !== 'retired' && (
                    <Button
                      variant="destructive"
                      onClick={() =>
                        setPendingAction({ kind: 'status', status: 'retired' })
                      }
                    >
                      <Trash2 />
                      永久退役
                    </Button>
                  )}
                  {!activationReady &&
                    capability.lifecycleStatus !== 'retired' && (
                      <p className="self-center text-xs text-muted-foreground">
                        所有发布前置条件满足后才能启用。
                      </p>
                    )}
                </div>
              </CardContent>
            </Card>
          </section>

          <section className="space-y-3">
            <div>
              <h2 className="text-base font-semibold text-foreground">
                发布就绪状态
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                此处只展示基础设施闸门，不代表隔离、配额、监控或灰度验收已经完成。
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {readiness.map((item) => (
                <Card key={item.label}>
                  <CardContent className="flex gap-3 p-4">
                    {item.ready ? (
                      <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
                    ) : (
                      <CircleAlert className="mt-0.5 size-5 shrink-0 text-amber-600" />
                    )}
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {item.label}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {item.detail}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  服务端密钥
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  仅展示前缀和使用时间；明文不会存储，也无法再次查看。
                </p>
              </div>
              <Button
                onClick={() => setCreateOpen(true)}
                disabled={!canCreateKey}
              >
                <Plus />
                创建密钥
              </Button>
            </div>

            <Card>
              <CardContent className="p-0">
                {keys.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <KeyRound className="size-6 text-muted-foreground" />
                    <p className="font-medium text-foreground">尚未创建密钥</p>
                    <p className="max-w-md text-sm text-muted-foreground">
                      在确定调用方、用途、配额和秘密管理方案后再创建。草稿阶段可以预配置，但不建议提前发放。
                    </p>
                  </div>
                ) : (
                  <div className="divide-y">
                    {keys.map((key) => (
                      <div
                        key={key.id}
                        className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium text-foreground">
                              {key.label}
                            </p>
                            <Badge
                              variant={
                                key.status === 'active'
                                  ? 'default'
                                  : 'secondary'
                              }
                            >
                              {key.status === 'active' ? '有效' : '已撤销'}
                            </Badge>
                          </div>
                          <p className="mt-1 font-mono text-xs text-muted-foreground">
                            ec_{key.key_prefix}_…
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            创建于 {formatDate(key.created_at)} · 最近使用{' '}
                            {formatDate(key.last_used_at)}
                          </p>
                        </div>
                        {key.status === 'active' && (
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() =>
                              setPendingAction({ kind: 'revoke', key })
                            }
                          >
                            撤销
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
            <p className="text-xs text-muted-foreground">
              当前共有 {activeKeys.length}{' '}
              个有效密钥。撤销密钥会阻止其继续访问历史任务。
            </p>
          </section>
        </>
      )}

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!actionLoading) setCreateOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>创建服务端密钥</DialogTitle>
            <DialogDescription>
              使用可识别的系统或环境名称。密钥明文只显示一次，不要保存到浏览器、本地文件或聊天记录。
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-2">
            <span className="text-sm font-medium text-foreground">
              用途标签
            </span>
            <Input
              value={keyLabel}
              onChange={(event) => setKeyLabel(event.target.value)}
              maxLength={120}
              placeholder="例如：采购系统预发布环境"
              autoFocus
            />
          </label>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={actionLoading}
            >
              取消
            </Button>
            <Button
              onClick={() => void createKey()}
              disabled={!keyLabel.trim() || actionLoading}
            >
              {actionLoading && <Loader2 className="animate-spin" />}
              创建并显示一次
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={secret !== null}
        onOpenChange={(open) => {
          if (!open) setSecret(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>立即保存密钥</DialogTitle>
            <DialogDescription>
              关闭后无法再次查看。请复制到调用方服务端的秘密管理系统，并限制读取权限。
            </DialogDescription>
          </DialogHeader>
          <div className="break-all rounded-lg border bg-muted/40 p-3 font-mono text-xs text-foreground">
            {secret}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => void copySecret()}>
              <Copy />
              复制密钥
            </Button>
            <Button onClick={() => setSecret(null)}>我已安全保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={pendingAction !== null}
        onClose={() => {
          if (!actionLoading) setPendingAction(null);
        }}
        onConfirm={executePendingAction}
        title={pendingTitle}
        message={pendingMessage}
        confirmText={
          pendingAction?.kind === 'revoke'
            ? '撤销密钥'
            : pendingAction?.status === 'active'
              ? '确认启用'
              : pendingAction?.status === 'paused'
                ? '确认暂停'
                : '永久退役'
        }
        confirmVariant={
          pendingAction?.kind === 'revoke' ||
          pendingAction?.status === 'retired'
            ? 'danger'
            : 'primary'
        }
        loading={actionLoading}
      />
    </main>
  );
}
