import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Download,
  Eraser,
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
import {
  shareOrDownloadFromDataUrl,
  shareOrDownloadFromUrl,
} from '../utils/download';
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
  type ImageAspectRatio,
  type ImageQuality,
  type ReferenceDraft,
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
// finish uploading within the request timeout (nginx logs 408/499). This is
// only the compression trigger, not a hard cap — anything under it uploads
// at full native quality; MAX_REFERENCE_FILE_BYTES above is the real ceiling.
const REFERENCE_COMPRESSION_THRESHOLD_BYTES = 1024 * 1024;
const REFERENCE_MAX_DIMENSION = 2048;
const REFERENCE_ENCODE_QUALITY = 0.9;

const REFERENCE_ACCEPTED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

// iPhones save camera photos (and Live Photos) as HEIC/HEIF by default —
// only screenshots come out as PNG. Neither our own byte-sniffing
// (imageMimeType() server-side) nor sharp's build supports decoding HEIC,
// so it's accepted for *selection* here but must always be converted to
// WebP/JPEG client-side before upload (see isHeicFile/compressReferenceImage
// below) — raw HEIC bytes can never reach the server.
const HEIC_HEIF_MIME = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);

function isHeicFile(file: File): boolean {
  if (HEIC_HEIF_MIME.has(file.type.toLowerCase())) return true;
  // Some browsers/OS file pickers report an empty or generic `type` for
  // HEIC files (seen on some Android WebViews, WeChat's embedded browser,
  // and older iOS Safari) — fall back to sniffing the extension. This is
  // only a *hint* for the size-threshold bypass in compressReferenceImage
  // below — decodeToBitmap() below doesn't depend on it being right, since
  // it tries native decode first regardless and only reaches for the
  // heic2any fallback when that actually fails.
  return /\.(heic|heif)$/i.test(file.name);
}

/** Loose "is this even worth attempting to decode" pre-filter for the file
 * picker/drop zone — real gatekeeping happens at decode time
 * (fileToReference/decodeToBitmap), this just weeds out obviously-wrong
 * picks (e.g. a PDF) before spending any work on them. */
function looksLikeImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  if (isHeicFile(file)) return true;
  return /\.(png|jpe?g|webp|heic|heif|gif|bmp|tiff?|avif)$/i.test(file.name);
}

/** Thrown when an image file can't be decoded client-side at all (neither
 * natively nor via the heic2any fallback below). There's no server-side
 * fallback either, so this surfaces as an actionable error instead of
 * silently uploading bytes nothing can read. */
class ReferenceImageUndecodableError extends Error {
  constructor(readonly fileName: string) {
    super(`Could not decode image file: ${fileName}`);
  }
}

// Lazily loaded, cached — this pulls in a WASM HEIC/HEIF decoder (~2-3MB),
// so it's only fetched the first time it's actually needed, not bundled
// into the main chunk for every visitor.
let heic2anyModulePromise: Promise<typeof import('heic2any').default> | null =
  null;
function loadHeic2any() {
  if (!heic2anyModulePromise) {
    heic2anyModulePromise = import('heic2any').then((m) => m.default);
  }
  return heic2anyModulePromise;
}

/**
 * Convert a HEIC/HEIF blob to JPEG using a WASM decoder, for browsers whose
 * own `createImageBitmap` can't decode it. Safari has a native HEIC codec
 * (it's Apple's own format), but plenty of iOS *WebViews* embedded inside
 * other apps — WeChat's being the most common one users hit — run on
 * Chromium/X5 instead of Safari's engine and have no native HEIC support
 * despite running on an iPhone. Also decodes Live Photos' still frame (a
 * HEIC image sequence with the still as the primary image).
 */
async function convertHeicToJpeg(blob: Blob): Promise<Blob | null> {
  try {
    const heic2any = await loadHeic2any();
    const result = await heic2any({
      blob,
      toType: 'image/jpeg',
      quality: REFERENCE_ENCODE_QUALITY,
    });
    return (Array.isArray(result) ? result[0] : result) ?? null;
  } catch {
    return null;
  }
}

/**
 * Decode a blob to an ImageBitmap, falling back to the heic2any WASM
 * decoder when native decode fails (see convertHeicToJpeg above) instead
 * of giving up outright. Returns the already-JPEG-converted blob too, when
 * that fallback was used, so callers that need to re-encode reuse those
 * bytes rather than the original undecodable ones.
 */
async function decodeToBitmap(
  blob: Blob,
): Promise<{ bitmap: ImageBitmap; convertedBlob: Blob | null } | null> {
  try {
    return { bitmap: await createImageBitmap(blob), convertedBlob: null };
  } catch {
    const converted = await convertHeicToJpeg(blob);
    if (!converted) return null;
    try {
      return {
        bitmap: await createImageBitmap(converted),
        convertedBlob: converted,
      };
    } catch {
      return null;
    }
  }
}

// Upper bound for the lightbox zoom, both via mouse-wheel and the "1:1"
// button below — high enough that a 4K original still reaches its true
// 100%-pixel zoom level when the viewport is small.
const LIGHTBOX_MAX_ZOOM = 32;

