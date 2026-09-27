import { useEffect, useRef, useState } from 'react';
import { Copy, Check, Maximize2, X } from 'lucide-react';
import DOMPurify from 'dompurify';
import { PreviewDialog } from './PreviewDialog';

/** 对 mermaid 渲染的 SVG 进行消毒，防止 XSS */
function sanitizeSvg(raw: string): string {
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['foreignObject'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed'],
  });
}

let mermaidPromise: Promise<typeof import('mermaid')> | null = null;
let idCounter = 0;

function isRetryableMermaidLoadError(error: unknown): boolean {
  const raw =
    error instanceof Error ? `${error.name} ${error.message}` : String(error);
  const text = raw.toLowerCase();
  return (
    text.includes('failed to fetch dynamically imported module') ||
    text.includes('importing a module script failed') ||
    text.includes('chunkloaderror') ||
    (text.includes('chunk') && text.includes('failed'))
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid')
      .then((mod) => {
        mod.default.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'default',
        });
        return mod;
      })
      .catch((error) => {
        // Import failure should not poison subsequent retries.
        mermaidPromise = null;
        throw error;
      });
  }
  return mermaidPromise;
}

interface MermaidDiagramProps {
  code: string;
}

export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const idRef = useRef(`mermaid-${++idCounter}`);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewPan, setPreviewPan] = useState({ x: 0, y: 0 });
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const previewTouchRef = useRef<{
    mode: 'none' | 'pinch' | 'pan';
    startDistance: number;
    startZoom: number;
    startX: number;
    startY: number;
    startPanX: number;
    startPanY: number;
  }>({
    mode: 'none',
    startDistance: 0,
    startZoom: 1,
    startX: 0,
    startY: 0,
    startPanX: 0,
    startPanY: 0,
  });
  const codeRef = useRef(code);
  codeRef.current = code;

  useEffect(() => {
    setLoading(true);
    setError(null);
    clearTimeout(debounceRef.current);
    let disposed = false;

    const renderWithRetry = async (
      diagramCode: string,
      attempt: number,
    ): Promise<string> => {
      try {
        const mermaid = await loadMermaid();
        const { svg: rendered } = await mermaid.default.render(
          `${idRef.current}-${attempt}`,
          diagramCode,
        );
        return rendered;
      } catch (error) {
        if (attempt === 0 && isRetryableMermaidLoadError(error)) {
          mermaidPromise = null;
          await sleep(300);
          return renderWithRetry(diagramCode, 1);
        }
        throw error;
      }
    };

    debounceRef.current = setTimeout(async () => {
      const currentCode = codeRef.current;
      try {
        const rendered = await renderWithRetry(currentCode, 0);
        if (!disposed && codeRef.current === currentCode) {
          setSvg(sanitizeSvg(rendered));
          setError(null);
          setLoading(false);
        }
      } catch (e) {
        if (!disposed && codeRef.current === currentCode) {
          setError(e instanceof Error ? e.message : String(e));
          setSvg(null);
          setLoading(false);
        }
      }
    }, 300);

    return () => {
      disposed = true;
      clearTimeout(debounceRef.current);
    };
  }, [code]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const resetPreviewTransform = () => {
    setPreviewZoom(1);
    setPreviewPan({ x: 0, y: 0 });
  };

  const openPreview = () => {
    resetPreviewTransform();
    setExpanded(true);
  };

  const touchDistance = (touches: React.TouchList) => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  };

  // 手机上的页面缩放会被全局禁用，因此预览自身处理双指缩放；放大后单指拖动。
  const handlePreviewTouchStart = (event: React.TouchEvent) => {
    if (event.touches.length === 2) {
      previewTouchRef.current = {
        mode: 'pinch',
        startDistance: touchDistance(event.touches),
        startZoom: previewZoom,
        startX: 0,
        startY: 0,
        startPanX: previewPan.x,
        startPanY: previewPan.y,
      };
    } else if (event.touches.length === 1 && previewZoom > 1) {
      previewTouchRef.current = {
        mode: 'pan',
        startDistance: 0,
        startZoom: previewZoom,
        startX: event.touches[0].clientX,
        startY: event.touches[0].clientY,
        startPanX: previewPan.x,
        startPanY: previewPan.y,
      };
    }
  };

  const handlePreviewTouchMove = (event: React.TouchEvent) => {
    const gesture = previewTouchRef.current;
    if (gesture.mode === 'pinch' && event.touches.length === 2) {
      event.preventDefault();
      const distance = touchDistance(event.touches);
      if (gesture.startDistance > 0) {
        const zoom = Math.min(
          4,
          Math.max(1, gesture.startZoom * (distance / gesture.startDistance)),
        );
        setPreviewZoom(zoom);
        if (zoom === 1) setPreviewPan({ x: 0, y: 0 });
      }
    } else if (gesture.mode === 'pan' && event.touches.length === 1) {
      event.preventDefault();
      setPreviewPan({
        x: gesture.startPanX + (event.touches[0].clientX - gesture.startX),
        y: gesture.startPanY + (event.touches[0].clientY - gesture.startY),
      });
    }
  };

  const handlePreviewTouchEnd = (event: React.TouchEvent) => {
    if (event.touches.length === 0) {
      previewTouchRef.current.mode = 'none';
    } else if (
      event.touches.length === 1 &&
      previewTouchRef.current.mode === 'pinch'
    ) {
      previewTouchRef.current =
        previewZoom > 1
          ? {
              mode: 'pan',
              startDistance: 0,
              startZoom: previewZoom,
              startX: event.touches[0].clientX,
              startY: event.touches[0].clientY,
              startPanX: previewPan.x,
              startPanY: previewPan.y,
            }
          : { ...previewTouchRef.current, mode: 'none' };
    }
  };

  if (loading) {
    return (
      <div className="my-4 rounded-lg bg-muted border border-border p-8 flex items-center justify-center">
        <div className="animate-pulse flex flex-col items-center gap-2">
          <div className="h-24 w-48 bg-muted-foreground/20 rounded" />
          <span className="text-sm text-muted-foreground">
            Mermaid 图表渲染中...
          </span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="relative group my-4 overflow-hidden">
        <div className="absolute right-2 top-2 opacity-70 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity">
          <button
            onClick={handleCopy}
            className="p-2 rounded-lg bg-muted hover:bg-muted/80 text-foreground text-xs flex items-center gap-1"
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
        <div className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 rounded-t-lg px-3 py-1">
          Mermaid 语法错误，已降级为代码展示
        </div>
        <pre className="!bg-[#f6f8fa] dark:!bg-[#1e1e2e] rounded-b-lg p-4 overflow-x-auto">
          <code className="language-mermaid text-foreground">{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <>
      <div className="relative group my-4">
        <div className="absolute right-2 top-2 opacity-70 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity z-10 flex gap-1">
          <button
            onClick={openPreview}
            className="p-2 rounded-lg bg-muted hover:bg-muted/80 text-foreground text-xs flex items-center gap-1"
            title="放大查看"
          >
            <Maximize2 size={14} />
          </button>
          <button
            onClick={handleCopy}
            className="p-2 rounded-lg bg-muted hover:bg-muted/80 text-foreground text-xs flex items-center gap-1"
          >
            {copied ? (
              <>
                <Check size={14} />
                已复制
              </>
            ) : (
              <>
                <Copy size={14} />
                源码
              </>
            )}
          </button>
        </div>
        <div
          className="bg-card rounded-lg border border-border p-4 overflow-x-auto flex justify-center cursor-pointer [&>svg]:!max-w-full [&>svg]:!h-auto"
          onClick={openPreview}
          dangerouslySetInnerHTML={{ __html: svg! }}
        />
      </div>
      {expanded && (
        <PreviewDialog
          title="Mermaid 图表预览"
          onClose={() => setExpanded(false)}
          layer="nested"
          className="left-1/2 top-1/2 h-[95dvh] w-[95vw] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-card p-6"
        >
          <button
            onClick={() => setExpanded(false)}
            className="absolute top-3 right-3 z-20 p-2 rounded-full bg-black/70 text-white hover:bg-black transition-colors cursor-pointer"
            aria-label="关闭图表预览"
            title="关闭"
          >
            <X size={16} />
          </button>
          <div className="relative h-full w-full overflow-hidden">
            <div
              className="flex h-full w-full touch-none items-center justify-center will-change-transform [&>svg]:!h-auto [&>svg]:!max-h-[90vh] [&>svg]:!max-w-none [&>svg]:!w-[90vw]"
              style={{
                transform: `translate(${previewPan.x}px, ${previewPan.y}px) scale(${previewZoom})`,
              }}
              onTouchStart={handlePreviewTouchStart}
              onTouchMove={handlePreviewTouchMove}
              onTouchEnd={handlePreviewTouchEnd}
              onTouchCancel={handlePreviewTouchEnd}
              dangerouslySetInnerHTML={{ __html: svg! }}
            />
            {previewZoom > 1 && (
              <button
                onClick={resetPreviewTransform}
                className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1.5 text-xs text-white transition-colors hover:bg-black"
              >
                恢复原始大小
              </button>
            )}
          </div>
        </PreviewDialog>
      )}
    </>
  );
}
