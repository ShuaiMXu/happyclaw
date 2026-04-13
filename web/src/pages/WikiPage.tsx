import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BookOpen, Hash, Link2, Loader2, RefreshCw, Tag } from 'lucide-react';
import { api } from '../api/client';
import { Button } from '@/components/ui/button';
import 'highlight.js/styles/github.css';

interface WikiFileMeta {
  category: 'entities' | 'topics';
  name: string;
  path: string;
  title: string;
  tags: string[];
  updated: string | null;
}

interface WikiTree {
  initialized: boolean;
  entities: WikiFileMeta[];
  topics: WikiFileMeta[];
}

interface WikiFile {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  outlinks: string[];
  updated: string;
}

interface Backlink {
  path: string;
  title: string;
  category: 'entities' | 'topics';
}

/** Turn `[[name]]` / `[[name|alias]]` into resolvable markdown links. */
function preprocessWikilinks(body: string, index: Map<string, WikiFileMeta>): string {
  return body.replace(/\[\[([^\]|]+?)(\|[^\]]+)?\]\]/g, (match, name: string, alias?: string) => {
    const display = (alias ? alias.slice(1) : name).trim();
    const target = index.get(name.trim().toLowerCase());
    if (!target) return match; // leave `[[name]]` visible as broken link signal
    const encoded = encodeURIComponent(target.path);
    return `[${display}](wiki://${encoded})`;
  });
}

