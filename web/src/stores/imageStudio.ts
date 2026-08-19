import { create } from 'zustand';
import { api } from '../api/client';
import { withBasePath } from '../utils/url';
import { toBase64Url } from './files';

/**
 * One generated-image entry. New rows reference a workspace-relative file
 * path (cheap listing, browser-cached preview); legacy rows may still carry
 * inline base64 data.
 */
export interface GeneratedImageEntry {
  messageId: string;
  timestamp: string;
  path?: string;
  data?: string;
  mimeType: string;
}

interface ImageStudioState {
  /** Gallery cache per workspace JID; survives page navigations. */
  galleries: Record<string, GeneratedImageEntry[]>;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;
  /** Timestamp of the last successful fetch per JID. */
  fetchedAt: Record<string, number>;
  loadGallery: (jid: string, limit?: number) => Promise<void>;
  /** Insert or refresh entries received via WebSocket without a refetch. */
  upsertEntries: (jid: string, entries: GeneratedImageEntry[]) => void;
  clearGallery: (jid: string) => void;
}

const STALE_MS = 30_000;

function entriesFromAttachments(
  messageId: string,
  timestamp: string,
  attachmentsRaw:
    | string
    | Array<{ type?: string; path?: string; data?: string; mimeType?: string }>,
): GeneratedImageEntry[] {
  let attachments: Array<{
    type?: string;
    path?: string;
    data?: string;
    mimeType?: string;
  }>;
  try {
    attachments =
      typeof attachmentsRaw === 'string'
        ? JSON.parse(attachmentsRaw)
        : (attachmentsRaw ?? []);
  } catch {
    return [];
  }
  if (!Array.isArray(attachments)) return [];
  const out: GeneratedImageEntry[] = [];
  for (const att of attachments) {
    if (att?.type !== 'image' || !att.path) continue;
    out.push({
      messageId,
      timestamp,
      path: att.path,
      mimeType: att.mimeType || 'image/png',
    });
  }
  return out;
}

/** Parse generation rows out of raw message rows (WS payloads, legacy lists). */
export function entriesFromMessageRow(row: {
  id: string;
  timestamp: string;
  sender?: string;
  attachments?:
    | string
    | Array<{ type?: string; path?: string; data?: string; mimeType?: string }>;
}): GeneratedImageEntry[] {
  if (row.sender !== '__image_generation__' || !row.attachments) return [];
  return entriesFromAttachments(row.id, row.timestamp, row.attachments);
}

/** Resolve an entry to a renderable <img src>, reusing inline base64 if present. */
export function imageEntrySrc(jid: string, entry: GeneratedImageEntry): string {
  if (entry.data) return `data:${entry.mimeType};base64,${entry.data}`;
  const encoded = toBase64Url(entry.path ?? '');
  return withBasePath(
    `/api/groups/${encodeURIComponent(jid)}/files/preview/${encoded}`,
  );
}

function dedupeSorted(entries: GeneratedImageEntry[]): GeneratedImageEntry[] {
  const seen = new Set<string>();
  const merged: GeneratedImageEntry[] = [];
  for (const entry of entries) {
    const key = entry.path || entry.data || entry.messageId;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

export const useImageStudioStore = create<ImageStudioState>((set) => ({
  galleries: {},
  loading: {},
  error: {},
  fetchedAt: {},

  loadGallery: async (jid, limit = 100) => {
    set((s) => ({ loading: { ...s.loading, [jid]: true } }));
    try {
      const res = await api.get<{ images: GeneratedImageEntry[] }>(
        `/api/groups/${encodeURIComponent(jid)}/generated-images?limit=${limit}`,
      );
      const fresh = dedupeSorted(res.images ?? []);
      set((s) => ({
        galleries: { ...s.galleries, [jid]: fresh },
        loading: { ...s.loading, [jid]: false },
        error: { ...s.error, [jid]: null },
        fetchedAt: { ...s.fetchedAt, [jid]: Date.now() },
      }));
    } catch (err) {
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message?: string }).message)
          : '加载生成记录失败，请稍后重试。';
      set((s) => ({
        loading: { ...s.loading, [jid]: false },
        error: { ...s.error, [jid]: message },
      }));
    }
  },

  upsertEntries: (jid, entries) => {
    if (entries.length === 0) return;
    set((s) => ({
      galleries: {
        ...s.galleries,
        [jid]: dedupeSorted([...entries, ...(s.galleries[jid] ?? [])]),
      },
    }));
  },

  clearGallery: (jid) => {
    set((s) => ({
      galleries: { ...s.galleries, [jid]: [] },
      error: { ...s.error, [jid]: null },
    }));
  },
}));

/**
 * Load on mount with a short staleness window: switching between pages shows
 * the cached gallery instantly and only refetches in the background when the
 * cache is older than STALE_MS.
 */
export function useGalleryWithCache(jid: string | null) {
  const gallery = useImageStudioStore((s) =>
    jid ? s.galleries[jid] : undefined,
  );
  const loading = useImageStudioStore((s) => (jid ? !!s.loading[jid] : false));
  const error = useImageStudioStore((s) => (jid ? s.error[jid] : null));
  const fetchedAt = useImageStudioStore((s) => (jid ? s.fetchedAt[jid] : 0));
  const loadGallery = useImageStudioStore((s) => s.loadGallery);
  const clearGallery = useImageStudioStore((s) => s.clearGallery);

  const hasCache = !!gallery;

  if (jid) {
    const stale = !fetchedAt || Date.now() - fetchedAt > STALE_MS;
    if (!loading && stale && !error) {
      // Fire-and-forget refresh; cache stays visible meanwhile.
      void loadGallery(jid);
    }
  }

  const refresh = () => {
    if (jid) void loadGallery(jid);
  };

  return {
    images: jid ? (gallery ?? []) : [],
    loading: loading && !hasCache,
    backgroundRefreshing: loading && hasCache,
    error: jid ? error : null,
    refresh,
    clear: () => {
      if (jid) clearGallery(jid);
    },
  };
}
