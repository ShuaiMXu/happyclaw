import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import {
  Folder,
  FolderOpen,
  ChevronRight,
  Download,
  Trash2,
  FolderPlus,
  RefreshCw,
  X,
  FileText,
  FileCode,
  Image,
  Package,
  File,
  Pencil,
  Save,
  Loader2,
  Eye,
  FileEdit,
  Film,
  Music,
  AlertCircle,
  Copy,
  ListChecks,
  Square,
  CheckSquare,
  FolderInput,
} from 'lucide-react';
import { useFileStore, FileEntry, toBase64Url } from '../../stores/files';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { useScrollIsolation } from '../../hooks/useScrollIsolation';
import { api } from '../../api/client';
import { withBasePath } from '../../utils/url';
import { downloadFromUrlWithProgress } from '../../utils/download';
import { showToast } from '../../utils/toast';
import { copyToClipboard } from '../../utils/clipboard';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { FileUploadZone } from './FileUploadZone';
import { MarkdownRenderer } from './MarkdownRenderer';
import { MoveFilesDialog } from './MoveFilesDialog';
import { PreviewDialog } from './PreviewDialog';
import { ScrollEdgeAffordance } from '../common/ScrollEdgeAffordance';
import { naturalCompare } from '../../utils/naturalSort';

interface FilePanelProps {
  groupJid: string;
  onClose?: () => void;
}

// ─── File type constants ─────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'bmp',
  'ico',
]);

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'json',
  'js',
  'ts',
  'jsx',
  'tsx',
  'css',
  'html',
  'xml',
  'py',
  'go',
  'rs',
  'java',
  'c',
  'cpp',
  'h',
  'sh',
  'yaml',
  'yml',
  'toml',
  'ini',
  'conf',
  'log',
  'csv',
  'svg',
]);

const CODE_EXTENSIONS = new Set([
  'js',
  'ts',
  'jsx',
  'tsx',
  'py',
  'go',
  'rs',
  'java',
  'c',
  'cpp',
  'h',
  'sh',
  'css',
  'html',
  'xml',
  'yaml',
  'yml',
  'toml',
]);

const ARCHIVE_EXTENSIONS = new Set([
  'zip',
  'tar',
  'gz',
  '7z',
  'rar',
  'bz2',
  'xz',
]);

const PDF_EXTENSIONS = new Set(['pdf']);

const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv']);

const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac']);

// ─── File icon component ────────────────────────────────────────

function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() || '';

  if (IMAGE_EXTENSIONS.has(ext))
    return <Image className="w-4 h-4 text-pink-500" />;
  if (VIDEO_EXTENSIONS.has(ext))
    return <Film className="w-4 h-4 text-purple-500" />;
  if (AUDIO_EXTENSIONS.has(ext))
    return <Music className="w-4 h-4 text-cyan-500" />;
  if (ARCHIVE_EXTENSIONS.has(ext))
    return <Package className="w-4 h-4 text-amber-500" />;
  if (ext === 'pdf') return <FileText className="w-4 h-4 text-red-500" />;
  if (ext === 'json') return <FileCode className="w-4 h-4 text-yellow-600" />;
  if (ext === 'md') return <FileText className="w-4 h-4 text-blue-500" />;
  if (CODE_EXTENSIONS.has(ext))
    return <FileCode className="w-4 h-4 text-emerald-500" />;
  if (TEXT_EXTENSIONS.has(ext))
    return <FileText className="w-4 h-4 text-muted-foreground" />;
  return <File className="w-4 h-4 text-muted-foreground" />;
}

function getFileExt(name: string): string {
  return name.split('.').pop()?.toLowerCase() || '';
}

/** 黑名单扩展名/文件名模式：不显示预览/编辑按钮 */
const PREVIEW_BLACKLIST_EXTENSIONS = new Set([
  'tmp',
  'swp',
  'swo',
  'temp',
  'cache',
]);

/**
 * 后端是否允许编辑该文件内容。
 * 旧后端不返回 editable 字段时回退到原有的「非系统文件」判断。
 */
function isEntryEditable(item: FileEntry): boolean {
  return item.type === 'file' && (item.editable ?? !item.isSystem);
}

/** 判断文件是否可点击预览（排除临时文件；系统文件仅在可编辑例外时开放） */
function isPreviewableFile(item: FileEntry): boolean {
  if (item.isSystem && !isEntryEditable(item)) return false;
  const ext = getFileExt(item.name);
  if (PREVIEW_BLACKLIST_EXTENSIONS.has(ext)) return false;
  return true;
}

// Preview state: only one overlay can be open at a time
type PreviewState =
  | null
  | { kind: 'image'; file: FileEntry }
  | { kind: 'edit'; file: FileEntry }
  | { kind: 'markdown'; file: FileEntry }
  | { kind: 'pdf'; file: FileEntry }
  | { kind: 'video'; file: FileEntry }
  | { kind: 'audio'; file: FileEntry }
  | { kind: 'text'; file: FileEntry };

// ─── Helpers ─────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    sizes.length - 1,
  );
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function buildPreviewUrl(groupJid: string, filePath: string): string {
  return withBasePath(
    `/api/groups/${encodeURIComponent(groupJid)}/files/preview/${toBase64Url(filePath)}`,
  );
}