interface PromptPreset {
  id: string;
  label: string;
  prompt: string;
}

// Only one real tier right now: the upstream image backend ignores the
// `size` request parameter and caps actual output well below "4K" (or even
// nominal "2K") regardless of what's asked for, so a real 4K/2K choice would
// be cosmetic. Kept as an array (rather than a bare constant) so recipe
// validation below stays a one-line `.some()` check.
const QUALITY_OPTIONS: Array<{ value: ImageQuality; label: string }> = [
  { value: '2k', label: '标准2K' },
];

// Aspect ratio picker: a segmented control matching the quality control's
// look. Each option shows a bold rectangle glyph (w/h drive the glyph's
// shape) when idle; the selected option shows its ratio text instead (see
// the render below). The ratio value is also revealed on hover (desktop) or
// tap (touch) via a small floating label — see `ratioHint` below.
// 'original' has no fixed w/h glyph of its own (it means "whatever the first
// reference image's ratio is") — its w/h here are unused placeholders, the
// render below special-cases it to a "原图" label instead of a glyph.
const ASPECT_RATIO_OPTIONS: Array<{
  value: ImageAspectRatio;
  w: number;
  h: number;
}> = [
  { value: 'original', w: 1, h: 1 },
  { value: '21:9', w: 21, h: 9 },
  { value: '16:9', w: 16, h: 9 },
  { value: '3:2', w: 3, h: 2 },
  { value: '4:3', w: 4, h: 3 },
  { value: '1:1', w: 1, h: 1 },
  { value: '3:4', w: 3, h: 4 },
  { value: '2:3', w: 2, h: 3 },
  { value: '9:16', w: 9, h: 16 },
];

/** Nearest fixed preset (excluding 'original' itself) for a reference
 * image's actual pixel dimensions, compared in log-ratio space so e.g. a
 * slightly-off-square image doesn't get pulled toward 21:9 over 1:1. */
function detectAspectRatioOption(dimensions: {
  width?: number;
  height?: number;
}): ImageAspectRatio | null {
  const { width, height } = dimensions;
  if (!width || !height) return null;
  const targetLogRatio = Math.log(width / height);
  let best: ImageAspectRatio = '1:1';
  let bestDiff = Infinity;
  for (const opt of ASPECT_RATIO_OPTIONS) {
    if (opt.value === 'original') continue;
    const diff = Math.abs(Math.log(opt.w / opt.h) - targetLogRatio);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = opt.value;
    }
  }
  return best;
}

/** Small rectangle glyph whose proportions mirror the aspect ratio itself. */
function AspectRatioGlyph({ w, h }: { w: number; h: number }) {
  const max = 18;
  const scale = max / Math.max(w, h);
  const width = Math.max(6, Math.round(w * scale));
  const height = Math.max(6, Math.round(h * scale));
  return (
    <span
      className="block rounded-[2px] border-2 border-current"
      style={{ width, height }}
    />
  );
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
 * Encode a canvas to a Blob, preferring WebP but verifying the browser
 * actually honored that request.
 *
 * Some WebViews (most notably WeChat's embedded browser) accept
 * `canvas.toBlob(resolve, 'image/webp', …)` without error but silently
 * encode as PNG instead — per spec, an unsupported requested type falls
 * back to PNG with no way to detect that from the call itself. Blindly
 * trusting the requested type (rather than checking the returned blob's
 * actual `.type`) mislabels the upload, which the server then rejects as
 * neither valid WebP nor matching its declared mimeType. Falling back to
 * an explicit JPEG re-encode attempt covers browsers with no WebP encoder
 * at all — JPEG canvas encoding is close to universally supported.
 */
async function encodeCanvas(
  canvas: HTMLCanvasElement,
): Promise<{ blob: Blob; mimeType: ReferenceDraft['mimeType'] } | null> {
  for (const mimeType of ['image/webp', 'image/jpeg'] as const) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, mimeType, REFERENCE_ENCODE_QUALITY),
    );
    if (blob && blob.type === mimeType) {
      return { blob, mimeType };
    }
  }
  return null;
}

/**
 * Downscale and re-encode a reference image in the browser before upload.
 * Keeps the longest edge at 2048px and re-encodes as WebP q0.9 (falling
 * back to JPEG — see encodeCanvas above). Returns null when compression is
 * unavailable (no canvas/decode support or the result would not shrink) —
 * the caller then uploads the original bytes.
 *
 * `force` bypasses both the size-threshold skip and the "only keep it if
 * smaller" check — used for HEIC/HEIF input, which can never be uploaded
 * as-is regardless of size (the server can't decode it), so re-encoding is
 * mandatory rather than an optional size optimization.
 */
