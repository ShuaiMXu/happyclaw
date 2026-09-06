import { create } from 'zustand';
import { api, apiFetch, computeUploadTimeoutMs } from '../api/client';
import { showToast } from '../utils/toast';

/**
 * 上传重试。慢速或不稳定链路上单次上传失败非常常见（反代读请求体超时 → 408，
 * 客户端 abort → 网络错误），此前任何一次失败都会让整批上传中断、用户必须
 * 手动从头再来。服务端按文件名 O_TRUNC 覆盖写，重传同一文件是幂等的。
 */
const UPLOAD_MAX_ATTEMPTS = 3;
const UPLOAD_RETRY_DELAYS_MS = [2000, 5000];
const UPLOAD_CANCELLED = Symbol('upload-cancelled');
let activeUploadController: AbortController | null = null;

/**
 * 只重试传输层的瞬时失败：
 * - 0：apiFetch 归一化后的网络错误
 * - 408：客户端超时 abort，或反向代理读请求体超时
 * - 502/503/504：上游短暂不可用
 * 其余（400 参数错误、403 配额或路径拒绝、413 超限、500 逻辑错误）重试没有意义，
 * 立即失败，让用户看到真实原因而不是等三轮。
 */
function isRetriableUploadError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  return (
    status === 0 ||
    status === 408 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

/** apiFetch 抛出的 ApiError 是纯对象而非 Error，直接用 instanceof 会丢掉真实原因。 */
function uploadErrorMessage(err: unknown): string {
  const e = err as { message?: string; status?: number } | null;
  if (e?.status === 0) return '网络连接失败，请检查网络后重试';
  if (e?.status === 408) return '上传超时，请检查网络后重试';
  if (e?.status && [502, 503, 504].includes(e.status)) {
    return '上传服务暂时不可用，请稍后重试';
  }
  if (typeof e?.message === 'string' && e.message.trim()) {
    const message = e.message.trim().slice(0, 200);
    return e.status ? `${message} (HTTP ${e.status})` : message;
  }
  if (err instanceof Error && err.message.trim()) {
    return err.message.trim().slice(0, 200);
  }
  return '文件上传失败，请稍后重试';
}

function waitForUploadRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(UPLOAD_CANCELLED);
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(UPLOAD_CANCELLED);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
  isSystem: boolean;
  /** 后端是否允许编辑内容。系统文件默认 false，工作区 CLAUDE.md 是例外。 */
  editable?: boolean;
  absolutePath?: string;
}

export interface UploadProgress {
  total: number;
  completed: number;
  currentFile: string;
  /** bytes for current batch */
  totalBytes: number;
  uploadedBytes: number;
  /** 当前实际请求轮次（首轮为 1）。 */
  attempt: number;
  maxAttempts: number;
  /** true 表示上轮已失败，正在等待 nextAttempt。 */
  retrying: boolean;
  nextAttempt?: number;
  retryDelayMs?: number;
}

/** 两个上传入口共用此文案，避免重试轮次或最大次数展示不一致。 */
export function formatUploadRetryStatus(
  progress: UploadProgress,
): string | null {
  if (progress.retrying && progress.nextAttempt) {
    const seconds = Math.max(1, Math.ceil((progress.retryDelayMs ?? 0) / 1000));
    return `${seconds} 秒后重试 ${progress.nextAttempt}/${progress.maxAttempts}`;
  }
  if (progress.attempt > 1) {
    return `正在重试 ${progress.attempt}/${progress.maxAttempts}`;
  }
  return null;
}

interface FileState {
  files: Record<string, FileEntry[]>;
  currentPath: Record<string, string>;
  loading: boolean;
  uploading: boolean;
  uploadProgress: UploadProgress | null;
  error: string | null;

