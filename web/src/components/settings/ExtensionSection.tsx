import { useCallback, useEffect, useState } from 'react';
import { Chrome, Copy, Check, RefreshCw, Trash2, ExternalLink, AlertTriangle, Sparkles, BookOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/api/client';

interface ApiTokenPublic {
  id: string;
  scope: 'knowledge';
  name: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  last_used_ip: string | null;
  revoked_at: string | null;
}

interface ApiTokenCreateResponse extends ApiTokenPublic {
  token: string; // plaintext — only shown once at creation
}

interface KnowledgeStats {
  total_clips: number;
  clips_last_7_days: number;
  wiki: {
    raw_articles: number;
    wiki_sources: number;
    wiki_entities: number;
    wiki_topics: number;
    wiki_initialized: boolean;
  } | null;
}

function formatDate(iso: string | null): string {
  if (!iso) return '从未';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { hour12: false });
}

function buildServerUrl(): string {
  if (typeof window === 'undefined') return '';
  return window.location.origin;
}

export function ExtensionSection() {
  const [tokens, setTokens] = useState<ApiTokenPublic[]>([]);
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [ingestNotice, setIngestNotice] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const serverUrl = buildServerUrl();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [tokensResp, statsResp] = await Promise.all([
        api.get<{ tokens: ApiTokenPublic[] }>('/api/user/tokens'),
        api.get<KnowledgeStats>('/api/knowledge/stats').catch(() => null),
      ]);
      setTokens(tokensResp.tokens.filter((t) => t.scope === 'knowledge'));
      setStats(statsResp);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : '加载失败';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const activeToken = tokens.find((t) => !t.revoked_at);

  const copy = useCallback(async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField((f) => (f === field ? null : f)), 1800);
    } catch {
      setError('复制失败，请手动选中复制');
    }
  }, []);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const resp = await api.post<ApiTokenCreateResponse>('/api/user/tokens', {
        scope: 'knowledge',
        name: '浏览器扩展',
      });
      setNewToken(resp.token);
      // 自动复制到剪贴板
      try {
        await navigator.clipboard.writeText(resp.token);
        setCopiedField('token');
        setTimeout(() => setCopiedField((f) => (f === 'token' ? null : f)), 2400);
      } catch {
        /* 用户需手动复制 */
      }
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : '生成失败';
      setError(message);
    } finally {
      setGenerating(false);
    }
  }, [refresh]);

  const handleRevoke = useCallback(
    async (id: string) => {
      if (!confirm('确定要吊销这个 Token 吗？扩展将立即失效。')) return;
      try {
        await api.delete(`/api/user/tokens/${id}`);
        await refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : '吊销失败';
        setError(message);
      }
    },
    [refresh],
  );

  const handleIngest = useCallback(async () => {
    setIngesting(true);
    setIngestNotice(null);
    try {
      const resp = await api.post<{ taskId: string; scheduledAt: string }>(
        '/api/knowledge/ingest',
      );
      const when = new Date(resp.scheduledAt).toLocaleTimeString('zh-CN', { hour12: false });
      setIngestNotice(`已排入任务，预计 ${when} 开始编译（可在「会话管理」里查看进度）`);
      // 刷新一下统计
      setTimeout(() => refresh(), 2000);
    } catch (err) {
      const message = err instanceof Error ? err.message : '触发失败';
      setError(message);
    } finally {
      setIngesting(false);
    }
  }, [refresh]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground mb-1 flex items-center gap-2">
          <Chrome className="w-5 h-5 text-primary" />
          浏览器扩展
        </h2>
        <p className="text-sm text-muted-foreground">
          把网页内容一键保存到 HappyClaw 知识库。装上扩展后，按下面两步填进去即可。
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 text-destructive text-sm px-3 py-2">
          {error}
        </div>
      )}

      {/* ① 服务器地址 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-foreground">① 服务器地址</label>
          <span className="text-xs text-muted-foreground">填到扩展的"服务器 URL"</span>
        </div>
        <div className="flex gap-2">
          <input
            readOnly
            value={serverUrl}
            className="flex-1 px-3 py-2 rounded-lg border border-border bg-muted/40 text-sm font-mono"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button
            variant="outline"
            onClick={() => copy(serverUrl, 'server')}
            className="shrink-0"
          >
            {copiedField === 'server' ? (
              <>
                <Check className="w-4 h-4" />
                已复制
              </>
            ) : (
              <>
                <Copy className="w-4 h-4" />
                复制
              </>
            )}
          </Button>
        </div>
      </div>

      {/* ② Token */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-foreground">② Token</label>
          <span className="text-xs text-muted-foreground">填到扩展的"API Token"</span>
        </div>

        {newToken ? (
          <div className="space-y-2">
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-bg/50 text-warning text-xs px-3 py-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                Token 只显示这一次，请立即粘贴到扩展里。刷新页面后就看不到了，需要重新生成。
              </div>
            </div>
            <div className="flex gap-2">
              <input
                readOnly
                value={newToken}
                className="flex-1 px-3 py-2 rounded-lg border border-primary/40 bg-background text-sm font-mono"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                onClick={() => copy(newToken, 'token')}
                className="shrink-0"
              >
                {copiedField === 'token' ? (
                  <>
                    <Check className="w-4 h-4" />
                    已复制
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4" />
                    复制
                  </>
                )}
              </Button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setNewToken(null)}
              className="text-muted-foreground"
            >
              我已保存，隐藏
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              readOnly
              value={activeToken ? `${activeToken.token_prefix}${'•'.repeat(20)}（已隐藏）` : '尚未生成'}
              className="flex-1 px-3 py-2 rounded-lg border border-border bg-muted/40 text-sm font-mono text-muted-foreground"
            />
            <Button
              onClick={handleGenerate}
              disabled={generating}
              className="shrink-0"
            >
              <RefreshCw className={`w-4 h-4 ${generating ? 'animate-spin' : ''}`} />
              {activeToken ? '重新生成' : '生成'}
            </Button>
          </div>
        )}
      </div>

      {/* Token 列表 */}
      {!loading && tokens.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-foreground">已有 Token</div>
          <div className="rounded-lg border border-border divide-y divide-border">
            {tokens.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono text-foreground">{t.token_prefix}…</span>
                    {t.revoked_at && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        已吊销
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    创建于 {formatDate(t.created_at)} · 最近使用 {formatDate(t.last_used_at)}
                    {t.last_used_ip && ` · IP ${t.last_used_ip}`}
                  </div>
                </div>
                {!t.revoked_at && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRevoke(t.id)}
                    className="shrink-0 text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 扩展下载 */}
      <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">还没装扩展？</span>
          <a
            href="https://github.com/ShuaiMXu/happyclaw-knowledge-extension"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:text-primary/80"
          >
            去 GitHub 获取
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>

      {/* 知识库（llm-wiki 编译层）*/}
      <div className="pt-6 border-t border-border space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground mb-1 flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-primary" />
            知识库编译
          </h2>
          <p className="text-sm text-muted-foreground">
            基于 Karpathy llm-wiki 方法论，把收藏的素材编译成可链接的知识图谱。保存的网页先存到「收件箱」，编译后进入 wiki（实体页、主题页、双向链接）。
          </p>
        </div>

        {stats?.wiki ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <StatCard label="收件箱" value={stats.wiki.raw_articles} hint="raw/articles" />
            <StatCard label="已编译" value={stats.wiki.wiki_sources} hint="wiki/sources" />
            <StatCard label="实体" value={stats.wiki.wiki_entities} hint="wiki/entities" />
            <StatCard label="主题" value={stats.wiki.wiki_topics} hint="wiki/topics" />
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2 items-center">
          <Button onClick={handleIngest} disabled={ingesting}>
            <Sparkles className={`w-4 h-4 ${ingesting ? 'animate-pulse' : ''}`} />
            {stats?.wiki?.wiki_initialized ? '立即编译新素材' : '初始化并编译'}
          </Button>
          <a
            href="/memory"
            className="text-sm text-primary hover:text-primary/80 inline-flex items-center gap-1"
          >
            打开知识库
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>

        {ingestNotice && (
          <div className="rounded-lg border border-primary/30 bg-brand-50 text-primary text-sm px-3 py-2">
            {ingestNotice}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          编译任务在主会话里异步运行，每次只处理尚未编译的新素材。首次运行会自动初始化 wiki 结构。
        </p>
      </div>
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold text-foreground">{value}</div>
      <div className="text-[10px] text-muted-foreground/70 font-mono mt-0.5">{hint}</div>
    </div>
  );
}