async function compressReferenceImage(
  blob: Blob,
  options: { force?: boolean } = {},
): Promise<{ blob: Blob; mimeType: ReferenceDraft['mimeType'] } | null> {
  if (
    (!options.force && blob.size <= REFERENCE_COMPRESSION_THRESHOLD_BYTES) ||
    typeof createImageBitmap === 'undefined' ||
    typeof document === 'undefined'
  ) {
    return null;
  }
  const decoded = await decodeToBitmap(blob);
  if (!decoded) return null;
  // Compare against the heic2any-converted JPEG's size (if that fallback
  // was used), not the original HEIC bytes — HEIC's HEVC compression makes
  // it routinely *smaller* than any JPEG/WebP re-encode of the same photo,
  // so comparing against the original would almost always (wrongly) look
  // like the re-encode "grew" the file even though it's the only usable
  // form we have.
  const compareSize = decoded.convertedBlob?.size ?? blob.size;
  const { bitmap } = decoded;
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
    const encoded = await encodeCanvas(target);
    if (encoded && (options.force || encoded.blob.size < compareSize)) {
      return encoded;
    }
    return null;
  } finally {
    bitmap.close();
  }
}

function draftId(name: string, size: number): string {
  return `${name}-${size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Decode an image blob just far enough to read its pixel dimensions. */
async function readImageDimensions(
  blob: Blob,
): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap === 'undefined') return null;
  const decoded = await decodeToBitmap(blob);
  if (!decoded) return null;
  const { width, height } = decoded.bitmap;
  decoded.bitmap.close();
  return { width, height };
}

async function fileToReference(file: File): Promise<ReferenceDraft> {
  // Anything not already a known-good format must be converted client-side
  // before upload. HEIC/HEIF (iPhone's camera default) is the common case,
  // but forcing this off `REFERENCE_ACCEPTED_MIME` rather than isHeicFile's
  // guess also covers oddly-typed/named exports (e.g. some Live Photo
  // shares report an empty or unexpected `file.type`) — decodeToBitmap
  // tries native decode first regardless, so this doesn't cost anything
  // for files that turn out to already be fine.
  const forceConvert = !REFERENCE_ACCEPTED_MIME.has(file.type);
  const [compressed, dimensions] = await Promise.all([
    compressReferenceImage(file, { force: forceConvert }),
    readImageDimensions(file),
  ]);
  if (forceConvert && !compressed) {
    // Couldn't decode this file client-side at all — neither natively nor
    // via the heic2any fallback — and there's no server-side fallback
    // either, so this browser genuinely can't use this file as-is.
    throw new ReferenceImageUndecodableError(file.name);
  }
  const source = compressed?.blob ?? file;
  return {
    id: draftId(file.name, source.size),
    name: file.name,
    mimeType: compressed?.mimeType ?? (file.type as ReferenceDraft['mimeType']),
    data: await blobToBase64(source),
    note: '',
    previewUrl: URL.createObjectURL(source),
    width: dimensions?.width,
    height: dimensions?.height,
  };
}

/** Re-encode an already-generated gallery image (fetched as a blob) as a reference draft. */
async function blobToGalleryReference(
  blob: Blob,
  name: string,
): Promise<ReferenceDraft | null> {
  if (!REFERENCE_ACCEPTED_MIME.has(blob.type)) return null;
  const [compressed, dimensions] = await Promise.all([
    compressReferenceImage(blob),
    readImageDimensions(blob),
  ]);
  const source = compressed?.blob ?? blob;
  return {
    id: draftId(name, source.size),
    name,
    mimeType: compressed?.mimeType ?? (blob.type as ReferenceDraft['mimeType']),
    data: await blobToBase64(source),
    note: '',
    previewUrl: URL.createObjectURL(source),
    width: dimensions?.width,
    height: dimensions?.height,
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

  // Compose-panel draft (prompt/quality/aspect ratio/staged references)
  // lives in the shared store, not page-local useState, so it survives
  // navigating away from and back to this page — see stores/imageStudio.ts.
  const prompt = useImageStudioStore((s) => s.composePrompt);
  const setPrompt = useImageStudioStore((s) => s.setComposePrompt);
  const quality = useImageStudioStore((s) => s.composeQuality);
  const setQuality = useImageStudioStore((s) => s.setComposeQuality);
  const aspectRatio = useImageStudioStore((s) => s.composeAspectRatio);
  const setAspectRatio = useImageStudioStore((s) => s.setComposeAspectRatio);
  // Floating label shown above an aspect-ratio glyph: on hover for desktop,
  // briefly on tap for touch devices (which have no hover state).
  const [ratioHint, setRatioHint] = useState<ImageAspectRatio | null>(null);
  const ratioHintTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const flashRatioHint = useCallback((value: ImageAspectRatio) => {
    if (ratioHintTimeoutRef.current) clearTimeout(ratioHintTimeoutRef.current);
    setRatioHint(value);
    ratioHintTimeoutRef.current = setTimeout(() => setRatioHint(null), 1200);
  }, []);
  useEffect(() => {
    return () => {
      if (ratioHintTimeoutRef.current)
        clearTimeout(ratioHintTimeoutRef.current);
    };
  }, []);
  const references = useImageStudioStore((s) => s.composeReferences);
  const setReferences = useImageStudioStore((s) => s.setComposeReferences);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<GeneratedImageEntry | null>(null);
  // Big-view for a reference-image tile (composer above), separate from the
  // generated-image lightbox below: reference images are local blob URLs
  // with no server-side original/thumbnail pair, so this just shows the
  // already-loaded image full-size with no extra actions.
  const [refLightboxUrl, setRefLightboxUrl] = useState<string | null>(null);
  // Whether the lightbox shows the full-resolution image instead of the
  // low-res preview; reset every time a different image is opened.
  const [lightboxOriginal, setLightboxOriginal] = useState(false);
  // Zoom (wheel) / pan (drag with the left button held) state for the
  // lightbox image. Reset whenever a different image is opened.
  const [lightboxZoom, setLightboxZoom] = useState(1);
  const [lightboxPan, setLightboxPan] = useState({ x: 0, y: 0 });
  const [isPanningLightbox, setIsPanningLightbox] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const openLightbox = useCallback((entry: GeneratedImageEntry) => {
    setLightboxOriginal(false);
    setLightboxZoom(1);
    setLightboxPan({ x: 0, y: 0 });
    setLightbox(entry);
  }, []);
  // Step to the previous/next image in gallery order (`images` is sorted
  // newest-first) without leaving the lightbox — same reset-on-open
  // behavior as openLightbox above (fresh zoom/pan, re-fetch original-size
  // metadata for the new entry via the effect below keyed on `lightbox`).
  const goToLightboxOffset = useCallback(
    (offset: number) => {
      if (!lightbox) return;
      const idx = images.findIndex(
        (img) => img.messageId === lightbox.messageId,
      );
      if (idx === -1) return;
      const nextIdx = idx + offset;
      if (nextIdx < 0 || nextIdx >= images.length) return;
      openLightbox(images[nextIdx]);
    },
    [lightbox, images, openLightbox],
  );
  const goToNextLightboxImage = useCallback(
    () => goToLightboxOffset(1),
    [goToLightboxOffset],
  );
  const goToPrevLightboxImage = useCallback(
    () => goToLightboxOffset(-1),
    [goToLightboxOffset],
  );
  // Keyboard nav: → next / ← previous / Esc close. Only wired up while the
  // lightbox is actually open, so it doesn't steal arrow keys anywhere else
  // on the page (e.g. moving the caret in the prompt textarea).
  useEffect(() => {
    if (!lightbox) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        goToNextLightboxImage();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goToPrevLightboxImage();
      } else if (e.key === 'Escape') {
        setLightbox(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lightbox, goToNextLightboxImage, goToPrevLightboxImage]);
  // Dragging is only meaningful once zoomed in; reset pan whenever zoom
  // returns to the fitted (1x) view so the image re-centers.
  useEffect(() => {
    if (lightboxZoom <= 1) setLightboxPan({ x: 0, y: 0 });
  }, [lightboxZoom]);
  const handleLightboxWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setLightboxZoom((z) =>
      Math.min(LIGHTBOX_MAX_ZOOM, Math.max(1, z * factor)),
    );
  }, []);
  // Ref to the rendered <img> so the "1:1" button can measure its current
  // (fitted) box size and compute the zoom factor that makes one image
  // pixel map to one screen pixel — for pixel-level quality review.
  const lightboxImgRef = useRef<HTMLImageElement>(null);
  const handleLightboxMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (lightboxZoom <= 1 || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      panStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        panX: lightboxPan.x,
        panY: lightboxPan.y,
      };
      setIsPanningLightbox(true);
    },
    [lightboxZoom, lightboxPan],
  );
  useEffect(() => {
    if (!isPanningLightbox) return;
    const handleMove = (e: MouseEvent) => {
      setLightboxPan({
        x: panStartRef.current.panX + (e.clientX - panStartRef.current.x),
        y: panStartRef.current.panY + (e.clientY - panStartRef.current.y),
      });
    };
    const handleUp = () => setIsPanningLightbox(false);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [isPanningLightbox]);

  // Touch equivalents of the wheel-zoom / mouse-drag-pan above: two-finger
  // pinch to zoom, one-finger drag to pan once zoomed in. Kept as an
  // imperative ref (not state) since gesture math needs the exact starting
  // distance/position, not a value that's re-derived from re-renders.
  const touchGestureRef = useRef<{
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

  function touchDistance(touches: React.TouchList): number {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  // Swipe-to-navigate (previous/next image) only makes sense at the fitted
  // (1x) zoom level — once zoomed in, a horizontal drag is already spoken
  // for by panning above. Tracked separately from touchGestureRef since
  // it's resolved at release (a flick threshold), not followed live like
  // pinch/pan.
  const SWIPE_THRESHOLD_PX = 60;
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);

  const handleLightboxTouchStart = useCallback(
    (e: React.TouchEvent) => {
      swipeStartRef.current = null;
      if (e.touches.length === 2) {
        touchGestureRef.current = {
          mode: 'pinch',
          startDistance: touchDistance(e.touches),
          startZoom: lightboxZoom,
          startX: 0,
          startY: 0,
          startPanX: lightboxPan.x,
          startPanY: lightboxPan.y,
        };
      } else if (e.touches.length === 1 && lightboxZoom > 1) {
        touchGestureRef.current = {
          mode: 'pan',
          startDistance: 0,
          startZoom: lightboxZoom,
          startX: e.touches[0].clientX,
          startY: e.touches[0].clientY,
          startPanX: lightboxPan.x,
          startPanY: lightboxPan.y,
        };
      } else if (e.touches.length === 1) {
        swipeStartRef.current = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
        };
      }
    },
    [lightboxZoom, lightboxPan],
  );

  const handleLightboxTouchMove = useCallback((e: React.TouchEvent) => {
    const gesture = touchGestureRef.current;
    if (gesture.mode === 'pinch' && e.touches.length === 2) {
      e.preventDefault();
      swipeStartRef.current = null;
      const distance = touchDistance(e.touches);
      if (gesture.startDistance > 0) {
        const scale = distance / gesture.startDistance;
        setLightboxZoom(
          Math.min(LIGHTBOX_MAX_ZOOM, Math.max(1, gesture.startZoom * scale)),
        );
      }
    } else if (gesture.mode === 'pan' && e.touches.length === 1) {
      e.preventDefault();
      swipeStartRef.current = null;
      setLightboxPan({
        x: gesture.startPanX + (e.touches[0].clientX - gesture.startX),
        y: gesture.startPanY + (e.touches[0].clientY - gesture.startY),
      });
    }
  }, []);

  const handleLightboxTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      // Resolve a pending swipe (armed in touchStart, untouched by any
      // pinch/pan move above) once the finger lifts — a fast-enough
      // horizontal flick, more horizontal than vertical, steps to the
      // previous/next image.
      const swipeStart = swipeStartRef.current;
      swipeStartRef.current = null;
      if (swipeStart && e.touches.length === 0) {
        const touch = e.changedTouches[0];
        if (touch) {
          const dx = touch.clientX - swipeStart.x;
          const dy = touch.clientY - swipeStart.y;
          if (
            Math.abs(dx) >= SWIPE_THRESHOLD_PX &&
            Math.abs(dx) > Math.abs(dy) * 1.5
          ) {
            if (dx < 0) goToNextLightboxImage();
            else goToPrevLightboxImage();
          }
        }
      }

      if (e.touches.length === 0) {
        touchGestureRef.current.mode = 'none';
        return;
      }
      // One finger lifted mid-pinch: if still zoomed in, hand off to
      // panning with whichever finger remains instead of just stopping.
      if (e.touches.length === 1 && touchGestureRef.current.mode === 'pinch') {
        touchGestureRef.current =
          lightboxZoom > 1
            ? {
                mode: 'pan',
                startDistance: 0,
                startZoom: lightboxZoom,
                startX: e.touches[0].clientX,
                startY: e.touches[0].clientY,
                startPanX: lightboxPan.x,
                startPanY: lightboxPan.y,
              }
            : { ...touchGestureRef.current, mode: 'none' };
      }
    },
    [lightboxZoom, lightboxPan, goToNextLightboxImage, goToPrevLightboxImage],
  );

  // Original-file metadata (byte size + pixel dimensions) shown next to
  // "查看原图": fetched once per opened image and cached as an object URL so
  // clicking "查看原图" afterwards doesn't re-download the same bytes.
  const [originalMeta, setOriginalMeta] = useState<{
    url: string;
    width: number;
    height: number;
    sizeBytes: number;
  } | null>(null);
  useEffect(() => {
    if (!lightbox || !selectedJid || !lightbox.path) {
      setOriginalMeta(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setOriginalMeta(null);
    (async () => {
      try {
        const res = await fetch(fileDownloadUrl(selectedJid, lightbox.path!), {
          credentials: 'include',
        });
        if (!res.ok) throw new Error('failed to load original');
        const blob = await res.blob();
        const bitmap = await createImageBitmap(blob);
        const { width, height } = bitmap;
        bitmap.close();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setOriginalMeta({
          url: objectUrl,
          width,
          height,
          sizeBytes: blob.size,
        });
      } catch {
        // Metadata is a nice-to-have label suffix; silently fall back to
        // the plain "查看原图" button with no appended size/dimensions.
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [lightbox, selectedJid]);

  // "1:1": switches to the original image and zooms so its real pixel
  // dimensions map 1-for-1 to screen pixels, for precise quality review.
  // Measures the currently-rendered (fitted) box — switching between the
  // thumbnail and the original doesn't change that box since both share the
  // same aspect ratio, so this works whether or not the original is already
  // loaded.
  const handleLightbox1to1 = useCallback(() => {
    const el = lightboxImgRef.current;
    if (!el || !originalMeta) return;
    const rect = el.getBoundingClientRect();
    const unscaledWidth = rect.width / lightboxZoom;
    if (!unscaledWidth) return;
    const targetZoom = originalMeta.width / unscaledWidth;
    setLightboxOriginal(true);
    setLightboxPan({ x: 0, y: 0 });
    setLightboxZoom(Math.min(LIGHTBOX_MAX_ZOOM, Math.max(1, targetZoom)));
  }, [originalMeta, lightboxZoom]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // "下载原图": always fetches the full-resolution bytes regardless of
  // whether the grid/lightbox is currently showing the low-res preview.
  // Prefers the native share sheet on mobile (see shareOrDownloadFile's
  // docs) so "存储图像" reliably saves into the phone's photo album instead
  // of the synthetic <a download> click, which doesn't on iOS Safari.
  const downloadImageEntry = useCallback(
    async (jid: string, entry: GeneratedImageEntry) => {
      try {
        if (entry.path) {
          const filename =
            entry.path.split('/').pop() || `${entry.messageId}.png`;
          await shareOrDownloadFromUrl(
            fileDownloadUrl(jid, entry.path),
            filename,
          );
        } else if (entry.data) {
          const ext = entry.mimeType.split('/')[1] || 'png';
          await shareOrDownloadFromDataUrl(
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

  // Reference preview blob URLs are intentionally *not* revoked on unmount:
  // the draft (references included) now lives in the shared store and must
  // still render correctly if the user navigates away and back to this page.
  // They're revoked individually instead, wherever a reference is actually
  // removed or replaced (removeReference, applyRecipe below) and otherwise
  // released by the browser when the tab closes.

  const addReferenceFiles = useCallback(
    async (files: FileList | File[]) => {
      setReferenceError(null);
      const incoming = Array.from(files);
      const accepted: ReferenceDraft[] = [];
      for (const file of incoming) {
        if (!looksLikeImageFile(file)) {
          setReferenceError(`「${file.name}」不是支持的图片格式。`);
          continue;
        }
        if (file.size > MAX_REFERENCE_FILE_BYTES) {
          setReferenceError(`「${file.name}」超过 8 MB 参考图大小限制。`);
          continue;
        }
        try {
          accepted.push(await fileToReference(file));
        } catch (err) {
          if (err instanceof ReferenceImageUndecodableError) {
            setReferenceError(
              `「${err.fileName}」无法在这台设备上解析（常见于 HEIC/实况照片遇到不支持的浏览器）。请改用 Safari 上传，或先在相册里把照片导出/另存为 JPG 再试。`,
            );
          } else {
            setReferenceError(
              errorMessage(err, `「${file.name}」处理失败，请稍后重试。`),
            );
          }
        }
      }
      if (accepted.length === 0) return;
      // The very first reference image sets the composition's aspect ratio
      // (matches the semantics of the "原图" option below): auto-select the
      // preset closest to its actual pixel dimensions instead of leaving
      // whatever ratio was previously selected.
      const isFirstReference = references.length === 0;
      setReferences((prev) => {
        const next = [...prev, ...accepted];
        if (next.length > MAX_REFERENCES) {
          setReferenceError(`参考图最多 ${MAX_REFERENCES} 张。`);
          return next.slice(0, MAX_REFERENCES);
        }
        return next;
      });
      if (isFirstReference) {
        const detected = detectAspectRatioOption(accepted[0]);
        if (detected) setAspectRatio(detected);
      }
    },
    [references.length],
  );

  // Paste an image straight from the clipboard (Ctrl/Cmd+V) as a reference —
  // no need to save it to disk first and use the file picker. Goes through
  // the same addReferenceFiles pipeline (format/size validation, HEIC
  // conversion, aspect-ratio auto-detect), just fed a clipboard File instead
  // of one from an <input>. Only acts when the clipboard actually contains
  // image data — plain text paste anywhere else on the page (the prompt
  // textarea, a reference note) is untouched and keeps working normally.
  useEffect(() => {
    if (!selectedJid) return;
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length === 0) return;
      e.preventDefault();
      void addReferenceFiles(imageFiles);
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [selectedJid, addReferenceFiles]);

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
        // Same first-reference auto-detection as addReferenceFiles above.
        const isFirstReference = references.length === 0;
        setReferences((prev) => {
          if (prev.length >= MAX_REFERENCES) {
            setReferenceError(`参考图最多 ${MAX_REFERENCES} 张。`);
            return prev;
          }
          return [...prev, ref];
        });
        if (isFirstReference) {
          const detected = detectAspectRatioOption(ref);
          if (detected) setAspectRatio(detected);
        }
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
      const next = prev.filter((r) => r.id !== id);
      // "原图" has no meaning without a reference image to match — fall back
      // once the last one is removed instead of leaving a selection that
      // would fail at generate time.
      if (next.length === 0) {
        setAspectRatio((cur) => (cur === 'original' ? '4:3' : cur));
      }
      return next;
    });
  }, []);

  // Prompt/references intentionally persist across generations (so an
  // iterative image-to-image session doesn't lose its inputs) — but that
  // means a new, unrelated generation has to be started by hand, or it
  // otherwise reuses the previous prompt/reference images. This clears
  // everything in one tap for that "start fresh" case.
  const resetComposer = useCallback(() => {
    setPrompt('');
    setAspectRatio('4:3');
    setReferences((prev) => {
      for (const ref of prev) URL.revokeObjectURL(ref.previewUrl);
      return [];
    });
    setReferenceError(null);
    setGenerateError(null);
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
        setQuality(
          QUALITY_OPTIONS.some((o) => o.value === recipe.quality)
            ? (recipe.quality as ImageQuality)
            : '2k',
        );
        setAspectRatio(
          ASPECT_RATIO_OPTIONS.some((o) => o.value === recipe.aspectRatio)
            ? (recipe.aspectRatio as ImageAspectRatio)
            : '4:3',
        );
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
        quality: ImageQuality;
        aspectRatio: ImageAspectRatio;
        references?: Array<{ data: string; mimeType: string; note?: string }>;
      } = { prompt: trimmed, quality, aspectRatio };
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
      // Keep the prompt and references attached after a successful
      // generation — iterative image-to-image workflows usually tweak the
      // prompt between runs with the same source images, and clearing them
      // immediately loses that context.
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
                        {/* Mobile: just "参考图" — the count/explanation
                            text crowded the row on narrow screens. Desktop
                            keeps the fuller label. */}
                        <span className="sm:hidden">参考图</span>
                        <span className="hidden sm:inline">
                          参考图（可选，最多 {MAX_REFERENCES} 张）
                        </span>
                      </span>
                      <span className="hidden text-xs text-muted-foreground sm:inline">
                        图生图模式：可为每张参考图单独填写要参考的内容；也可把下方已生成的图片或电脑里的图片文件拖到这里，或直接粘贴剪贴板里的图片
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
                              // object-contain (not cover) so the longest edge
                              // fills the frame and the whole image — including
                              // its true aspect ratio — stays visible.
                              className="aspect-square w-full cursor-zoom-in bg-muted object-contain"
                              onClick={() => setRefLightboxUrl(ref.previewUrl)}
                            />
                            <button
                              type="button"
                              aria-label="移除参考图"
                              onClick={() => removeReference(ref.id)}
                              // Hover-to-reveal only works with a mouse — on
                              // touch there's no hover state, so the button
                              // would never become reachable. Show it
                              // unconditionally below the desktop breakpoint.
                              className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white opacity-100 transition-opacity lg:opacity-0 lg:group-hover:opacity-100"
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
                      accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif"
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

                <div className="relative">
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
                    className="pb-6 pr-8"
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
                  {/* One-tap clear — holding backspace to empty a long
                      prompt is painful on a mobile keyboard. */}
                  {prompt.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setPrompt('')}
                      disabled={generating}
                      aria-label="清空提示词"
                      title="清空提示词"
                      className="absolute right-2 top-2 rounded-full p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {/* Character count, tucked into the textarea's own corner
                      instead of a separate row, to save vertical space. */}
                  <span className="pointer-events-none absolute bottom-1.5 right-2 rounded bg-background/80 px-1 text-[11px] text-muted-foreground">
                    {prompt.length}/{PROMPT_MAX_LENGTH}
                  </span>
                </div>
                {generateError && (
                  <p className="mt-2 text-sm text-destructive">
                    {generateError}
                  </p>
                )}

                {/* Basic image options + actions share one row with the
                    generate button, instead of a dedicated row, to save
                    space. Aspect ratio is shown as small shape glyphs (not
                    text) with the exact ratio revealed on hover/tap. */}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
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
                    <PopoverContent align="start" className="w-80">
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

                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">
                        画质
                      </span>
                      {/* Only one real tier exists right now (see
                          QUALITY_OPTIONS above) — this isn't a picker, just a
                          fixed, already-selected label. Clicking it explains
                          why instead of doing nothing silently. */}
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            disabled={generating}
                            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
                          >
                            {QUALITY_OPTIONS[0].label}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent
                          side="top"
                          align="start"
                          className="w-auto px-3 py-1.5 text-xs"
                        >
                          暂不支持更高分辨率
                        </PopoverContent>
                      </Popover>
                    </div>
                    <div className="flex flex-wrap items-start gap-1.5">
                      <span className="pt-1 text-xs text-muted-foreground">
                        画幅
                      </span>
                      {/* Individually-bordered pills (not one continuous
                          strip) so this wraps onto a second line cleanly on
                          narrow/portrait screens instead of overflowing or
                          getting clipped — 9 options don't fit one row on a
                          phone. Idle options show a bold shape glyph; the
                          selected option shows its ratio text instead. */}
                      <div className="flex flex-wrap gap-1">
                        {ASPECT_RATIO_OPTIONS.map((opt) => {
                          const isOriginal = opt.value === 'original';
                          // "原图" has no ratio of its own to show as a
                          // glyph — always render its text label — and
                          // needs a reference image to derive a ratio from.
                          const needsReference =
                            isOriginal && references.length === 0;
                          const label = isOriginal ? '原图' : opt.value;
                          return (
                            <div key={opt.value} className="relative">
                              <button
                                type="button"
                                disabled={generating || needsReference}
                                aria-label={`画幅 ${label}`}
                                title={
                                  needsReference
                                    ? '需要先添加一张参考图，才能按其比例生成'
                                    : isOriginal
                                      ? '不限制比例，与第一张参考图完全一致'
                                      : undefined
                                }
                                onMouseEnter={() => setRatioHint(opt.value)}
                                onMouseLeave={() =>
                                  setRatioHint((cur) =>
                                    cur === opt.value ? null : cur,
                                  )
                                }
                                onFocus={() => setRatioHint(opt.value)}
                                onBlur={() =>
                                  setRatioHint((cur) =>
                                    cur === opt.value ? null : cur,
                                  )
                                }
                                onClick={() => {
                                  setAspectRatio(opt.value);
                                  flashRatioHint(opt.value);
                                }}
                                className={cn(
                                  'flex h-7 min-w-7 items-center justify-center rounded-md border px-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                                  aspectRatio === opt.value
                                    ? 'border-primary bg-primary text-primary-foreground'
                                    : // text-muted-foreground was too light for
                                      // the glyph's border-current outline to
                                      // read clearly — darker gray instead.
                                      'border-border bg-background text-slate-600 hover:bg-accent hover:text-foreground dark:text-slate-300',
                                )}
                              >
                                {isOriginal || aspectRatio === opt.value ? (
                                  label
                                ) : (
                                  <AspectRatioGlyph w={opt.w} h={opt.h} />
                                )}
                              </button>
                              {ratioHint === opt.value &&
                                aspectRatio !== opt.value &&
                                !isOriginal && (
                                  <span className="pointer-events-none absolute -top-6 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-[10px] font-medium text-background">
                                    {opt.value}
                                  </span>
                                )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Prompt/references persist across generations by
                        design (see resetComposer above) — this is the
                        "start a totally unrelated generation" escape
                        hatch, so results don't unintentionally carry over
                        old context. */}
                    {(prompt.length > 0 || references.length > 0) && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={resetComposer}
                        disabled={generating}
                        title="清空提示词和参考图，开始全新的一次生成"
                      >
                        <Eraser />
                        清空全部
                      </Button>
                    )}
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
                    {/* Same hover-reveal-on-desktop-only treatment as the
                        reference-image remove button above: there's no
                        hover on touch, so these need to stay visible on
                        mobile or they're simply unreachable. */}
                    <div className="pointer-events-none absolute right-1 top-1 flex gap-1 opacity-100 transition-opacity lg:opacity-0 lg:group-hover:opacity-100">
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
            /* The mobile floating bottom nav bar (.floating-nav-container)
               sits at z-index 10000 at roughly the same bottom offset as
               this lightbox's action buttons — without a higher z-index
               here it visually overlaps and intercepts taps meant for
               "下载原图" etc. */
            className="fixed inset-0 z-[10050] flex items-center justify-center overflow-hidden bg-black/80 p-4"
            onClick={() => setLightbox(null)}
            onWheel={handleLightboxWheel}
          >
            <img
              ref={lightboxImgRef}
              src={
                lightboxOriginal
                  ? (originalMeta?.url ?? imageEntrySrc(selectedJid, lightbox))
                  : imageEntryThumbSrc(selectedJid, lightbox)
              }
              alt="生成的图片"
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              className={cn(
                // touch-none hands pinch/pan entirely to our own gesture
                // handlers below — without it the browser's native
                // pinch-zoom/scroll fights with (or just wins over) ours.
                'max-h-full max-w-full touch-none rounded-lg object-contain select-none',
                isPanningLightbox
                  ? 'cursor-grabbing'
                  : lightboxZoom > 1
                    ? 'cursor-grab'
                    : 'cursor-default',
                !isPanningLightbox && 'transition-transform duration-100',
              )}
              style={{
                transform: `translate(${lightboxPan.x}px, ${lightboxPan.y}px) scale(${lightboxZoom})`,
              }}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={handleLightboxMouseDown}
              onTouchStart={handleLightboxTouchStart}
              onTouchMove={handleLightboxTouchMove}
              onTouchEnd={handleLightboxTouchEnd}
            />
            <div
              className="absolute bottom-6 left-1/2 flex max-w-full -translate-x-1/2 flex-wrap justify-center gap-2 px-2"
              onClick={(e) => e.stopPropagation()}
            >
              {originalMeta && (
                <Button
                  variant="secondary"
                  onClick={handleLightbox1to1}
                  title="按图片实际像素 100% 显示，方便逐像素校对画质"
                >
                  1:1
                </Button>
              )}
              {!lightboxOriginal && lightbox.path && (
                <Button
                  variant="secondary"
                  onClick={() => setLightboxOriginal(true)}
                >
                  <ZoomIn />
                  查看原图
                  {originalMeta &&
                    ` (${Math.round(originalMeta.sizeBytes / 1024)} KB, ${originalMeta.width}×${originalMeta.height})`}
                </Button>
              )}
              <Button
                variant="secondary"
                onClick={() => void downloadImageEntry(selectedJid, lightbox)}
              >
                <Download />
                下载原图
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

        {refLightboxUrl && (
          <div
            role="dialog"
            aria-modal="true"
            // Same z-index reasoning as the lightbox above — stay above the
            // mobile floating bottom nav bar.
            className="fixed inset-0 z-[10050] flex items-center justify-center overflow-hidden bg-black/80 p-4"
            onClick={() => setRefLightboxUrl(null)}
          >
            <img
              src={refLightboxUrl}
              alt="参考图"
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              className="max-h-full max-w-full rounded-lg object-contain select-none"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              type="button"
              onClick={() => setRefLightboxUrl(null)}
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
