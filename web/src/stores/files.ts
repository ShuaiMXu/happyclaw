import { create } from 'zustand';
import { api, apiFetch, computeUploadTimeoutMs } from '../api/client';

// 大文件走分片上传：固定 4MB 一片，与后端 FILE_CHUNK_MAX_BYTES 校验对齐
// （见 src/http-upload-policy.ts）。每片是独立的小请求，超时窗口固定且很短，
// 不随文件总大小增长；单片失败只重试这一片，不用整份重传；每片写盘成功
// 就能推进进度条，慢网络下也能连续看到进度在走，而不是长时间原地不动。
const CHUNK_SIZE = 4 * 1024 * 1024;
// 超过这个阈值才走分片；小文件直接单次上传，省掉分片/拼接的开销和请求数。
const CHUNKED_UPLOAD_THRESHOLD = 8 * 1024 * 1024;
const CHUNK_MAX_RETRIES = 3;

function generateUploadId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把一个大文件按 CHUNK_SIZE 切片依次上传。每片成功后通过 onChunkUploaded
 * 上报本片字节数，调用方据此推进 uploadedBytes，让进度条连续走动。
 * 单片失败会退避重试（1s/3s/9s），仍失败则清理服务端已收分片并抛错，
 * 让调用方按整份文件失败处理（用户可以重新发起这一个文件的上传）。
 */
async function uploadFileInChunks(
  jid: string,
  file: File,
  uploadPath: string,
  onChunkUploaded: (bytes: number) => void,
): Promise<void> {
  const uploadId = generateUploadId();
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const chunkUrl = `/api/groups/${encodeURIComponent(jid)}/files/chunk`;

  for (let index = 0; index < totalChunks; index++) {
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const blob = file.slice(start, end);

    let succeeded = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < CHUNK_MAX_RETRIES; attempt++) {
      try {
        const formData = new FormData();
        formData.append('uploadId', uploadId);
        formData.append('chunkIndex', String(index));
        formData.append('totalChunks', String(totalChunks));
        formData.append('fileName', file.name);
        formData.append('fileSize', String(file.size));
        if (uploadPath) formData.append('path', uploadPath);
        formData.append('chunk', blob, file.name);

        await apiFetch(chunkUrl, {
          method: 'POST',
          body: formData,
          headers: {},
          timeoutMs: computeUploadTimeoutMs(blob.size),
        });
        succeeded = true;
        break;
      } catch (err) {
        lastError = err;
        if (attempt < CHUNK_MAX_RETRIES - 1) {
          await sleep(1000 * 3 ** attempt);
        }
      }
    }

    if (!succeeded) {
      // 尽力清理服务端已接收的分片，释放临时磁盘占用；清理失败也不影响
      // 把原始错误抛给调用方。
      apiFetch(`${chunkUrl}/${uploadId}`, { method: 'DELETE' }).catch(() => {});
      throw lastError instanceof Error
        ? lastError
        : new Error('Chunk upload failed');
    }

    onChunkUploaded(blob.size);
  }
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
  isSystem: boolean;
  absolutePath?: string;
}

export interface UploadProgress {
  total: number;
  completed: number;
  currentFile: string;
  /** bytes for current batch */
  totalBytes: number;
  uploadedBytes: number;
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
    if (files.length === 0) return false;

    const total = files.length;
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    set({
      uploading: true,
      uploadProgress: {
        total,
        completed: 0,
        currentFile: files[0].name,
        totalBytes,
        uploadedBytes: 0,
      },
    });

    const targetBase =
      basePath !== undefined ? basePath : get().currentPath[jid] || '';
    const apiUrl = `/api/groups/${encodeURIComponent(jid)}/files`;
    let uploadedBytes = 0;

    try {
      for (let i = 0; i < files.length; i++) {
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
          },
        });

        if (file.size > CHUNKED_UPLOAD_THRESHOLD) {
          await uploadFileInChunks(jid, file, uploadPath, (bytes) => {
            uploadedBytes += bytes;
            set({
              uploadProgress: {
                total,
                completed: i,
                currentFile: file.name,
                totalBytes,
                uploadedBytes,
              },
            });
          });
        } else {
          const formData = new FormData();
          formData.append('files', file);
          if (uploadPath) formData.append('path', uploadPath);

          await apiFetch(apiUrl, {
            method: 'POST',
            body: formData,
            headers: {},
            timeoutMs: computeUploadTimeoutMs(file.size),
          });

          uploadedBytes += file.size;
        }

        set({
          uploadProgress: {
            total,
            completed: i + 1,
            currentFile: i + 1 < total ? files[i + 1].name : '',
            totalBytes,
            uploadedBytes,
          },
        });
      }

      // Reload file list
      await get().loadFiles(jid, targetBase);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to upload files';
      console.error('Failed to upload files:', err);
      set({ error: msg });
      return false;
    } finally {
      set({ uploading: false, uploadProgress: null });
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
