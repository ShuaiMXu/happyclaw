import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Download,
  ImagePlus,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  Wand2,
  X,
  ZoomIn,
} from 'lucide-react';
import { api, computeUploadTimeoutMs, type ApiError } from '../api/client';
import { wsManager } from '../api/ws';
import { downloadFromDataUrl, downloadFromUrl } from '../utils/download';
import { showToast } from '../utils/toast';
import { useGroupsStore } from '../stores/groups';
import {
  entriesFromMessageRow,
  fileDownloadUrl,
  filePreviewUrl,
  imageEntrySrc,
  imageEntryThumbSrc,
  useGalleryWithCache,
  useImageStudioStore,
  type GeneratedImageEntry,
} from '../stores/imageStudio';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/common/EmptyState';
import { PageHeader } from '@/components/common/PageHeader';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const STORAGE_KEY = 'happyclaw:image-studio:jid';
const PROMPT_MAX_LENGTH = 8_000;
const NOTE_MAX_LENGTH = 1_000;
const MAX_REFERENCES = 6;
const MAX_REFERENCE_FILE_BYTES = 8 * 1024 * 1024;
// References above this size are downscaled/re-encoded in the browser before
// upload: base64 inflates payloads by ~33% and slow uplinks otherwise never
// finish uploading within the request timeout (nginx logs 408/499).
const REFERENCE_COMPRESSION_THRESHOLD_BYTES = 512 * 1024;
const REFERENCE_MAX_DIMENSION = 2048;
const REFERENCE_ENCODE_QUALITY = 0.9;

const REFERENCE_ACCEPTED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

interface ReferenceDraft {
  id: string;
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  data: string; // base64
  note: string;
  previewUrl: string;
}

interface PromptPreset {
  id: string;
  label: string;
  prompt: string;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as ApiError).message) || fallback;
  }
  return fallback;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Downscale and re-encode a reference image in the browser before upload.
 * Keeps the longest edge at 2048px and re-encodes as WebP q0.9. Returns null
 * when compression is unavailable (no canvas/decode support or the result
 * would not shrink) — the caller then uploads the original bytes.
 */