export function WikiPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentPath = searchParams.get('page') || '';
  const [tree, setTree] = useState<WikiTree | null>(null);
  const [file, setFile] = useState<WikiFile | null>(null);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [loading, setLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshTree = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get<WikiTree>('/api/knowledge/wiki/tree');
      setTree(resp);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshTree();
  }, [refreshTree]);

  useEffect(() => {
    if (!currentPath) {
      setFile(null);
      setBacklinks([]);
      return;
    }
    let cancelled = false;
    setFileLoading(true);
    (async () => {
      try {
        const fileResp = await api.get<WikiFile>(
          `/api/knowledge/wiki/file?path=${encodeURIComponent(currentPath)}`,
        );
        if (cancelled) return;
        setFile(fileResp);

        const name = currentPath.split('/').pop()!.replace(/\.md$/, '');
        const backResp = await api.get<{ backlinks: Backlink[] }>(
          `/api/knowledge/wiki/backlinks?name=${encodeURIComponent(name)}`,
        );
        if (!cancelled) setBacklinks(backResp.backlinks);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '文件加载失败');
      } finally {
        if (!cancelled) setFileLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentPath]);

  const nameIndex = useMemo(() => {
    const map = new Map<string, WikiFileMeta>();
    if (!tree) return map;
    // entities take precedence over topics on name collision
    for (const m of tree.topics) map.set(m.name.toLowerCase(), m);
    for (const m of tree.entities) map.set(m.name.toLowerCase(), m);
    return map;
  }, [tree]);

  const openPath = useCallback(
    (p: string) => {
      setSearchParams({ page: p });
    },
    [setSearchParams],
  );

  const renderedBody = useMemo(() => {
    if (!file) return '';
    return preprocessWikilinks(file.body, nameIndex);
  }, [file, nameIndex]);

  return (
    <div className="flex h-full bg-background">
      {/* Left sidebar */}
      <aside className="w-64 shrink-0 border-r border-border flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <BookOpen className="w-4 h-4 text-primary" />
            知识库
          </div>
          <Button variant="ghost" size="sm" onClick={refreshTree} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 text-sm">
          {loading && !tree && (
            <div className="p-3 text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> 加载中…
            </div>
          )}
          {error && !tree && <div className="p-3 text-destructive">{error}</div>}
          {tree && !tree.initialized && (
            <div className="p-3 rounded-lg bg-muted text-muted-foreground text-xs leading-relaxed">
              知识库尚未初始化。到「系统设置 → 浏览器扩展」里点「初始化并编译」，等 Agent 跑完后回来。
            </div>
          )}
          {tree && tree.initialized && (
            <>
              <SectionList
                label="实体"
                icon={<Hash className="w-3.5 h-3.5" />}
                items={tree.entities}
                currentPath={currentPath}
                onOpen={openPath}
              />
              <SectionList
                label="主题"
                icon={<BookOpen className="w-3.5 h-3.5" />}
                items={tree.topics}
                currentPath={currentPath}
                onOpen={openPath}
              />
            </>
          )}
        </div>
      </aside>

      {/* Center: content */}
      <main className="flex-1 overflow-y-auto">
        {!currentPath && (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            从左侧选一个实体或主题页面开始浏览
          </div>
        )}
        {currentPath && fileLoading && (
          <div className="p-6 text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> 加载中…
          </div>
        )}
        {currentPath && file && (
          <article className="max-w-3xl mx-auto px-8 py-8">
            <header className="mb-6 pb-4 border-b border-border">
              <div className="text-xs text-muted-foreground font-mono">{file.path}</div>
              <h1 className="text-2xl font-bold text-foreground mt-1">{file.title}</h1>
              {Array.isArray(file.frontmatter.tags) && (file.frontmatter.tags as string[]).length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {(file.frontmatter.tags as string[]).map((t) => (
                    <span
                      key={t}
                      className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </header>
            <div className="prose prose-sm max-w-none prose-headings:text-foreground prose-p:text-foreground prose-strong:text-foreground prose-code:text-foreground prose-a:text-primary">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children }) => {
                    if (typeof href === 'string' && href.startsWith('wiki://')) {
                      const target = decodeURIComponent(href.slice(7));
                      return (
                        <button
                          type="button"
                          onClick={() => openPath(target)}
                          className="text-primary hover:underline font-medium"
                        >
                          {children}
                        </button>
                      );
                    }
                    return (
                      <a href={href} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                        {children}
                      </a>
                    );
                  },
                }}
              >
                {renderedBody}
              </ReactMarkdown>
            </div>
          </article>
        )}
      </main>

      {/* Right sidebar: backlinks + outlinks */}
      {currentPath && file && (
        <aside className="w-64 shrink-0 border-l border-border overflow-y-auto p-4 text-sm space-y-5">
          <LinkList
            label="反向链接"
            icon={<Link2 className="w-3.5 h-3.5" />}
            empty="暂无页面引用此页"
            items={backlinks.map((b) => ({ path: b.path, title: b.title }))}
            onOpen={openPath}
          />
          <LinkList
            label="本页链接"
            icon={<Link2 className="w-3.5 h-3.5 rotate-180" />}
            empty="本页没有出链"
            items={file.outlinks
              .map((name) => nameIndex.get(name.toLowerCase()))
              .filter((m): m is WikiFileMeta => !!m)
              .map((m) => ({ path: m.path, title: m.title }))}
            onOpen={openPath}
          />
          {file.outlinks.some((n) => !nameIndex.has(n.toLowerCase())) && (
            <div>
              <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground mb-1.5">
                <Tag className="w-3.5 h-3.5" /> 未解析的链接
              </div>
              <div className="flex flex-wrap gap-1">
                {file.outlinks
                  .filter((n) => !nameIndex.has(n.toLowerCase()))
                  .map((n) => (
                    <span
                      key={n}
                      className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono"
                    >
                      [[{n}]]
                    </span>
                  ))}
              </div>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

function SectionList({
  label,
  icon,
  items,
  currentPath,
  onOpen,
}: {
  label: string;
  icon: React.ReactNode;
  items: WikiFileMeta[];
  currentPath: string;
  onOpen: (p: string) => void;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between px-2 py-1.5 text-xs font-semibold text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {icon} {label}
        </span>
        <span>{items.length}</span>
      </div>
      {items.length === 0 && (
        <div className="px-2 py-1 text-xs text-muted-foreground/70">暂无</div>
      )}
      <div className="space-y-0.5">
        {items.map((m) => (
          <button
            key={m.path}
            type="button"
            onClick={() => onOpen(m.path)}
            className={`w-full text-left px-2 py-1 rounded text-sm truncate transition-colors ${
              m.path === currentPath
                ? 'bg-primary/10 text-primary font-medium'
                : 'text-foreground hover:bg-muted'
            }`}
            title={m.title}
          >
            {m.title}
          </button>
        ))}
      </div>
    </div>
  );
}

function LinkList({
  label,
  icon,
  empty,
  items,
  onOpen,
}: {
  label: string;
  icon: React.ReactNode;
  empty: string;
  items: { path: string; title: string }[];
  onOpen: (p: string) => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground mb-1.5">
        {icon} {label}
      </div>
      {items.length === 0 && <div className="text-xs text-muted-foreground/70">{empty}</div>}
      <div className="space-y-0.5">
        {items.map((it) => (
          <button
            key={it.path}
            type="button"
            onClick={() => onOpen(it.path)}
            className="w-full text-left px-2 py-1 rounded text-sm text-foreground hover:bg-muted truncate"
            title={it.title}
          >
            {it.title}
          </button>
        ))}
      </div>
    </div>
  );
}
