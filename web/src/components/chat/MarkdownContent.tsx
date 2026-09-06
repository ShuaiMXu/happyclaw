import React, { lazy, Suspense, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Check, Copy } from 'lucide-react';
import { PreviewDialog } from './PreviewDialog';
import { resolveMarkdownImageSrc } from '../../utils/markdownImageSrc';

const MermaidDiagram = lazy(() =>
  import('./MermaidDiagram').then((module) => ({
    default: module.MermaidDiagram,
  })),
);

export interface MarkdownRendererProps {
  content: string;
  groupJid?: string;
  variant?: 'chat' | 'docs';
  /** During streaming, keep the parser deliberately lightweight. */
  streaming?: boolean;
  /** Force images to load in offscreen export contexts. */
  eagerImages?: boolean;
}

interface MarkdownContentProps extends MarkdownRendererProps {
  remarkPlugins: readonly unknown[];
  rehypePlugins: readonly unknown[];
}

function MarkdownImageLightbox({
  src,
  onClose,
}: {
  src: string;
  onClose: () => void;
}) {
  return (
    <PreviewDialog
      title="图片预览"
      onClose={onClose}
      layer="nested"
      className="left-1/2 top-1/2 max-h-[90dvh] max-w-[90vw] -translate-x-1/2 -translate-y-1/2"
    >
      <img
        src={src}
        alt="放大查看"
        className="max-w-[90vw] max-h-[90vh] object-contain cursor-default"
      />
    </PreviewDialog>
  );
}

function MarkdownImage({
  src,
  alt,
  loading,
}: {
  src?: string;
  alt?: string;
  loading?: 'lazy' | 'eager';
}) {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState(false);

  if (!src) return null;
  if (error) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 bg-muted text-muted-foreground rounded text-sm">
        <svg
          className="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5Z"
          />
        </svg>
        {alt || '图片加载失败'}
      </span>
    );
  }

  return (
    <>
      <img
        src={src}
        alt={alt || ''}
        loading={loading}
        role="button"
        tabIndex={0}
        aria-label={alt ? `放大图片：${alt}` : '放大图片'}
        className="my-3 max-w-full rounded-lg border border-border cursor-pointer hover:shadow-md transition-shadow"
        style={{ maxHeight: '400px', objectFit: 'contain' }}
        onClick={() => setExpanded(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setExpanded(true);
          }
        }}
        onError={() => setError(true)}
      />
      {expanded && (
        <MarkdownImageLightbox src={src} onClose={() => setExpanded(false)} />
      )}
    </>
  );
}

function extractText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (React.isValidElement(node)) {
    return extractText((node.props as { children?: React.ReactNode }).children);
  }
  return '';
}

function MermaidFallback({ code }: { code: string }) {
  return (
    <div
      className="my-4 animate-pulse rounded-lg border border-border bg-muted p-4"
      data-markdown-pending="true"
    >
      <div className="mb-2 text-xs text-muted-foreground">正在加载图表…</div>
      <pre className="overflow-x-auto text-sm">
        <code className="language-mermaid">{code}</code>
      </pre>
    </div>
  );
}

function CodeBlock({
  className,
  children,
  variant = 'chat',
  ...props
}: React.ComponentPropsWithoutRef<'code'> & {
  className?: string;
  variant?: 'chat' | 'docs';
}) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || '');
  const lang = match?.[1];
  const codeString = extractText(children).replace(/\n$/, '');
  const isBlock = Boolean(match) || codeString.includes('\n');

  if (lang === 'mermaid') {
    return (
      <Suspense fallback={<MermaidFallback code={codeString} />}>
        <MermaidDiagram code={codeString} />
      </Suspense>
    );
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(codeString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isBlock) {
    return (
      <div className="relative group my-4 overflow-hidden">
        <div className="absolute right-2 top-2 opacity-70 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity">
          <button
            onClick={handleCopy}
            className="p-2 rounded-lg bg-muted hover:bg-muted/80 text-muted-foreground text-xs flex items-center gap-1"
          >
            {copied ? (
              <>
                <Check size={14} />
                已复制
              </>
            ) : (
              <>
                <Copy size={14} />
                复制
              </>
            )}
          </button>
        </div>
        <pre className="!bg-[var(--code-block-bg)] rounded-lg p-3.5 overflow-x-auto font-mono text-sm">
          <code className={className} {...props}>
            {children}
          </code>
        </pre>
      </div>
    );
  }

  return (
    <code
      className={
        variant === 'chat'
          ? 'bg-[var(--inline-code-bg)] text-[var(--inline-code-text)] px-1 py-px rounded-md text-[0.9em] leading-relaxed font-mono break-all'
          : 'bg-[var(--inline-code-bg)] text-[var(--inline-code-text)] px-1 py-px rounded-md text-sm font-mono break-all'
      }
      {...props}
    >
      {children}
    </code>
  );
}

export function MarkdownContent({
  content,
  groupJid,
  variant = 'chat',
  eagerImages = false,
  remarkPlugins,
  rehypePlugins,
}: MarkdownContentProps) {
  const textSizeClass =
    variant === 'chat'
      ? 'text-base leading-[1.65] text-foreground'
      : 'text-sm leading-6 text-foreground';
  const tableTextClass = variant === 'chat' ? 'text-[0.95em]' : 'text-sm';

  return (
    <div className={textSizeClass}>
      <ReactMarkdown
        remarkPlugins={
          remarkPlugins as React.ComponentProps<
            typeof ReactMarkdown
          >['remarkPlugins']
        }
        rehypePlugins={
          rehypePlugins as React.ComponentProps<
            typeof ReactMarkdown
          >['rehypePlugins']
        }
        components={{
          code: (props) => <CodeBlock {...props} variant={variant} />,
          img: ({ src, alt }) => (
            <MarkdownImage
              src={src ? resolveMarkdownImageSrc(src, groupJid) : undefined}
              alt={alt}
              loading={eagerImages ? 'eager' : 'lazy'}
            />
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary underline break-all"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div
              className="my-4 max-w-full overflow-x-auto overflow-y-hidden overscroll-x-contain [-webkit-overflow-scrolling:touch] [touch-action:pan-x_pan-y]"
              data-swipe-back-ignore="true"
            >
              <table className="min-w-full border-collapse border border-border">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-muted">{children}</thead>
          ),
          tbody: ({ children }) => (
            <tbody className="divide-y divide-border">{children}</tbody>
          ),
          tr: ({ children }) => (
            <tr className="even:bg-surface odd:bg-muted/30">{children}</tr>
          ),
          th: ({ children }) => (
            <th
              className={`px-4 py-2 text-left font-semibold text-foreground border border-border whitespace-nowrap align-top ${tableTextClass}`}
            >
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td
              className={`px-4 py-2 text-foreground border border-border whitespace-nowrap align-top ${tableTextClass}`}
            >
              {children}
            </td>
          ),
          ul: ({ children }) => (
            <ul className="list-disc pl-6 my-2 space-y-1">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-6 my-2 space-y-1">{children}</ol>
          ),
          li: ({ children }) => (
            <li className="[&>p]:inline [&>p]:my-0">{children}</li>
          ),
          p: ({ children }) => <p className="my-2">{children}</p>,
          h1: ({ children }) => (
            <h1 className="text-2xl font-bold mt-6 mb-4 leading-tight">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-xl font-bold mt-5 mb-3 leading-tight">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-lg font-semibold mt-4 mb-2 leading-snug">
              {children}
            </h3>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-border pl-4 my-4 text-muted-foreground italic">
              {children}
            </blockquote>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