async function compressReferenceImage(
  blob: Blob,
): Promise<{ blob: Blob; mimeType: ReferenceDraft['mimeType'] } | null> {
  if (
    blob.size <= REFERENCE_COMPRESSION_THRESHOLD_BYTES ||
    typeof createImageBitmap === 'undefined' ||
    typeof document === 'undefined'
  ) {
    return null;
  }
  try {
    const bitmap = await createImageBitmap(blob);
    try {
      const scale = Math.min(
        1,
        REFERENCE_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height),
      );
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const target = document.createElement('canvas');
      target.width = width;
      target.height = height;
      target.getContext('2d')?.drawImage(bitmap, 0, 0, width, height);
      const webp = await new Promise<Blob | null>((resolve) =>
        target.toBlob(resolve, 'image/webp', REFERENCE_ENCODE_QUALITY),
      );
      if (webp && webp.size < blob.size) {
        return { blob: webp, mimeType: 'image/webp' };
      }
      return null;
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

function draftId(name: string, size: number): string {
  return `${name}-${size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function fileToReference(file: File): Promise<ReferenceDraft> {
  const compressed = await compressReferenceImage(file);
  const source = compressed?.blob ?? file;
  return {
    id: draftId(file.name, source.size),
    name: file.name,
    mimeType: compressed?.mimeType ?? (file.type as ReferenceDraft['mimeType']),
    data: await blobToBase64(source),
    note: '',
    previewUrl: URL.createObjectURL(source),
  };
}

/** Re-encode an already-generated gallery image (fetched as a blob) as a reference draft. */
async function blobToGalleryReference(
  blob: Blob,
  name: string,
): Promise<ReferenceDraft | null> {
  if (!REFERENCE_ACCEPTED_MIME.has(blob.type)) return null;
  const compressed = await compressReferenceImage(blob);
  const source = compressed?.blob ?? blob;
  return {
    id: draftId(name, source.size),
    name,
    mimeType: compressed?.mimeType ?? (blob.type as ReferenceDraft['mimeType']),
    data: await blobToBase64(source),
    note: '',
    previewUrl: URL.createObjectURL(source),
  };
}

export function ImageStudioPage() {
  const groups = useGroupsStore((s) => s.groups);
  const groupsLoading = useGroupsStore((s) => s.loading);
  const loadGroups = useGroupsStore((s) => s.loadGroups);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  const enabledWorkspaces = useMemo(
    () =>
      Object.entries(groups)
        .filter(([, g]) => g.image_generation_enabled === true)
        .map(([jid, g]) => ({ jid, name: g.name || jid })),
    [groups],
  );

  const [selectedJid, setSelectedJid] = useState<string | null>(() =>
    typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null,
  );
  const selectedJidRef = useRef(selectedJid);
  selectedJidRef.current = selectedJid;

  // Auto-pick a workspace once the enabled list is known, or fall back when
  // the previously remembered workspace no longer supports image generation.
  useEffect(() => {
    if (enabledWorkspaces.length === 0) {
      if (selectedJid !== null) setSelectedJid(null);
      return;
    }
    if (!selectedJid || !enabledWorkspaces.some((w) => w.jid === selectedJid)) {
      setSelectedJid(enabledWorkspaces[0].jid);
    }
  }, [enabledWorkspaces, selectedJid]);

  useEffect(() => {
    if (selectedJid) localStorage.setItem(STORAGE_KEY, selectedJid);
    else localStorage.removeItem(STORAGE_KEY);
  }, [selectedJid]);

  const { images, loading, backgroundRefreshing, error, refresh } =
    useGalleryWithCache(selectedJid);
  const upsertEntries = useImageStudioStore((s) => s.upsertEntries);

  // Live-append images generated from other tabs/sessions for this workspace.
  useEffect(() => {
    const unsub = wsManager.on('new_message', (data: any) => {
      const jid = selectedJidRef.current;
      if (!jid || !data?.chatJid || data.chatJid !== jid) return;
      const parsed = data.message
        ? entriesFromMessageRow({
            id: data.message.id,
            timestamp: data.message.timestamp,
            sender: data.message.sender,
            attachments: data.message.attachments,
          })
        : [];
      if (parsed.length === 0) return;
      upsertEntries(jid, parsed);
    });
    return () => {
      unsub();
    };
  }, [upsertEntries]);

  const [prompt, setPrompt] = useState('');
  const [references, setReferences] = useState<ReferenceDraft[]>([]);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<GeneratedImageEntry | null>(null);
  // Whether the lightbox shows the full-resolution image instead of the
  // low-res preview; reset every time a different image is opened.
  const [lightboxOriginal, setLightboxOriginal] = useState(false);
  const openLightbox = useCallback((entry: GeneratedImageEntry) => {
    setLightboxOriginal(false);
    setLightbox(entry);
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // "下载原图": always fetches the full-resolution bytes regardless of
  // whether the grid/lightbox is currently showing the low-res preview.
  const downloadImageEntry = useCallback(
    async (jid: string, entry: GeneratedImageEntry) => {
      try {
        if (entry.path) {
          const filename =
            entry.path.split('/').pop() || `${entry.messageId}.png`;
          await downloadFromUrl(fileDownloadUrl(jid, entry.path), filename);
        } else if (entry.data) {
          const ext = entry.mimeType.split('/')[1] || 'png';
          await downloadFromDataUrl(
            `data:${entry.mimeType};base64,${entry.data}`,
            `${entry.messageId}.${ext}`,
          );
        }
      } catch (err) {
        showToast('下载失败', errorMessage(err, '图片下载失败，请稍后重试。'));
      }
    },
    [],
  );

  // Common prompt presets: platform-wide, admin-managed short-label options.
  // Loaded lazily the first time the picker is opened, not on page load.
  const [presetOpen, setPresetOpen] = useState(false);
  const [presets, setPresets] = useState<PromptPreset[] | null>(null);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [presetsError, setPresetsError] = useState<string | null>(null);

  const handlePresetOpenChange = useCallback(
    (open: boolean) => {
      setPresetOpen(open);
      if (open && presets === null && !presetsLoading) {
        setPresetsLoading(true);
        setPresetsError(null);
        api
          .get<{ presets: PromptPreset[] }>('/api/config/image-prompt-presets')
          .then((res) => setPresets(res.presets ?? []))
          .catch((err) =>
            setPresetsError(errorMessage(err, '加载常用提示词失败')),
          )
          .finally(() => setPresetsLoading(false));
      }
    },
    [presets, presetsLoading],
  );

  const applyPreset = useCallback((text: string) => {
    setPrompt((prev) => {
      const trimmedPrev = prev.trimEnd();
      if (!trimmedPrev) return text.slice(0, PROMPT_MAX_LENGTH);
      const sep = /[，,。.！!？?\s]$/.test(trimmedPrev) ? ' ' : '，';
      return `${trimmedPrev}${sep}${text}`.slice(0, PROMPT_MAX_LENGTH);
    });
    setPresetOpen(false);
  }, []);

  // Drag-and-drop from the generated-images gallery below into the reference
  // zone above: same-page drag, so the dragged entry is tracked via a ref
  // rather than serialized through dataTransfer.
  const draggedImageRef = useRef<GeneratedImageEntry | null>(null);
  const [isDraggingOverRefZone, setIsDraggingOverRefZone] = useState(false);

  // Revoke object URLs on unmount to avoid leaking blobs.
  useEffect(() => {
    return () => {
      for (const ref of references) URL.revokeObjectURL(ref.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addReferenceFiles = useCallback(async (files: FileList | File[]) => {
    setReferenceError(null);
    const incoming = Array.from(files);
    const accepted: ReferenceDraft[] = [];
    for (const file of incoming) {
      if (!REFERENCE_ACCEPTED_MIME.has(file.type)) {
        setReferenceError(
          `「${file.name}」不是支持的图片格式（仅 PNG / JPEG / WebP）。`,
        );
        continue;
      }
      if (file.size > MAX_REFERENCE_FILE_BYTES) {
        setReferenceError(`「${file.name}」超过 8 MB 参考图大小限制。`);
        continue;
      }
      accepted.push(await fileToReference(file));
    }
    if (accepted.length === 0) return;
    setReferences((prev) => {
      const next = [...prev, ...accepted];
      if (next.length > MAX_REFERENCES) {
        setReferenceError(`参考图最多 ${MAX_REFERENCES} 张。`);
        return next.slice(0, MAX_REFERENCES);
      }
      return next;
    });
  }, []);

  const addReferenceFromGalleryImage = useCallback(
    async (jid: string, entry: GeneratedImageEntry) => {
      setReferenceError(null);
      if (references.length >= MAX_REFERENCES) {
        setReferenceError(`参考图最多 ${MAX_REFERENCES} 张。`);
        return;
      }
      try {
        const res = await fetch(imageEntrySrc(jid, entry), {
          credentials: 'include',
        });
        if (!res.ok) throw new Error('图片加载失败');
        const blob = await res.blob();
        if (blob.size > MAX_REFERENCE_FILE_BYTES) {
          setReferenceError('该图片超过 8 MB 参考图大小限制。');
          return;
        }
        const name = entry.path?.split('/').pop() || `${entry.messageId}.png`;
        const ref = await blobToGalleryReference(blob, name);
        if (!ref) {
          setReferenceError(
            '该图片格式不支持作为参考图（仅 PNG / JPEG / WebP）。',
          );
          return;
        }
        setReferences((prev) => {
          if (prev.length >= MAX_REFERENCES) {
            setReferenceError(`参考图最多 ${MAX_REFERENCES} 张。`);
            return prev;
          }
          return [...prev, ref];
        });
      } catch (err) {
        setReferenceError(errorMessage(err, '添加参考图失败，请稍后重试。'));
      }
    },
    [references.length],
  );

  const removeReference = useCallback((id: string) => {
    setReferences((prev) => {
      const target = prev.find((r) => r.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((r) => r.id !== id);
    });
  }, []);

  const updateReferenceNote = useCallback((id: string, note: string) => {
    setReferences((prev) =>
      prev.map((r) => (r.id === id ? { ...r, note } : r)),
    );
  }, []);

  // "Reuse recipe": load a previously generated image's prompt and reference
  // images back into the composer so the user can tweak and regenerate.
  const [applyingRecipeId, setApplyingRecipeId] = useState<string | null>(null);

  const applyRecipe = useCallback(
    async (jid: string, entry: GeneratedImageEntry) => {
      const recipe = entry.recipe;
      if (!recipe) {
        setGenerateError('这张图片是旧版本生成的，没有保存可复用的生成参数。');
        return;
      }
      setGenerateError(null);
      setReferenceError(null);
      setApplyingRecipeId(entry.messageId);
      try {
        setPrompt(recipe.prompt.slice(0, PROMPT_MAX_LENGTH));
        const nextRefs: ReferenceDraft[] = [];
        let missing = 0;
        for (const ref of recipe.references ?? []) {
          try {
            const res = await fetch(filePreviewUrl(jid, ref.path), {
              credentials: 'include',
            });
            if (!res.ok) throw new Error('图片加载失败');
            const blob = await res.blob();
            const name = ref.path.split('/').pop() || 'reference';
            const draft = await blobToGalleryReference(blob, name);
            if (!draft) {
              missing += 1;
              continue;
            }
            nextRefs.push({ ...draft, note: ref.note ?? '' });
          } catch {
            missing += 1;
          }
        }
        setReferences((prev) => {
          for (const r of prev) URL.revokeObjectURL(r.previewUrl);
          return nextRefs.slice(0, MAX_REFERENCES);
        });
        if (missing > 0) {
          setReferenceError(
            `已应用配方，但有 ${missing} 张参考图无法加载（可能已被删除）。`,
          );
        }
      } finally {
        setApplyingRecipeId(null);
      }
    },
    [],
  );

  // Delete a generated image: destructive, so it always goes through a
  // second confirmation before the file and message row are removed.
  const [deleteTarget, setDeleteTarget] = useState<GeneratedImageEntry | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const removeEntry = useImageStudioStore((s) => s.removeEntry);

  const confirmDelete = useCallback(async () => {
    const jid = selectedJid;
    const target = deleteTarget;
    if (!jid || !target) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.delete(
        `/api/groups/${encodeURIComponent(jid)}/generated-images/${encodeURIComponent(target.messageId)}`,
      );
      removeEntry(jid, target.messageId);
      setLightbox((cur) => (cur?.messageId === target.messageId ? null : cur));
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(errorMessage(err, '删除失败，请稍后重试。'));
    } finally {
      setDeleting(false);
    }
  }, [selectedJid, deleteTarget, removeEntry]);

  const handleGenerate = async () => {
    const trimmed = prompt.trim();
    if (!trimmed) {
      setGenerateError('请先输入图片描述，再点击生成图片。');
      return;
    }
    const jid = selectedJid;
    if (!jid || generating) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const body: {
        prompt: string;
        references?: Array<{ data: string; mimeType: string; note?: string }>;
      } = { prompt: trimmed };
      if (references.length > 0) {
        body.references = references.map((ref) => ({
          data: ref.data,
          mimeType: ref.mimeType,
          ...(ref.note.trim() ? { note: ref.note.trim() } : {}),
        }));
      }
      // Upload size scales with base64 reference images; timeout accordingly.
      const payloadBytes = JSON.stringify(body).length;
      const timeoutMs = Math.max(130_000, computeUploadTimeoutMs(payloadBytes));
      await api.post(
        `/api/groups/${encodeURIComponent(jid)}/generate-image`,
        body,
        timeoutMs,
      );
      setPrompt('');
      // Keep references attached: iterative image-to-image workflows usually
      // tweak the prompt between runs with the same source images.
      await refresh();
    } catch (err) {
      setGenerateError(errorMessage(err, '图片生成失败，请稍后重试。'));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="min-h-full bg-background">
      <div className="mx-auto max-w-5xl p-4 sm:p-6">
        <PageHeader
          title="生图"
          subtitle="输入描述直接生成图片；可附加多张参考图并分别说明各自要参考的内容"
          className="mb-5"
          actions={
            enabledWorkspaces.length > 0 && (
              <Button
                variant="outline"
                onClick={() => selectedJid && refresh()}
                disabled={!selectedJid}
              >
                <RefreshCw
                  className={backgroundRefreshing ? 'animate-spin' : ''}
                />
                刷新
              </Button>
            )
          }
        />

        {enabledWorkspaces.length === 0 ? (
          <EmptyState
            icon={ImagePlus}
            title={groupsLoading ? '正在加载工作区…' : '还没有工作区开启生图'}
            description="前往任意工作区的对话设置，开启「生图」开关并选择模型后，即可在这里直接输入描述生成图片。"
            action={
              !groupsLoading && (
                <Link to="/chat">
                  <Button>前往工作台</Button>
                </Link>
              )
            }
          />
        ) : (
          <>
            <div className="mb-4 flex items-center gap-3">
              <span className="shrink-0 text-sm text-muted-foreground">
                工作区
              </span>
              <Select
                value={selectedJid ?? undefined}
                onValueChange={setSelectedJid}
              >
                <SelectTrigger className="w-full sm:w-72">
                  <SelectValue placeholder="选择工作区" />
                </SelectTrigger>
                <SelectContent>
                  {enabledWorkspaces.map((w) => (
                    <SelectItem key={w.jid} value={w.jid}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Card className="mb-6">
              <CardContent className="p-4 sm:p-5">
                {/* Reference images */}
                {/*
                  The inner element uses an equal p-1/-m-1 pair so the drag-hover
                  highlight can extend slightly beyond the content without
                  shifting layout. Because -m-1 is a shorthand (all sides), it
                  would otherwise cancel out a bottom margin placed on the same
                  element — so the gap before the prompt textarea below lives on
                  this outer wrapper instead.
                */}
                <div className="mb-3">
                  <div
                    className={cn(
                      'rounded-lg p-1 -m-1 transition-colors',
                      isDraggingOverRefZone && 'bg-accent ring-2 ring-primary',
                    )}
                    onDragOver={(e) => {
                      // Accept both the in-page gallery drag (tracked via ref)
                      // and files dragged in from outside the browser window.
                      const isExternalFiles =
                        e.dataTransfer.types.includes('Files');
                      if (!draggedImageRef.current && !isExternalFiles) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'copy';
                      setIsDraggingOverRefZone(true);
                    }}
                    onDragLeave={() => setIsDraggingOverRefZone(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setIsDraggingOverRefZone(false);
                      if (e.dataTransfer.files?.length) {
                        // Dropped from outside the browser (Finder/Explorer/desktop).
                        draggedImageRef.current = null;
                        void addReferenceFiles(e.dataTransfer.files);
                        return;
                      }
                      const entry = draggedImageRef.current;
                      draggedImageRef.current = null;
                      if (entry && selectedJid) {
                        void addReferenceFromGalleryImage(selectedJid, entry);
                      }
                    }}
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">
                        参考图（可选，最多 {MAX_REFERENCES} 张）
                      </span>
                      <span className="text-xs text-muted-foreground">
                        图生图模式：可为每张参考图单独填写要参考的内容；也可把下方已生成的图片或电脑里的图片文件拖到这里
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      {references.map((ref, index) => (
                        <div
                          key={ref.id}
                          className="w-36 overflow-hidden rounded-lg border border-border"
                        >
                          <div className="group relative">
                            <img
                              src={ref.previewUrl}
                              alt={ref.name}
                              className="aspect-square w-full object-cover"
                            />
                            <button
                              type="button"
                              aria-label="移除参考图"
                              onClick={() => removeReference(ref.id)}
                              className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
                              {index + 1}
                            </span>
                          </div>
                          <div className="p-1.5">
                            <Input
                              value={ref.note}
                              onChange={(e) =>
                                updateReferenceNote(ref.id, e.target.value)
                              }
                              placeholder={`第 ${index + 1} 张参考什么`}
                              maxLength={NOTE_MAX_LENGTH}
                              className="h-7 border-none px-1 text-xs shadow-none focus-visible:ring-0"
                              disabled={generating}
                            />
                          </div>
                        </div>
                      ))}
                      {references.length < MAX_REFERENCES && (
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={generating}
                          className="flex aspect-square w-36 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
                        >
                          <ImagePlus className="h-5 w-5" />
                          <span className="text-xs">添加参考图</span>
                        </button>
                      )}
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files?.length) {
                          void addReferenceFiles(e.target.files);
                        }
                        e.target.value = '';
                      }}
                    />
                    {referenceError && (
                      <p className="mt-2 text-sm text-destructive">
                        {referenceError}
                      </p>
                    )}
                  </div>
                </div>

                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={
                    references.length > 0
                      ? '描述要生成的图片，例如：以第 1 张的角色造型放进第 2 张的海边场景'
                      : '描述你想生成的图片，例如：夕阳下沙漠中的一只橙色刺猬'
                  }
                  maxLength={PROMPT_MAX_LENGTH}
                  rows={3}
                  disabled={generating}
                  onKeyDown={(e) => {
                    if (
                      (e.metaKey || e.ctrlKey) &&
                      e.key === 'Enter' &&
                      !generating
                    ) {
                      e.preventDefault();
                      void handleGenerate();
                    }
                  }}
                />
                {generateError && (
                  <p className="mt-2 text-sm text-destructive">
                    {generateError}
                  </p>
                )}
                <div className="mt-3 flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {prompt.length}/{PROMPT_MAX_LENGTH}
                  </span>
                  <div className="flex items-center gap-2">
                    <Popover
                      open={presetOpen}
                      onOpenChange={handlePresetOpenChange}
                    >
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={generating}
                        >
                          <Wand2 />
                          常用提示词
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-80">
                        {presetsLoading ? (
                          <div className="flex items-center gap-2 px-1 py-1 text-sm text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            加载中…
                          </div>
                        ) : presetsError ? (
                          <p className="px-1 py-1 text-sm text-destructive">
                            {presetsError}
                          </p>
                        ) : presets && presets.length > 0 ? (
                          <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
                            {presets.map((p) => (
                              <button
                                key={p.id}
                                type="button"
                                onClick={() => applyPreset(p.prompt)}
                                title={p.prompt}
                                className="rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                              >
                                {p.label}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="px-1 py-1 text-sm text-muted-foreground">
                            还没有配置常用提示词，可在系统设置「执行与容量」中添加。
                          </p>
                        )}
                      </PopoverContent>
                    </Popover>
                    <Button
                      onClick={() => void handleGenerate()}
                      disabled={generating || !prompt.trim()}
                    >
                      {generating ? (
                        <>
                          <Loader2 className="animate-spin" />
                          正在生成…
                        </>
                      ) : (
                        <>
                          <Sparkles />
                          生成图片
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {error && <p className="mb-4 text-sm text-destructive">{error}</p>}

            {loading && images.length === 0 ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="aspect-square rounded-lg" />
                ))}
              </div>
            ) : images.length === 0 ? (
              <EmptyState
                icon={ImagePlus}
                title="还没有生成过图片"
                description="在上面输入描述并点击「生成图片」，结果会显示在这里。"
              />
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {images.map((img) => (
                  <div
                    key={img.path || img.messageId}
                    draggable
                    onDragStart={(e) => {
                      draggedImageRef.current = img;
                      e.dataTransfer.effectAllowed = 'copy';
                      // Firefox requires setData() for a drag to actually start.
                      e.dataTransfer.setData('text/plain', img.messageId);
                      // Chromium: a "DownloadURL" record lets the image be
                      // dragged out of the browser window (e.g. onto the
                      // desktop) to save it as a file, even though the <img>
                      // itself is non-draggable below (native image drag
                      // would otherwise fight the drag-to-reference gesture).
                      if (selectedJid && img.path) {
                        const absoluteUrl = new URL(
                          fileDownloadUrl(selectedJid, img.path),
                          window.location.origin,
                        ).toString();
                        const filename =
                          img.path.split('/').pop() || `${img.messageId}.png`;
                        e.dataTransfer.setData(
                          'DownloadURL',
                          `${img.mimeType}:${filename}:${absoluteUrl}`,
                        );
                      }
                    }}
                    onDragEnd={() => {
                      draggedImageRef.current = null;
                    }}
                    className="group relative aspect-square cursor-grab overflow-hidden rounded-lg border border-border bg-muted active:cursor-grabbing"
                  >
                    <button
                      type="button"
                      onClick={() => openLightbox(img)}
                      title="可拖拽到上方参考图区域、或拖出浏览器窗口保存"
                      className="absolute inset-0"
                    >
                      <img
                        src={
                          selectedJid
                            ? imageEntryThumbSrc(selectedJid, img)
                            : ''
                        }
                        alt="生成的图片"
                        loading="lazy"
                        draggable={false}
                        className="h-full w-full object-cover transition-transform group-hover:scale-105"
                      />
                    </button>
                    <div className="pointer-events-none absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        aria-label="设为参考图"
                        title="把这张图加入上方参考图区域，作为下一次生成的参考"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (selectedJid) {
                            void addReferenceFromGalleryImage(selectedJid, img);
                          }
                        }}
                        className="pointer-events-auto rounded-full bg-black/60 p-1.5 text-white transition-colors hover:bg-black/80"
                      >
                        <ImagePlus className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label="下载原图"
                        title="下载原始分辨率图片"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (selectedJid)
                            void downloadImageEntry(selectedJid, img);
                        }}
                        className="pointer-events-auto rounded-full bg-black/60 p-1.5 text-white transition-colors hover:bg-black/80"
                      >
                        <Download className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label="复用配方"
                        title="把这张图的提示词和参考图重新载入上方，方便微调"
                        disabled={applyingRecipeId === img.messageId}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (selectedJid) void applyRecipe(selectedJid, img);
                        }}
                        className="pointer-events-auto rounded-full bg-black/60 p-1.5 text-white transition-colors hover:bg-black/80 disabled:opacity-60"
                      >
                        {applyingRecipeId === img.messageId ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        aria-label="删除图片"
                        title="删除这张图片"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteError(null);
                          setDeleteTarget(img);
                        }}
                        className="pointer-events-auto rounded-full bg-black/60 p-1.5 text-white transition-colors hover:bg-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {lightbox && selectedJid && (
          <div
            role="dialog"
            aria-modal="true"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
            onClick={() => setLightbox(null)}
          >
            <img
              src={
                lightboxOriginal
                  ? imageEntrySrc(selectedJid, lightbox)
                  : imageEntryThumbSrc(selectedJid, lightbox)
              }
              alt="生成的图片"
              className="max-h-full max-w-full rounded-lg object-contain"
              onClick={(e) => e.stopPropagation()}
            />
            <div
              className="absolute bottom-6 left-1/2 flex max-w-full -translate-x-1/2 flex-wrap justify-center gap-2 px-2"
              onClick={(e) => e.stopPropagation()}
            >
              {!lightboxOriginal && lightbox.path && (
                <Button
                  variant="secondary"
                  onClick={() => setLightboxOriginal(true)}
                >
                  <ZoomIn />
                  查看原图
                </Button>
              )}
              <Button
                variant="secondary"
                onClick={() => void downloadImageEntry(selectedJid, lightbox)}
              >
                <Download />
                下载原图
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  void addReferenceFromGalleryImage(selectedJid, lightbox)
                }
              >
                <ImagePlus />
                设为参考图
              </Button>
              <Button
                variant="secondary"
                disabled={applyingRecipeId === lightbox.messageId}
                onClick={() => void applyRecipe(selectedJid, lightbox)}
              >
                {applyingRecipeId === lightbox.messageId ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <RotateCcw />
                )}
                复用配方
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setDeleteError(null);
                  setDeleteTarget(lightbox);
                }}
              >
                <Trash2 />
                删除
              </Button>
            </div>
            <button
              type="button"
              onClick={() => setLightbox(null)}
              aria-label="关闭"
              className="absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
            >
              <X />
            </button>
          </div>
        )}

        <ConfirmDialog
          open={deleteTarget !== null}
          onClose={() => {
            if (!deleting) {
              setDeleteTarget(null);
              setDeleteError(null);
            }
          }}
          onConfirm={() => void confirmDelete()}
          title="删除这张图片？"
          message={
            deleteError ??
            '删除后无法恢复，该图片会从生成记录中永久移除。确定要删除吗？'
          }
          messageClassName={deleteError ? 'text-destructive' : undefined}
          confirmText="删除"
          confirmVariant="danger"
          loading={deleting}
        />
      </div>
    </div>
  );
}