// ─── Media Overlay (shared shell for image/pdf/video) ──────────

function MediaOverlay({
  onClose,
  children,
  fileName,
  bgOpacity = '80',
}: {
  onClose: () => void;
  children: React.ReactNode;
  fileName: string;
  bgOpacity?: string;
}) {
  return (
    <PreviewDialog
      title={fileName}
      onClose={onClose}
      overlayClassName={bgOpacity === '90' ? 'bg-black/90' : 'bg-black/80'}
      className="left-1/2 top-1/2 max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2"
    >
      <button
        className="fixed top-4 right-4 text-white/70 hover:text-white transition-colors p-2 cursor-pointer z-10"
        onClick={onClose}
        aria-label="关闭预览"
      >
        <X className="w-8 h-8" />
      </button>
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 text-white/70 text-sm bg-black/50 px-3 py-1 rounded-full">
        {fileName}
      </div>
      {children}
    </PreviewDialog>
  );
}

// ─── Image Preview Overlay ──────────────────────────────────────

function ImagePreview({
  groupJid,
  file,
  onClose,
}: {
  groupJid: string;
  file: FileEntry;
  onClose: () => void;
}) {
  return (
    <MediaOverlay onClose={onClose} fileName={file.name}>
      <img
        src={buildPreviewUrl(groupJid, file.path)}
        alt={file.name}
        className="max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] object-contain rounded-lg"
        onClick={(e) => e.stopPropagation()}
      />
    </MediaOverlay>
  );
}

// ─── Text Editor Overlay ────────────────────────────────────────

function TextEditor({
  groupJid,
  file,
  onClose,
}: {
  groupJid: string;
  file: FileEntry;
  onClose: () => void;
}) {
  const { getFileContent, saveFileContent } = useFileStore();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  useScrollIsolation(overlayRef);
  useEffect(() => {
    const handleSave = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave_();
      }
    };
    window.addEventListener('keydown', handleSave);
    return () => window.removeEventListener('keydown', handleSave);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, dirty]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const text = await getFileContent(groupJid, file.path);
      if (!cancelled && text !== null) {
        setContent(text);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [groupJid, file.path, getFileContent]);

  const handleSave_ = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    const ok = await saveFileContent(groupJid, file.path, content);
    setSaving(false);
    if (ok) setDirty(false);
  };

  return (
    <PreviewDialog
      ref={overlayRef}
      title={`编辑 ${file.name}`}
      onClose={onClose}
      overlayClassName="bg-black/50"
      className="left-1/2 top-1/2 h-[85vh] w-[calc(100vw-1.5rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 supports-[height:100dvh]:h-[85dvh]"
    >
      <div className="bg-surface rounded-xl shadow-xl w-full h-full flex flex-col animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <FileIcon name={file.name} />
            <span className="font-medium text-foreground text-sm truncate">
              {file.name}
            </span>
            {dirty && (
              <span className="text-xs text-amber-500 flex-shrink-0">
                未保存
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button size="sm" onClick={handleSave_} disabled={!dirty || saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              <Save className="w-3.5 h-3.5" />
              保存
            </Button>
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground transition-colors p-2 rounded-md hover:bg-muted cursor-pointer"
              aria-label="关闭编辑器"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Editor */}
        <div className="flex-1 p-3 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-muted-foreground">加载中...</p>
            </div>
          ) : (
            <Textarea
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setDirty(true);
              }}
              className="w-full h-full font-mono text-sm text-foreground resize-none bg-muted"
              spellCheck={false}
            />
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-border text-xs text-muted-foreground flex-shrink-0">
          Ctrl/Cmd+S 保存 · Esc 关闭
        </div>
      </div>
    </PreviewDialog>
  );
}

// ─── Markdown File Viewer (Preview + Edit) ─────────────────────