  loadFiles: (jid: string, path?: string) => Promise<void>;
  uploadFiles: (
    jid: string,
    files: File[],
    basePath?: string,
  ) => Promise<boolean>;
  cancelUpload: () => void;
  deleteFile: (jid: string, filePath: string) => Promise<boolean>;
  createDirectory: (
    jid: string,
    parentPath: string,
    name: string,
  ) => Promise<void>;
  navigateTo: (jid: string, path: string) => void;
  getFileContent: (jid: string, filePath: string) => Promise<string | null>;
  saveFileContent: (
    jid: string,
    filePath: string,
    content: string,
  ) => Promise<boolean>;
}

export function toBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export const useFileStore = create<FileState>((set, get) => ({
  files: {},
  currentPath: {},
  loading: false,
  uploading: false,
  uploadProgress: null,
  error: null,

  cancelUpload: () => activeUploadController?.abort(),

  loadFiles: async (jid: string, path?: string) => {
    set({ loading: true, error: null });
    try {
      const targetPath =
        path !== undefined ? path : get().currentPath[jid] || '';
      const params = new URLSearchParams();
      if (targetPath) params.set('path', targetPath);

      const data = await api.get<{ files: FileEntry[]; currentPath: string }>(
        `/api/groups/${encodeURIComponent(jid)}/files?${params}`,
      );

      set((s) => ({
        files: { ...s.files, [jid]: data.files },
        currentPath: { ...s.currentPath, [jid]: data.currentPath },
        loading: false,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load files';
      console.error('Failed to load files:', err);
      set({ loading: false, error: msg });
    }
  },

  uploadFiles: async (jid: string, files: File[], basePath?: string) => {
    if (files.length === 0 || get().uploading) return false;

    const uploadController = new AbortController();
    activeUploadController = uploadController;

    const total = files.length;
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    set({
      uploading: true,
      error: null,
      uploadProgress: {
        total,
        completed: 0,
        currentFile: files[0].name,
        totalBytes,
        uploadedBytes: 0,
        attempt: 1,
        maxAttempts: UPLOAD_MAX_ATTEMPTS,
        retrying: false,
      },
    });

    const targetBase =
      basePath !== undefined ? basePath : get().currentPath[jid] || '';
    const apiUrl = `/api/groups/${encodeURIComponent(jid)}/files`;
    let uploadedBytes = 0;
    let requestStarted = false;

    try {
      for (let i = 0; i < files.length; i++) {
        if (uploadController.signal.aborted) throw UPLOAD_CANCELLED;
        const file = files[i];

        // For folder uploads, webkitRelativePath = "folderName/sub/file.txt"
        // Extract directory portion to preserve structure
        const relativePath = file.webkitRelativePath;
        let uploadPath = targetBase;
        if (relativePath) {
          const lastSlash = relativePath.lastIndexOf('/');
          if (lastSlash > 0) {
            const dir = relativePath.substring(0, lastSlash);
            uploadPath = targetBase ? `${targetBase}/${dir}` : dir;
          }
        }

        set({
          uploadProgress: {
            total,
            completed: i,
            currentFile: file.name,
            totalBytes,
            uploadedBytes,
            attempt: 1,
            maxAttempts: UPLOAD_MAX_ATTEMPTS,
            retrying: false,
          },
        });

        // 每轮重建 FormData：body 已被上一次 fetch 消费，不能复用。
        let lastErr: unknown;
        for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
          if (uploadController.signal.aborted) throw UPLOAD_CANCELLED;
          set({
            uploadProgress: {
              total,
              completed: i,
              currentFile: file.name,
              totalBytes,
              uploadedBytes,
              attempt,
              maxAttempts: UPLOAD_MAX_ATTEMPTS,
              retrying: false,
            },
          });

          const formData = new FormData();
          formData.append('files', file);
          if (uploadPath) formData.append('path', uploadPath);

          try {
            // Once the request starts, aborting the browser fetch cannot prove
            // that the server did not commit the atomic file write before its
            // response was lost. Reconcile the directory on cancellation even
            // when this is the first file and uploadedBytes is still zero.
            requestStarted = true;
            await apiFetch(apiUrl, {
              method: 'POST',
              body: formData,
              headers: {},
              timeoutMs: computeUploadTimeoutMs(file.size),
              signal: uploadController.signal,
            });
            if (uploadController.signal.aborted) throw UPLOAD_CANCELLED;
            lastErr = undefined;
            break;
          } catch (err) {
            if (uploadController.signal.aborted || err === UPLOAD_CANCELLED) {
              throw UPLOAD_CANCELLED;
            }
            lastErr = err;
            if (
              attempt === UPLOAD_MAX_ATTEMPTS ||
              !isRetriableUploadError(err)
            ) {
              break;
            }
            const retryDelayMs = UPLOAD_RETRY_DELAYS_MS[attempt - 1] ?? 5000;
            set({
              uploadProgress: {
                total,
                completed: i,
                currentFile: file.name,
                totalBytes,
                uploadedBytes,
                attempt,
                maxAttempts: UPLOAD_MAX_ATTEMPTS,
                retrying: true,
                nextAttempt: attempt + 1,
                retryDelayMs,
              },
            });
            await waitForUploadRetry(retryDelayMs, uploadController.signal);
          }
        }
        if (lastErr) throw lastErr;

        uploadedBytes += file.size;

        set({
          uploadProgress: {
            total,
            completed: i + 1,
            currentFile: i + 1 < total ? files[i + 1].name : '',
            totalBytes,
            uploadedBytes,
            attempt: 1,
            maxAttempts: UPLOAD_MAX_ATTEMPTS,
            retrying: false,
          },
        });
      }

      // All request bodies are complete now, so hide the cancel control while
      // retaining `uploading` as a guard against a concurrent refresh/upload.
      set({ uploadProgress: null });
      // Reload file list
      await get().loadFiles(jid, targetBase);
      return true;
    } catch (err) {
      if (err === UPLOAD_CANCELLED || uploadController.signal.aborted) {
        if (requestStarted) await get().loadFiles(jid, targetBase);
        return false;
      }
      const msg = uploadErrorMessage(err);
      console.error('Failed to upload files:', err);
      set({ error: msg });
      showToast('上传失败', msg);
      return false;
    } finally {
      if (activeUploadController === uploadController) {
        activeUploadController = null;
        set({ uploading: false, uploadProgress: null });
      }
    }
  },

  deleteFile: async (jid: string, filePath: string) => {
    try {
      const encoded = toBase64Url(filePath);
      await api.delete(
        `/api/groups/${encodeURIComponent(jid)}/files/${encoded}`,
      );

      const currentPath = get().currentPath[jid] || '';
      await get().loadFiles(jid, currentPath);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete file';
      console.error('Failed to delete file:', err);
      set({ error: msg });
      return false;
    }
  },

  createDirectory: async (jid: string, parentPath: string, name: string) => {
    try {
      await api.post(`/api/groups/${encodeURIComponent(jid)}/directories`, {
        path: parentPath,
        name,
      });

      await get().loadFiles(jid, parentPath);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Failed to create directory';
      console.error('Failed to create directory:', err);
      set({ error: msg });
    }
  },

  navigateTo: (jid: string, path: string) => {
    set((s) => ({
      currentPath: { ...s.currentPath, [jid]: path },
      files: { ...s.files, [jid]: [] },
    }));
    get().loadFiles(jid, path);
  },

  getFileContent: async (jid: string, filePath: string) => {
    try {
      const encoded = toBase64Url(filePath);
      const data = await api.get<{ content: string }>(
        `/api/groups/${encodeURIComponent(jid)}/files/content/${encoded}`,
      );
      return data.content;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to read file';
      console.error('Failed to read file content:', err);
      set({ error: msg });
      return null;
    }
  },

  saveFileContent: async (jid: string, filePath: string, content: string) => {
    try {
      const encoded = toBase64Url(filePath);
      await api.put(
        `/api/groups/${encodeURIComponent(jid)}/files/content/${encoded}`,
        { content },
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save file';
      console.error('Failed to save file content:', err);
      set({ error: msg });
      return false;
    }
  },
}));