function MarkdownFileViewer({
  groupJid,
  file,
  onClose,
}: {
  groupJid: string;
  file: FileEntry;
  onClose: () => void;
}) {
  const { getFileContent, saveFileContent } = useFileStore();
  const [content, setContent] = useState('');
  const [editContent, setEditContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);

  useScrollIsolation(overlayRef);

  useEffect(() => {
    const handleSaveKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        doSave();
      }
    };
    window.addEventListener('keydown', handleSaveKey);
    return () => window.removeEventListener('keydown', handleSaveKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editContent, dirty, mode]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const text = await getFileContent(groupJid, file.path);
      if (!cancelled && text !== null) {
        setContent(text);
        setEditContent(text);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [groupJid, file.path, getFileContent]);

  const doSave = async () => {
    if (!dirty || saving || mode !== 'edit') return;
    setSaving(true);
    const ok = await saveFileContent(groupJid, file.path, editContent);
    setSaving(false);
    if (ok) {
      setContent(editContent);
      setDirty(false);
    }
  };

  const switchToEdit = () => {
    setEditContent(content);
    setMode('edit');
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const switchToPreview = () => {
    if (dirty) {
      setContent(editContent);
    }
    setMode('preview');
  };

  return (
    <PreviewDialog
      ref={overlayRef}
      title={`预览 ${file.name}`}
      onClose={onClose}
      overlayClassName="bg-black/50"
      className="inset-0 h-[100dvh] w-screen sm:left-1/2 sm:top-1/2 sm:h-[90vh] sm:w-[calc(100vw-2rem)] sm:max-w-4xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:supports-[height:100dvh]:h-[90dvh]"
    >
      <div className="bg-surface w-full h-full sm:rounded-xl sm:shadow-xl flex flex-col sm:animate-in sm:zoom-in-95 sm:duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-3 sm:px-4 py-2.5 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <FileIcon name={file.name} />
            <span className="font-medium text-foreground text-sm truncate">
              {file.name}
            </span>
            {dirty && (
              <span className="text-xs text-amber-500 flex-shrink-0">
                未保存
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 sm:gap-1.5 flex-shrink-0">
            {/* Mode toggle */}
            <div className="flex items-center bg-muted rounded-lg p-0.5">
              <button
                onClick={switchToPreview}
                aria-label="预览"
                className={`flex items-center gap-1 px-2.5 py-1.5 sm:px-2 sm:py-1 rounded-md text-xs font-medium transition-colors touch-manipulation ${
                  mode === 'preview'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Eye className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                <span className="hidden sm:inline">预览</span>
              </button>
              <button
                onClick={switchToEdit}
                aria-label="编辑"
                className={`flex items-center gap-1 px-2.5 py-1.5 sm:px-2 sm:py-1 rounded-md text-xs font-medium transition-colors touch-manipulation ${
                  mode === 'edit'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <FileEdit className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                <span className="hidden sm:inline">编辑</span>
              </button>
            </div>
            {mode === 'edit' && (
              <Button
                size="sm"
                onClick={doSave}
                disabled={!dirty || saving}
                className="touch-manipulation"
              >
                {saving && <Loader2 className="size-4 animate-spin" />}
                <Save className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">保存</span>
              </Button>
            )}
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground transition-colors p-2 rounded-md hover:bg-muted touch-manipulation"
              aria-label="关闭"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content — explicit overflow container with touch-action for iOS */}
        <div className="flex-1 min-h-0 relative">
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : mode === 'preview' ? (
            <div
              ref={previewScrollRef}
              className="hc-scroll-pane absolute inset-0 overflow-y-auto overscroll-y-contain px-4 sm:px-6 py-4 [&_table_td]:!whitespace-normal [&_table_th]:!whitespace-normal"
              data-testid="markdown-preview-scroll"
              style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-y' }}
            >
              <MarkdownRenderer
                content={content}
                groupJid={groupJid}
                variant="docs"
              />
            </div>
          ) : (
            <div className="absolute inset-0 p-2 sm:p-3">
              <Textarea
                ref={textareaRef}
                value={editContent}
                onChange={(e) => {
                  setEditContent(e.target.value);
                  setDirty(true);
                }}
                className="w-full h-full font-mono text-sm text-foreground resize-none bg-muted"
                style={{
                  WebkitOverflowScrolling: 'touch',
                  touchAction: 'pan-y',
                }}
                spellCheck={false}
              />
            </div>
          )}
          {!loading && mode === 'preview' && (
            <ScrollEdgeAffordance scrollRef={previewScrollRef} />
          )}
        </div>

        {/* Footer */}
        <div className="px-3 sm:px-4 py-1.5 border-t border-border text-xs text-muted-foreground flex-shrink-0">
          {mode === 'edit'
            ? 'Ctrl/Cmd+S 保存 · Esc 关闭'
            : '点击「编辑」修改内容 · Esc 关闭'}
        </div>
      </div>
    </PreviewDialog>
  );
}

// ─── PDF Preview Overlay ────────────────────────────────────────

function PdfPreview({
  groupJid,
  file,
  onClose,
}: {
  groupJid: string;
  file: FileEntry;
  onClose: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [viewerLoadVersion, setViewerLoadVersion] = useState(0);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || viewerLoadVersion === 0) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    const embeddedWindow = iframe.contentWindow;

    try {
      embeddedWindow?.addEventListener('keydown', handleKeyDown);
      iframe.dataset.escapeBridge = 'ready';
    } catch {
      // Some browser PDF viewers move their controls into an extension
      // process. The dialog close control remains available in that case.
    }
    return () => {
      try {
        embeddedWindow?.removeEventListener('keydown', handleKeyDown);
      } catch {
        // The embedded viewer may have navigated across origins while closing.
      }
    };
  }, [onClose, viewerLoadVersion]);

  return (
    <MediaOverlay onClose={onClose} fileName={file.name}>
      <iframe
        ref={iframeRef}
        src={buildPreviewUrl(groupJid, file.path)}
        title={file.name}
        className="h-[90dvh] w-[90vw] rounded-lg bg-white"
        tabIndex={0}
        onLoad={() => setViewerLoadVersion((version) => version + 1)}
      />
    </MediaOverlay>
  );
}

// ─── Video Preview Overlay ─────────────────────────────────────

function VideoPreview({
  groupJid,
  file,
  onClose,
}: {
  groupJid: string;
  file: FileEntry;
  onClose: () => void;
}) {
  return (
    <MediaOverlay onClose={onClose} fileName={file.name} bgOpacity="90">
      <video
        src={buildPreviewUrl(groupJid, file.path)}
        controls
        autoPlay
        className="max-w-[90vw] max-h-[90vh] rounded-lg"
        tabIndex={0}
      />
    </MediaOverlay>
  );
}

// ─── Audio Preview Overlay ─────────────────────────────────────

function AudioPreview({
  groupJid,
  file,
  onClose,
}: {
  groupJid: string;
  file: FileEntry;
  onClose: () => void;
}) {
  return (
    <PreviewDialog
      title={`播放 ${file.name}`}
      onClose={onClose}
      className="left-1/2 top-1/2 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl bg-surface p-6 shadow-xl"
    >
      <div className="flex flex-col items-center gap-4">
        <div className="flex items-center gap-3 w-full">
          <Music className="w-10 h-10 text-cyan-500 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-foreground truncate">{file.name}</p>
            <p className="text-xs text-muted-foreground">
              {formatSize(file.size)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors p-2 cursor-pointer"
            aria-label="关闭"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <audio
          src={buildPreviewUrl(groupJid, file.path)}
          controls
          autoPlay
          className="w-full"
          tabIndex={0}
        />
      </div>
    </PreviewDialog>
  );
}

// ─── Generic File Preview (for hidden files like .gitignore) ──

function GenericTextPreview({
  groupJid,
  file,
  onClose,
}: {
  groupJid: string;
  file: FileEntry;
  onClose: () => void;
}) {
  const { getFileContent } = useFileStore();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  useScrollIsolation(overlayRef);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(false);
      const text = await getFileContent(groupJid, file.path);
      if (!cancelled) {
        if (text !== null) {
          setContent(text);
        } else {
          setLoadError(true);
        }
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [groupJid, file.path, getFileContent]);

  // 弹窗默认没有可聚焦元素时，Radix 会把焦点落在整个 Dialog 容器上——这时按
  // Ctrl/Cmd+A 走浏览器默认行为会全选整个页面（弹窗前后的内容都会被框进去），
  // 而不是只选中预览的正文。这里在弹窗挂载期间监听 keydown，把全选范围收窄到
  // <pre> 正文节点；弹窗关闭（组件卸载）时监听器自动移除，不影响其他地方。
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isSelectAll =
        (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a';
      if (!isSelectAll || !preRef.current) return;
      e.preventDefault();
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(preRef.current);
      selection.removeAllRanges();
      selection.addRange(range);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleCopyContent = () => {
    copyToClipboard(content)
      .then(() => showToast('已复制', '文件内容已复制到剪贴板'))
      .catch((err) => {
        console.error('Copy failed:', err);
        showToast(
          '复制失败',
          err instanceof Error ? err.message : '无法写入剪贴板',
        );
      });
  };

  return (
    <PreviewDialog
      ref={overlayRef}
      title={`预览 ${file.name}`}
      onClose={onClose}
      overlayClassName="bg-black/50"
      className="left-1/2 top-1/2 h-[85vh] w-[calc(100vw-1.5rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 supports-[height:100dvh]:h-[85dvh]"
    >
      <div className="bg-surface rounded-xl shadow-xl w-full h-full flex flex-col animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <FileIcon name={file.name} />
            <span className="font-medium text-foreground text-sm truncate">
              {file.name}
            </span>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={handleCopyContent}
              disabled={loading || loadError || !content}
              className="text-muted-foreground hover:text-foreground transition-colors p-2 rounded-md hover:bg-muted cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="复制文件内容"
              title="复制全部内容"
            >
              <Copy className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground transition-colors p-2 rounded-md hover:bg-muted cursor-pointer"
              aria-label="关闭预览"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="relative min-h-0 flex-1">
          <div
            ref={contentScrollRef}
            className="hc-scroll-pane h-full overflow-auto p-4"
            data-testid="text-preview-scroll"
          >
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : loadError ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
                <AlertCircle className="w-10 h-10" />
                <p className="text-sm">此文件类型不支持预览</p>
              </div>
            ) : (
              <pre
                ref={preRef}
                className="text-sm text-foreground whitespace-pre-wrap break-all font-mono"
              >
                {content}
              </pre>
            )}
          </div>
          <ScrollEdgeAffordance scrollRef={contentScrollRef} />
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-border text-xs text-muted-foreground flex-shrink-0">
          Ctrl/Cmd+A 只选中正文 · Esc 关闭
        </div>
      </div>
    </PreviewDialog>
  );
}

// ─── Main FilePanel ─────────────────────────────────────────────

export function FilePanel({ groupJid, onClose }: FilePanelProps) {
  const {
    files,
    currentPath,
    loading,
    loadFiles,
    deleteFile,
    batchDeleteFiles,
    moveFiles,
    createDirectory,
    navigateTo,
  } = useFileStore();

  const [createDirModal, setCreateDirModal] = useState(false);
  const [newDirName, setNewDirName] = useState('');
  const [createDirLoading, setCreateDirLoading] = useState(false);
  const [openDirLoading, setOpenDirLoading] = useState(false);
  const [openDirError, setOpenDirError] = useState<string | null>(null);

  const [deleteModal, setDeleteModal] = useState<{
    open: boolean;
    path: string;
    name: string;
    isDir: boolean;
  }>({ open: false, path: '', name: '', isDir: false });
  const [deleteLoading, setDeleteLoading] = useState(false);

  // 下载进度：key 是文件相对路径，值为 0-100 的百分比；后端没有返回
  // Content-Length（罕见）时为 null，此时只显示旋转图标，不显示具体数字。
  // key 存在即代表"正在下载中"。
  const [downloadingPaths, setDownloadingPaths] = useState<
    Record<string, number | null>
  >({});

  // Preview / Editor state — only one overlay can be open at a time
  const [preview, setPreview] = useState<PreviewState>(null);

  // 多选：选择范围限定在"当前目录这一屏"，切换目录时清空——避免选中项跑到
  // 看不见的地方，用户也搞不清批量操作到底会作用在哪些文件上。
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [batchDeleteModal, setBatchDeleteModal] = useState(false);
  const [batchDeleteLoading, setBatchDeleteLoading] = useState(false);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);

  const isStreaming = useChatStore((s) => !!s.streaming[groupJid]);
  const canOpenLocalFolder = useAuthStore((s) => s.user?.role === 'admin');
  const prevStreamingRef = useRef(false);
  const fileListScrollRef = useRef<HTMLDivElement>(null);

  const fileList = files[groupJid] || [];
  const currentDir = currentPath[groupJid] || '';

  useEffect(() => {
    if (groupJid) {
      loadFiles(groupJid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupJid]);

  // Agent 运行期间定时刷新文件列表；结束时做最终刷新
  useEffect(() => {
    if (isStreaming) {
      prevStreamingRef.current = true;
      const timer = setInterval(() => {
        loadFiles(groupJid, currentDir);
      }, 5000);
      return () => clearInterval(timer);
    }
    // streaming 刚结束 → 最终刷新
    if (prevStreamingRef.current) {
      prevStreamingRef.current = false;
      loadFiles(groupJid, currentDir);
    }
  }, [isStreaming, groupJid, currentDir, loadFiles]);

  const sortedFiles = useMemo(() => {
    return [...fileList].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return naturalCompare(a.name, b.name);
    });
  }, [fileList]);

  // 系统文件本来就不给删/不给移，多选里也不提供，省得批量操作报一堆
  // "系统路径不可删除" 的部分失败。
  const selectableFiles = useMemo(
    () => sortedFiles.filter((f) => !f.isSystem),
    [sortedFiles],
  );
  const allSelected =
    selectableFiles.length > 0 && selectedPaths.size === selectableFiles.length;

  useEffect(() => {
    setSelectedPaths(new Set());
  }, [currentDir]);

  const toggleSelectionMode = () => {
    setSelectionMode((prev) => !prev);
    setSelectedPaths(new Set());
  };

  const toggleItemSelected = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedPaths(
      allSelected ? new Set() : new Set(selectableFiles.map((f) => f.path)),
    );
  };

  const breadcrumbs = useMemo(() => {
    if (!currentDir) return [];
    return currentDir.split('/').filter(Boolean);
  }, [currentDir]);

  const handleNavigate = (index: number) => {
    if (index === -1) {
      navigateTo(groupJid, '');
    } else {
      navigateTo(groupJid, breadcrumbs.slice(0, index + 1).join('/'));
    }
  };

  const handleItemClick = useCallback(
    (item: FileEntry) => {
      if (selectionMode) {
        toggleItemSelected(item.path);
        return;
      }
      if (item.type === 'directory') {
        navigateTo(groupJid, item.path);
        return;
      }

      const ext = getFileExt(item.name);

      if (IMAGE_EXTENSIONS.has(ext)) {
        setPreview({ kind: 'image', file: item });
      } else if (PDF_EXTENSIONS.has(ext)) {
        setPreview({ kind: 'pdf', file: item });
      } else if (VIDEO_EXTENSIONS.has(ext)) {
        setPreview({ kind: 'video', file: item });
      } else if (AUDIO_EXTENSIONS.has(ext)) {
        setPreview({ kind: 'audio', file: item });
      } else if (ext === 'md' && isEntryEditable(item)) {
        setPreview({ kind: 'markdown', file: item });
      } else {
        setPreview({ kind: 'text', file: item });
      }
    },
    [groupJid, navigateTo, selectionMode],
  );

  const handleDownload = (item: FileEntry) => {
    if (downloadingPaths[item.path] !== undefined) return; // 正在下载，忽略重复点击

    const encoded = toBase64Url(item.path);
    const url = `/api/groups/${encodeURIComponent(groupJid)}/files/download/${encoded}`;
    setDownloadingPaths((prev) => ({ ...prev, [item.path]: null }));

    downloadFromUrlWithProgress(url, item.name, (loaded, total) => {
      setDownloadingPaths((prev) => ({
        ...prev,
        [item.path]: total ? Math.round((loaded / total) * 100) : null,
      }));
    })
      .catch((err) => {
        console.error('Download failed:', err);
        showToast(
          '下载失败',
          err instanceof Error ? err.message : '文件下载出错，请重试',
        );
      })
      .finally(() => {
        setDownloadingPaths((prev) => {
          if (!(item.path in prev)) return prev;
          const next = { ...prev };
          delete next[item.path];
          return next;
        });
      });
  };

  const handleCopyPath = (item: FileEntry) => {
    const target = item.absolutePath || item.path;
    copyToClipboard(target)
      .then(() => showToast('已复制', target))
      .catch((err) => {
        console.error('Copy failed:', err);
        showToast(
          '复制失败',
          err instanceof Error ? err.message : '无法写入剪贴板',
        );
      });
  };

  const handleDeleteClick = (item: FileEntry) => {
    setDeleteModal({
      open: true,
      path: item.path,
      name: item.name,
      isDir: item.type === 'directory',
    });
  };

  const handleDeleteConfirm = async () => {
    setDeleteLoading(true);
    try {
      const ok = await deleteFile(groupJid, deleteModal.path);
      if (ok) {
        setDeleteModal({ open: false, path: '', name: '', isDir: false });
      }
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleBatchDeleteConfirm = async () => {
    setBatchDeleteLoading(true);
    try {
      const result = await batchDeleteFiles(groupJid, [...selectedPaths]);
      if (result.failed.length === 0) {
        showToast('已删除', `成功删除 ${result.succeeded.length} 项`);
        setSelectionMode(false);
      } else if (result.succeeded.length === 0) {
        showToast(
          '删除失败',
          result.failed[0]?.error || '所选项均删除失败，请重试',
        );
      } else {
        showToast(
          '部分删除失败',
          `成功 ${result.succeeded.length} 项，失败 ${result.failed.length} 项：${result.failed[0].error}`,
        );
      }
      setSelectedPaths(new Set());
      setBatchDeleteModal(false);
    } finally {
      setBatchDeleteLoading(false);
    }
  };

  const handleMoveConfirm = async (destination: string) => {
    const result = await moveFiles(groupJid, [...selectedPaths], destination);
    if (result.failed.length === 0) {
      showToast('已移动', `成功移动 ${result.succeeded.length} 项`);
      setSelectedPaths(new Set());
      setMoveDialogOpen(false);
      setSelectionMode(false);
      return;
    }
    if (result.succeeded.length === 0) {
      showToast('移动失败', result.failed[0]?.error || '所选项均移动失败');
      return;
    }
    showToast(
      '部分移动失败',
      `成功 ${result.succeeded.length} 项，失败 ${result.failed.length} 项：${result.failed[0].error}`,
    );
    setSelectedPaths(
      (prev) => new Set([...prev].filter((p) => !result.succeeded.includes(p))),
    );
    setMoveDialogOpen(false);
  };

  const handleRefresh = () => {
    loadFiles(groupJid, currentDir);
  };

  const handleOpenLocalFolder = async () => {
    setOpenDirLoading(true);
    setOpenDirError(null);
    try {
      await api.post(
        `/api/groups/${encodeURIComponent(groupJid)}/files/open-directory`,
        {
          path: currentDir,
        },
      );
    } catch (err) {
      if (err instanceof Error) {
        setOpenDirError(err.message);
      } else if (typeof err === 'object' && err !== null && 'message' in err) {
        setOpenDirError(String((err as { message: unknown }).message));
      } else {
        setOpenDirError('打开本地文件夹失败');
      }
    } finally {
      setOpenDirLoading(false);
    }
  };

  const handleCreateDir = () => {
    setNewDirName('');
    setCreateDirModal(true);
  };

  const handleCreateDirConfirm = async () => {
    const name = newDirName.trim();
    if (!name) return;
    setCreateDirLoading(true);
    try {
      await createDirectory(groupJid, currentDir, name);
      setCreateDirModal(false);
    } finally {
      setCreateDirLoading(false);
    }
  };

  return (
    <div className="w-full h-full border-l border-border bg-background flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="font-semibold text-foreground text-sm">
          当前上下文文件
        </h3>
        <div className="flex items-center gap-1">
          {canOpenLocalFolder && (
            <button
              onClick={handleOpenLocalFolder}
              disabled={openDirLoading}
              className="hidden md:inline-flex text-muted-foreground hover:text-foreground transition-colors p-2 rounded-md hover:bg-muted cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              title="打开工作区文件夹"
              aria-label="打开工作区文件夹"
            >
              {openDirLoading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <FolderOpen className="size-3.5" />
              )}
            </button>
          )}
          <button
            onClick={handleRefresh}
            className="text-muted-foreground hover:text-foreground transition-colors p-2 rounded-md hover:bg-muted cursor-pointer"
            title="刷新"
            aria-label="刷新文件列表"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={toggleSelectionMode}
            className={`p-2 rounded-md transition-colors cursor-pointer ${
              selectionMode
                ? 'bg-brand-50 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
            title={selectionMode ? '退出多选' : '多选'}
            aria-label={selectionMode ? '退出多选' : '多选'}
          >
            <ListChecks className="w-4 h-4" />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground transition-colors p-2 rounded-md hover:bg-muted cursor-pointer"
              aria-label="关闭文件面板"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Breadcrumb（多选时替换成批量操作工具栏） */}
      <div className="px-4 py-2 border-b border-border bg-muted">
        {selectionMode ? (
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={toggleSelectAll}
              disabled={selectableFiles.length === 0}
              className="flex flex-shrink-0 items-center gap-1.5 text-sm text-primary hover:underline cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
            >
              {allSelected ? (
                <CheckSquare className="w-4 h-4" />
              ) : (
                <Square className="w-4 h-4" />
              )}
              {allSelected ? '取消全选' : '全选'}
            </button>
            <span className="flex-1 truncate text-center text-xs text-muted-foreground">
              已选择 {selectedPaths.size} 项
            </span>
            <div className="flex flex-shrink-0 items-center gap-1">
              <button
                onClick={() => setMoveDialogOpen(true)}
                disabled={selectedPaths.size === 0}
                className="p-1.5 rounded hover:bg-background text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                title="移动到…"
                aria-label="移动所选项"
              >
                <FolderInput className="w-4 h-4" />
              </button>
              <button
                onClick={() => setBatchDeleteModal(true)}
                disabled={selectedPaths.size === 0}
                className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-950/40 text-muted-foreground hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                title="删除所选项"
                aria-label="删除所选项"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-1 text-sm overflow-x-auto">
            <button
              onClick={() => handleNavigate(-1)}
              className="text-primary hover:underline whitespace-nowrap cursor-pointer"
            >
              根目录
            </button>
            {breadcrumbs.map((crumb, index) => (
              <div key={index} className="flex items-center gap-1">
                <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <button
                  onClick={() => handleNavigate(index)}
                  className="text-primary hover:underline whitespace-nowrap cursor-pointer"
                >
                  {crumb}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {openDirError && (
        <div className="px-4 py-2 border-b border-red-100 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-xs text-red-600 dark:text-red-400">
          {openDirError}
        </div>
      )}

      {/* File List */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={fileListScrollRef}
          className="hc-scroll-pane h-full overflow-y-auto px-2 py-2"
          data-testid="file-list-scroll"
        >
          {loading && fileList.length === 0 ? (
            <div className="flex items-center justify-center h-32">
              <p className="text-sm text-muted-foreground">加载中...</p>
            </div>
          ) : sortedFiles.length === 0 ? (
            <div className="flex items-center justify-center h-32">
              <p className="text-sm text-muted-foreground">暂无文件</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {sortedFiles.map((item) => {
                const isSelected = selectedPaths.has(item.path);
                // 多选模式下，非系统项整行都用来切换选中（跟入口的"多选"按钮
                // 一起构成"先进多选模式、再点条目挑选"的两步交互）；系统项没有
                // 复选框，保持不可点。多选模式外沿用原来的预览/进入文件夹逻辑。
                const clickable = selectionMode
                  ? !item.isSystem
                  : item.type === 'directory' || isPreviewableFile(item);
                const summary = (
                  <>
                    <div className="flex-shrink-0 w-5 flex items-center justify-center">
                      {item.type === 'directory' ? (
                        <Folder className="w-4.5 h-4.5 text-primary" />
                      ) : (
                        <FileIcon name={item.name} />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`text-sm truncate ${
                            item.isSystem && !isEntryEditable(item)
                              ? 'text-muted-foreground'
                              : 'text-foreground'
                          }`}
                        >
                          {item.name}
                        </span>
                        {item.isSystem && <Badge variant="neutral">系统</Badge>}
                      </div>
                      {item.type === 'file' && (
                        <p className="text-[11px] text-muted-foreground leading-tight">
                          {formatSize(item.size)}
                        </p>
                      )}
                    </div>
                  </>
                );
                return (
                  <div
                    key={item.path}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors ${
                      isSelected
                        ? 'bg-brand-50'
                        : clickable
                          ? 'hover:bg-muted'
                          : item.isSystem
                            ? 'bg-muted/60'
                            : 'hover:bg-muted/50'
                    }`}
                  >
                    {selectionMode && !item.isSystem && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleItemSelected(item.path);
                        }}
                        className="-ml-1 flex-shrink-0 cursor-pointer p-1"
                        aria-label={isSelected ? '取消选择' : '选择'}
                      >
                        {isSelected ? (
                          <CheckSquare className="w-4.5 h-4.5 text-primary" />
                        ) : (
                          <Square className="w-4.5 h-4.5 text-muted-foreground" />
                        )}
                      </button>
                    )}
                    {clickable ? (
                      <button
                        type="button"
                        onClick={() => handleItemClick(item)}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
                      >
                        {summary}
                      </button>
                    ) : (
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        {summary}
                      </div>
                    )}

                    {/* Actions（多选模式下隐藏，靠顶部工具栏的批量操作） */}
                    {!selectionMode && (
                      <div className="flex-shrink-0 flex items-center gap-0.5">
                        {/* Copy absolute path (always available) */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopyPath(item);
                          }}
                          className="p-2.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                          title={
                            item.absolutePath
                              ? `复制路径：${item.absolutePath}`
                              : '复制路径'
                          }
                          aria-label="复制绝对路径"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                        {/* Edit button for editable text files (系统文件里的
                          CLAUDE.md 例外也可编辑，但仍然没有删除按钮) */}
                        {isEntryEditable(item) &&
                          TEXT_EXTENSIONS.has(getFileExt(item.name)) && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setPreview({ kind: 'edit', file: item });
                              }}
                              className="p-2.5 rounded hover:bg-brand-100 text-muted-foreground hover:text-primary transition-colors cursor-pointer"
                              title="编辑"
                              aria-label="编辑文件"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                          )}
                        {item.type === 'file' &&
                          (() => {
                            const progress = downloadingPaths[item.path];
                            const isDownloading = progress !== undefined;
                            return (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDownload(item);
                                }}
                                disabled={isDownloading}
                                className="p-2.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:cursor-wait disabled:hover:bg-transparent"
                                title={isDownloading ? '下载中…' : '下载'}
                                aria-label="下载文件"
                              >
                                {!isDownloading ? (
                                  <Download className="w-3.5 h-3.5" />
                                ) : progress === null ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <span className="block w-7 text-center text-[10px] font-medium tabular-nums">
                                    {progress}%
                                  </span>
                                )}
                              </button>
                            );
                          })()}
                        {!item.isSystem && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteClick(item);
                            }}
                            className="p-2.5 rounded hover:bg-red-100 dark:hover:bg-red-950/40 text-muted-foreground hover:text-red-600 dark:hover:text-red-400 transition-colors cursor-pointer"
                            title="删除"
                            aria-label="删除文件"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <ScrollEdgeAffordance scrollRef={fileListScrollRef} />
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-border space-y-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleCreateDir}
          className="w-full"
        >
          <FolderPlus className="w-4 h-4" />
          新建文件夹
        </Button>
        <FileUploadZone groupJid={groupJid} />
      </div>

      {/* Create Directory Dialog */}
      <Dialog
        open={createDirModal}
        onOpenChange={(v) => !v && setCreateDirModal(false)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>新建文件夹</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="mb-2">文件夹名称</Label>
              <Input
                type="text"
                value={newDirName}
                onChange={(e) => setNewDirName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateDirConfirm();
                }}
                placeholder="输入文件夹名称"
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setCreateDirModal(false)}
                disabled={createDirLoading}
              >
                取消
              </Button>
              <Button
                onClick={handleCreateDirConfirm}
                disabled={createDirLoading}
              >
                {createDirLoading && (
                  <Loader2 className="size-4 animate-spin" />
                )}
                创建
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <ConfirmDialog
        open={deleteModal.open}
        onClose={() =>
          setDeleteModal({ open: false, path: '', name: '', isDir: false })
        }
        onConfirm={handleDeleteConfirm}
        title={deleteModal.isDir ? '删除文件夹' : '删除文件'}
        message={
          deleteModal.isDir
            ? `确认删除文件夹「${deleteModal.name}」及其所有内容吗？此操作不可恢复。`
            : `确认删除文件「${deleteModal.name}」吗？此操作不可恢复。`
        }
        confirmText="删除"
        cancelText="取消"
        confirmVariant="danger"
        loading={deleteLoading}
      />

      {/* Batch Delete Confirm */}
      <ConfirmDialog
        open={batchDeleteModal}
        onClose={() => setBatchDeleteModal(false)}
        onConfirm={handleBatchDeleteConfirm}
        title="批量删除"
        message={`确认删除选中的 ${selectedPaths.size} 项吗？如果包含文件夹，其中所有内容也会被删除。此操作不可恢复。`}
        confirmText="删除"
        cancelText="取消"
        confirmVariant="danger"
        loading={batchDeleteLoading}
      />

      {/* Move To Dialog */}
      <MoveFilesDialog
        open={moveDialogOpen}
        groupJid={groupJid}
        itemCount={selectedPaths.size}
        excludePaths={[...selectedPaths]}
        onClose={() => setMoveDialogOpen(false)}
        onConfirm={handleMoveConfirm}
      />

      {/* Preview / Editor Overlays */}
      {preview?.kind === 'image' && (
        <ImagePreview
          groupJid={groupJid}
          file={preview.file}
          onClose={() => setPreview(null)}
        />
      )}
      {preview?.kind === 'edit' && (
        <TextEditor
          groupJid={groupJid}
          file={preview.file}
          onClose={() => setPreview(null)}
        />
      )}
      {preview?.kind === 'markdown' && (
        <MarkdownFileViewer
          groupJid={groupJid}
          file={preview.file}
          onClose={() => setPreview(null)}
        />
      )}
      {preview?.kind === 'pdf' && (
        <PdfPreview
          groupJid={groupJid}
          file={preview.file}
          onClose={() => setPreview(null)}
        />
      )}
      {preview?.kind === 'video' && (
        <VideoPreview
          groupJid={groupJid}
          file={preview.file}
          onClose={() => setPreview(null)}
        />
      )}
      {preview?.kind === 'audio' && (
        <AudioPreview
          groupJid={groupJid}
          file={preview.file}
          onClose={() => setPreview(null)}
        />
      )}
      {preview?.kind === 'text' && (
        <GenericTextPreview
          groupJid={groupJid}
          file={preview.file}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
