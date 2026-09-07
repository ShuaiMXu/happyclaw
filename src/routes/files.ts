import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  isHostExecutionGroup,
  hasHostExecutionPermission,
  canAccessGroup,
} from '../web-context.js';
import type { AuthUser } from '../types.js';
import type { RegisteredGroup } from '../types.js';
import { getRegisteredGroup } from '../db.js';
import { logger } from '../logger.js';
import {
  listFiles,
  validateAndResolvePath,
  deleteFile,
  createDirectory,
  isSystemPath,
  MAX_FILE_SIZE,
  getGroupStorageUsage,
  invalidateGroupStorageUsage,
  getFileRoot,
} from '../file-manager.js';
import { checkStorageLimit, isBillingEnabled } from '../billing.js';
import { MAX_FILE_SIZE_MB, DATA_DIR } from '../config.js';
import { fileChunkUploadBodyLimit } from '../http-upload-policy.js';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

// 缩略图缓存：与工作区文件目录分开存放（避免污染文件面板列表），按
// 工作区文件夹分子目录，文件名为相对路径的 hash，内容与体积随请求方
// ?thumb=1 生成的 webp 缩略图一一对应。只用于生图画廊等场景的省流量预览，
// 原图下载 / 复用配方仍然读取未缩放的原始文件。
const THUMBNAIL_CACHE_DIR = path.join(DATA_DIR, 'image-thumbnails');
const THUMBNAIL_MAX_DIMENSION = 1024;
// q78 at the default effort 4 visibly blocked/mottled flat gradient regions
// (soft shadows, plain backgrounds) common in AI-generated images — the
// blocking came from the quality setting itself, not chroma subsampling.
// q88 + effort 6 (more compression search, same CPU-bound one-time cache
// build) removes that banding; smartSubsample trades a further ~5% size for
// better chroma quality on saturated color edges. Trade-off: ~40% bigger
// thumbnails (measured ~90-145 KB vs ~50-90 KB for typical generated
// images), still tiny compared to the multi-MB originals.
const THUMBNAIL_WEBP_QUALITY = 88;
const THUMBNAIL_WEBP_EFFORT = 6;
// Bump this when the encode parameters above change, so previously-cached
// thumbnails (keyed by content hash below) are treated as stale and
// regenerated instead of silently keeping the old, lower-quality bytes.
const THUMBNAIL_CACHE_VERSION = 'v2';
// 仅对确定是静态光栅图片的类型生成缩略图：GIF 可能是动图（resize 只取首帧
// 会丢失动画），SVG 本身已是矢量小文件，两者都跳过、直接回退到原图。
const THUMBNAIL_SOURCE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

function thumbnailCachePath(groupFolder: string, relativePath: string): string {
  const hash = crypto
    .createHash('sha1')
    .update(`${THUMBNAIL_CACHE_VERSION}|${relativePath}`)
    .digest('hex');
  return path.join(THUMBNAIL_CACHE_DIR, groupFolder, `${hash}.webp`);
}

/**
 * 删除某个文件对应的缩略图缓存（如果存在）。在原文件被显式删除时调用，
 * 避免缓存目录里堆积再也不会被访问的孤儿缩略图。静默忽略不存在的情况。
 */
export function removeCachedThumbnail(
  groupFolder: string,
  relativePath: string,
): void {
  try {
    fs.unlinkSync(thumbnailCachePath(groupFolder, relativePath));
  } catch {
    // 缓存本来就不存在（从未预览过缩略图），无需处理
  }
}

/**
 * 生成（或复用缓存的）指定图片文件的缩略图，返回缩略图的绝对路径。
 * 缓存以「原文件 mtime」失效：原文件被覆盖写入后会重新生成。生成失败
 * （例如文件不是合法图片）时返回 null，调用方应回退到原图。
 */
async function getOrCreateThumbnail(
  absolutePath: string,
  groupFolder: string,
  relativePath: string,
  mimeType: string,
  originalStats: fs.Stats,
): Promise<(fs.Stats & { path: string }) | null> {
  if (!THUMBNAIL_SOURCE_MIME_TYPES.has(mimeType)) return null;

  const cacheDir = path.join(THUMBNAIL_CACHE_DIR, groupFolder);
  const cachePath = thumbnailCachePath(groupFolder, relativePath);

  try {
    const cacheStat = fs.statSync(cachePath);
    if (cacheStat.mtimeMs >= originalStats.mtimeMs) {
      return Object.assign(cacheStat, { path: cachePath });
    }
  } catch {
    // 缓存不存在，走下方生成分支
  }

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    // 先写临时文件再重命名，避免并发请求下读到未写完的半成品文件。
    const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    await sharp(absolutePath)
      .rotate() // 按 EXIF 方向校正，避免竖拍照片缩略图被拉伸/旋转
      .resize({
        width: THUMBNAIL_MAX_DIMENSION,
        height: THUMBNAIL_MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({
        quality: THUMBNAIL_WEBP_QUALITY,
        effort: THUMBNAIL_WEBP_EFFORT,
        smartSubsample: true,
      })
      .toFile(tmpPath);
    fs.renameSync(tmpPath, cachePath);
    const cacheStat = fs.statSync(cachePath);
    return Object.assign(cacheStat, { path: cachePath });
  } catch (error) {
    logger.warn(
      { err: error, relativePath },
      'Failed to generate image thumbnail, falling back to original',
    );
    return null;
  }
}

// MIME 类型映射（预览和编辑端点共用）
const MIME_MAP: Record<string, string> = {
  // 图片
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  // 文本和代码
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  js: 'text/javascript',
  ts: 'text/typescript',
  jsx: 'text/javascript',
  tsx: 'text/typescript',
  css: 'text/css',
  html: 'text/html',
  xml: 'application/xml',
  py: 'text/x-python',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  c: 'text/x-c',
  cpp: 'text/x-c++',
  h: 'text/x-c',
  sh: 'text/x-sh',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/x-toml',
  ini: 'text/plain',
  conf: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  // PDF
  pdf: 'application/pdf',
  // 视频
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  // 音频
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  // 压缩文件
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  '7z': 'application/x-7z-compressed',
};

// 文本文件扩展名（用于编辑端点判断）
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

// 不安全的扩展名（HTML/SVG 有 XSS 风险，压缩包不可预览）
const UNSAFE_PREVIEW_EXTENSIONS = new Set([
  'html',
  'svg',
  'zip',
  'tar',
  'gz',
  '7z',
]);

// 允许 inline 预览的安全 MIME 类型（从 MIME_MAP 中排除不安全扩展名自动推导）
const SAFE_PREVIEW_MIME_TYPES = new Set(
  Object.entries(MIME_MAP)
    .filter(([ext]) => !UNSAFE_PREVIEW_EXTENSIONS.has(ext))
    .map(([, mime]) => mime),
);

/**
 * 获取文件操作的根目录覆盖。
 * 宿主机模式下设置了 customCwd 时，文件面板以 customCwd 为根。
 */
function getFileRootOverride(group: RegisteredGroup): string | undefined {
  return group.executionMode === 'host' && group.customCwd
    ? group.customCwd
    : undefined;
}

/**
 * 计算 Agent 视角的绝对路径（供前端"复制路径"功能使用）。
 * - container 模式：容器内挂载路径 /workspace/group/<relative>
 * - host 模式：宿主机绝对路径（customCwd 或 data/groups/{folder}）+ relative
 */
function getAgentAbsolutePath(
  group: RegisteredGroup,
  relativePath: string,
): string {
  if (group.executionMode === 'host') {
    const base = getFileRoot(group.folder, getFileRootOverride(group));
    return relativePath ? path.join(base, relativePath) : base;
  }
  return relativePath
    ? path.posix.join('/workspace/group', relativePath)
    : '/workspace/group';
}

function buildAttachmentContentDisposition(fileName: string): string {
  const sanitized = fileName.replace(/["\\\r\n]/g, '_');
  const asciiFallback = sanitized.replace(/[^\x20-\x7E]/g, '_') || 'download';
  const encoded = encodeURIComponent(fileName);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function parseSingleRange(
  rangeHeader: string,
  fileSize: number,
): { start: number; end: number } | null {
  if (fileSize <= 0) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  // Suffix bytes range (e.g. bytes=-500)
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
    if (suffixLength >= fileSize) return { start: 0, end: fileSize - 1 };
    return { start: fileSize - suffixLength, end: fileSize - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isInteger(start) || start < 0 || start >= fileSize) return null;

  const parsedEnd = rawEnd ? Number(rawEnd) : fileSize - 1;
  if (!Number.isInteger(parsedEnd) || parsedEnd < start) return null;

  return { start, end: Math.min(parsedEnd, fileSize - 1) };
}

async function openDirectoryInFileManager(targetDir: string): Promise<void> {
  const attempts: Array<{ cmd: string; args: string[] }> = (() => {
    if (process.platform === 'darwin') {
      return [{ cmd: 'open', args: [targetDir] }];
    }
    if (process.platform === 'win32') {
      return [{ cmd: 'explorer', args: [targetDir] }];
    }
    // Linux 桌面环境兼容：优先 xdg-open，失败后回退到常见 opener
    return [
      { cmd: 'xdg-open', args: [targetDir] },
      { cmd: 'gio', args: ['open', targetDir] },
      { cmd: 'kde-open5', args: [targetDir] },
      { cmd: 'kde-open', args: [targetDir] },
    ];
  })();

  const failureCodes: string[] = [];
  for (const attempt of attempts) {
    try {
      await execFileAsync(attempt.cmd, attempt.args, { timeout: 10_000 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // 命令不存在：继续尝试下一个 opener
      if (code === 'ENOENT') {
        failureCodes.push(`${attempt.cmd}:ENOENT`);
        continue;
      }
      failureCodes.push(`${attempt.cmd}:${code || 'ERROR'}`);
    }
  }

  const err = new Error('No compatible desktop opener available');
  (err as Error & { code?: string; detail?: string[] }).code = 'NO_FILE_OPENER';
  (err as Error & { code?: string; detail?: string[] }).detail = failureCodes;
  throw err;
}

const fileRoutes = new Hono<{ Variables: Variables }>();

// GET /api/groups/:jid/files?path= - 列出文件
fileRoutes.get('/:jid/files', authMiddleware, (c) => {
  const jid = c.req.param('jid');
  const subPath = c.req.query('path') || '';

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  try {
    const result = listFiles(group.folder, subPath, getFileRootOverride(group));
    const files = result.files.map((entry) => ({
      ...entry,
      absolutePath: getAgentAbsolutePath(group, entry.path),
    }));
    return c.json({ ...result, files });
  } catch (error) {
    logger.error({ err: error }, `Failed to list files for ${jid}`);
    return c.json({ error: 'Failed to list files' }, 500);
  }
});

// POST /api/groups/:jid/files - 上传文件
fileRoutes.post('/:jid/files', authMiddleware, async (c) => {
  const jid = c.req.param('jid');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  const rootOverride = getFileRootOverride(group);

  try {
    const body = await c.req.parseBody({ all: true });
    const targetPath = (typeof body.path === 'string' ? body.path : '') || '';
    const files = body.files;

    if (!files) {
      return c.json({ error: 'No files provided' }, 400);
    }

    // 支持单文件和多文件上传
    const fileList = Array.isArray(files) ? files : [files];
    const uploadedFiles: string[] = [];

    // Billing: check storage limit before uploading
    if (isBillingEnabled() && group.created_by) {
      const totalUploadSize = fileList.reduce(
        (sum, f) => sum + (f instanceof File ? f.size : 0),
        0,
      );
      const currentUsage = getGroupStorageUsage(group.folder, rootOverride);
      const storageCheck = checkStorageLimit(
        group.created_by,
        authUser.role,
        currentUsage,
        totalUploadSize,
      );
      if (!storageCheck.allowed) {
        return c.json({ error: storageCheck.reason }, 403);
      }
    }

    for (const file of fileList) {
      if (!(file instanceof File)) continue;

      // 检查文件大小
      if (file.size > MAX_FILE_SIZE) {
        return c.json(
          {
            error: `File ${file.name} exceeds maximum size of ${MAX_FILE_SIZE_MB}MB`,
          },
          400,
        );
      }

      // 验证文件名，防止路径遍历攻击
      if (file.name.includes('..') || file.name.startsWith('/')) {
        return c.json({ error: `Invalid file name: ${file.name}` }, 400);
      }

      // 禁止写入系统路径
      const relativeFilePath = path.join(targetPath, file.name);
      if (isSystemPath(targetPath) || isSystemPath(relativeFilePath)) {
        return c.json({ error: 'Cannot upload to system path' }, 403);
      }

      // 验证目标路径 + 文件名的完整路径（防止 file.name 含 ../../ 绕过）
      const fullRelativePath = path.join(targetPath, file.name);
      const targetFilePath = validateAndResolvePath(
        group.folder,
        fullRelativePath,
        rootOverride,
      );
      const targetDir = path.dirname(targetFilePath);

      // 确保目标目录存在
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      // 写入文件：用 O_NOFOLLOW 防 leaf TOCTOU——validateAndResolvePath 与
      // writeFileSync 之间，对 RW 工作区有写权限的 agent 可以临时把
      // targetFilePath 替换成符号链接指向系统敏感路径，让上传的内容写到
      // workspace 之外。父目录被换成 symlink 的场景仍依赖 validateAndResolvePath
      // 的 ancestor realpath 校验拦截，但 leaf 由 O_NOFOLLOW 强保护。
      // 用 fs.writeFileSync(fd, ...) 让 Node 内置循环处理 short-write。
      const buffer = await file.arrayBuffer();
      const data = Buffer.from(buffer);
      const noFollowFlag = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
      if (noFollowFlag !== undefined) {
        const flags =
          fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_TRUNC |
          noFollowFlag;
        let fd: number | null = null;
        try {
          fd = fs.openSync(targetFilePath, flags, 0o644);
          fs.writeFileSync(fd, data);
        } finally {
          if (fd !== null) {
            try {
              fs.closeSync(fd);
            } catch {
              /* ignore */
            }
          }
        }
      } else {
        fs.writeFileSync(targetFilePath, data);
      }

      uploadedFiles.push(file.name);
    }

    invalidateGroupStorageUsage(group.folder, rootOverride);
    return c.json({ success: true, files: uploadedFiles });
  } catch (error) {
    logger.error({ err: error }, `Failed to upload files for ${jid}`);
    return c.json({ error: 'Failed to upload files' }, 500);
  }
});

// ─── 分片上传（大文件）───────────────────────────────────────────
//
// 单次 multipart 请求上传整个文件在慢速/不稳定网络下容易撞上请求超时——
// 一次几十上百 MB 的传输只要中途抖一下就要从头重来，进度条也只能"上传前/
// 上传后"两态跳变，用户体感是长时间卡住。改成固定大小分片（前端 4MB 一片，
// 见 web/src/stores/files.ts CHUNK_SIZE）后：
// - 每个分片都是独立的小请求，超时窗口固定且很短，不随文件总大小增长；
// - 单个分片失败只重试这一片（前端做退避重试），不用整份重传；
// - 每片写盘成功即可推进进度，条形图能连续走动而不是长时间静止。
// 分片临时存放在工作区文件树之外（DATA_DIR/upload-tmp/{folder}/{uploadId}/），
// 避免半成品文件被文件面板列出，也避免被挂进容器。全部分片到齐后按序拼接、
// 校验总大小、走与单文件上传相同的路径校验和 O_NOFOLLOW 写入，再清理临时目录。
const UPLOAD_TMP_ROOT = path.join(DATA_DIR, 'upload-tmp');
const UPLOAD_ID_RE = /^[a-zA-Z0-9_-]{8,100}$/;
const CHUNK_UPLOAD_STALE_MS = 6 * 60 * 60 * 1000; // 6 小时未完成视为废弃
const MAX_CHUNK_COUNT = 20_000; // 4MB × 20000 ≈ 78GB，远高于 MAX_FILE_SIZE 上限，只做兜底
const MIN_CHUNK_BYTES = 64 * 1024; // 分片数/总大小合理性校验的下限假设

interface ChunkUploadManifest {
  fileName: string;
  targetPath: string;
  fileSize: number;
  totalChunks: number;
}

function chunkUploadDir(groupFolder: string, uploadId: string): string {
  return path.join(UPLOAD_TMP_ROOT, groupFolder, uploadId);
}

function chunkManifestPath(dir: string): string {
  return path.join(dir, '.manifest.json');
}

/** 清理该工作区下超过 CHUNK_UPLOAD_STALE_MS 未完成的分片临时目录（尽力而为，不阻塞主流程）。 */
function sweepStaleChunkUploads(groupFolder: string): void {
  const groupDir = path.join(UPLOAD_TMP_ROOT, groupFolder);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(groupDir, { withFileTypes: true });
  } catch {
    return; // 目录不存在，无需清理
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(groupDir, entry.name);
    try {
      const stat = fs.statSync(dir);
      if (now - stat.mtimeMs > CHUNK_UPLOAD_STALE_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // 忽略单个目录的清理失败，不影响其他目录和本次上传
    }
  }
}

// POST /api/groups/:jid/files/chunk - 上传大文件的一个分片，全部到齐后自动拼接
fileRoutes.post(
  '/:jid/files/chunk',
  authMiddleware,
  fileChunkUploadBodyLimit,
  async (c) => {
    const jid = c.req.param('jid');

    const group = getRegisteredGroup(jid);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const authUser = c.get('user') as AuthUser;
    if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
      return c.json({ error: 'Group not found' }, 404);
    }
    if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
      return c.json(
        { error: 'Insufficient permissions for host execution mode' },
        403,
      );
    }

    const rootOverride = getFileRootOverride(group);

    try {
      const body = await c.req.parseBody();
      const uploadId = typeof body.uploadId === 'string' ? body.uploadId : '';
      const fileName = typeof body.fileName === 'string' ? body.fileName : '';
      const targetPath = (typeof body.path === 'string' ? body.path : '') || '';
      const chunkIndex = Number(body.chunkIndex);
      const totalChunks = Number(body.totalChunks);
      const fileSize = Number(body.fileSize);
      const chunk = body.chunk;

      if (!UPLOAD_ID_RE.test(uploadId)) {
        return c.json({ error: 'Invalid uploadId' }, 400);
      }
      if (!(chunk instanceof File)) {
        return c.json({ error: 'No chunk provided' }, 400);
      }
      if (
        !Number.isInteger(chunkIndex) ||
        !Number.isInteger(totalChunks) ||
        chunkIndex < 0 ||
        totalChunks <= 0 ||
        chunkIndex >= totalChunks ||
        totalChunks > MAX_CHUNK_COUNT
      ) {
        return c.json({ error: 'Invalid chunk index/count' }, 400);
      }
      if (!Number.isInteger(fileSize) || fileSize <= 0) {
        return c.json({ error: 'Invalid file size' }, 400);
      }
      if (fileSize > MAX_FILE_SIZE) {
        return c.json(
          {
            error: `File ${fileName} exceeds maximum size of ${MAX_FILE_SIZE_MB}MB`,
          },
          400,
        );
      }
      // 分片数和声明的总大小要大致匹配，防止用一堆几十字节的"分片"硬撑出
      // 上万次小文件写入（fileSize 很小但 totalChunks 很大的伪造场景）。
      if (totalChunks > Math.ceil(fileSize / MIN_CHUNK_BYTES) + 1) {
        return c.json({ error: 'Invalid chunk index/count' }, 400);
      }
      if (!fileName || fileName.includes('..') || fileName.startsWith('/')) {
        return c.json({ error: `Invalid file name: ${fileName}` }, 400);
      }
      const fullRelativePath = path.join(targetPath, fileName);
      if (isSystemPath(targetPath) || isSystemPath(fullRelativePath)) {
        return c.json({ error: 'Cannot upload to system path' }, 403);
      }
      // 提前校验最终落盘路径，分片阶段就能拒绝非法路径，不必等拼接时才发现
      validateAndResolvePath(group.folder, fullRelativePath, rootOverride);

      const dir = chunkUploadDir(group.folder, uploadId);
      const manifestFile = chunkManifestPath(dir);

      if (chunkIndex === 0) {
        // Billing: 用声明的总大小做上传前预检查（与单文件上传路径一致的信任模型，
        // 拼接完成后仍会校验实际落盘大小与声明大小一致，防止绕过）。
        if (isBillingEnabled() && group.created_by) {
          const currentUsage = getGroupStorageUsage(group.folder, rootOverride);
          const storageCheck = checkStorageLimit(
            group.created_by,
            authUser.role,
            currentUsage,
            fileSize,
          );
          if (!storageCheck.allowed) {
            return c.json({ error: storageCheck.reason }, 403);
          }
        }
        sweepStaleChunkUploads(group.folder);
        fs.mkdirSync(dir, { recursive: true });
        const manifest: ChunkUploadManifest = {
          fileName,
          targetPath,
          fileSize,
          totalChunks,
        };
        fs.writeFileSync(manifestFile, JSON.stringify(manifest));
      } else {
        let manifest: ChunkUploadManifest;
        try {
          manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
        } catch {
          return c.json(
            { error: 'Upload session not found, please restart the upload' },
            410,
          );
        }
        if (
          manifest.fileName !== fileName ||
          manifest.targetPath !== targetPath ||
          manifest.fileSize !== fileSize ||
          manifest.totalChunks !== totalChunks
        ) {
          return c.json({ error: 'Chunk metadata mismatch' }, 400);
        }
      }

      const chunkBuffer = Buffer.from(await chunk.arrayBuffer());
      fs.writeFileSync(path.join(dir, `${chunkIndex}.part`), chunkBuffer);

      const receivedParts = fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.part'));
      if (receivedParts.length < totalChunks) {
        return c.json({
          success: true,
          completed: false,
          received: receivedParts.length,
        });
      }

      // 全部分片到齐：按序拼接到最终文件
      const targetFilePath = validateAndResolvePath(
        group.folder,
        fullRelativePath,
        rootOverride,
      );
      const targetDir = path.dirname(targetFilePath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const noFollowFlag = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
      const flags =
        noFollowFlag !== undefined
          ? fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_TRUNC |
            noFollowFlag
          : fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC;

      let assembledSize = 0;
      let fd: number | null = null;
      try {
        fd = fs.openSync(targetFilePath, flags, 0o644);
        for (let i = 0; i < totalChunks; i++) {
          const partPath = path.join(dir, `${i}.part`);
          const partBuffer = fs.readFileSync(partPath);
          fs.writeSync(fd, partBuffer);
          assembledSize += partBuffer.length;
        }
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {
            /* ignore */
          }
        }
      }

      fs.rmSync(dir, { recursive: true, force: true });

      if (assembledSize !== fileSize) {
        // 拼接结果和声明大小对不上（分片丢失/损坏），删除半成品，让前端整份重传
        try {
          fs.unlinkSync(targetFilePath);
        } catch {
          /* ignore */
        }
        return c.json(
          { error: 'Assembled file size mismatch, please retry the upload' },
          500,
        );
      }

      invalidateGroupStorageUsage(group.folder, rootOverride);
      return c.json({ success: true, completed: true, files: [fileName] });
    } catch (error) {
      logger.error({ err: error }, `Failed to upload file chunk for ${jid}`);
      return c.json({ error: 'Failed to upload file chunk' }, 500);
    }
  },
);

// DELETE /api/groups/:jid/files/chunk/:uploadId - 取消分片上传，释放临时目录
fileRoutes.delete('/:jid/files/chunk/:uploadId', authMiddleware, (c) => {
  const jid = c.req.param('jid');
  const uploadId = c.req.param('uploadId');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }

  if (!UPLOAD_ID_RE.test(uploadId)) {
    return c.json({ error: 'Invalid uploadId' }, 400);
  }

  try {
    fs.rmSync(chunkUploadDir(group.folder, uploadId), {
      recursive: true,
      force: true,
    });
    return c.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, `Failed to cancel chunk upload for ${jid}`);
    return c.json({ error: 'Failed to cancel chunk upload' }, 500);
  }
});

// POST /api/groups/:jid/files/open-directory - 在本地文件管理器中打开目录
fileRoutes.post('/:jid/files/open-directory', authMiddleware, async (c) => {
  const jid = c.req.param('jid');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  // 打开本地目录属于宿主机操作，限制为有宿主机权限的用户
  if (!hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions to open local directory' },
      403,
    );
  }

  try {
    const body = await c.req.json().catch(() => ({}));
    const targetPath = typeof body.path === 'string' ? body.path : '';
    const absolutePath = validateAndResolvePath(
      group.folder,
      targetPath,
      getFileRootOverride(group),
    );

    if (!fs.existsSync(absolutePath)) {
      return c.json({ error: 'Directory not found' }, 404);
    }

    const stats = fs.statSync(absolutePath);
    const targetDir = stats.isDirectory()
      ? absolutePath
      : path.dirname(absolutePath);

    await openDirectoryInFileManager(targetDir);
    return c.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, `Failed to open local directory for ${jid}`);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'NO_FILE_OPENER') {
      return c.json({ error: 'No desktop opener available on server' }, 503);
    }
    const msg = (error as Error).message;
    const safeMessages = [
      'Path traversal detected',
      'Symlink traversal detected',
    ];
    const publicMsg = safeMessages.includes(msg)
      ? msg
      : 'Failed to open local directory';
    const status = safeMessages.includes(msg) ? 400 : 500;
    return c.json({ error: publicMsg }, status);
  }
});

// GET /api/groups/:jid/files/download/:path - 下载文件
fileRoutes.get('/:jid/files/download/:path', authMiddleware, (c) => {
  const jid = c.req.param('jid');
  const encodedPath = c.req.param('path');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  try {
    // 解码 base64url 路径
    const relativePath = Buffer.from(encodedPath, 'base64url').toString(
      'utf-8',
    );
    const absolutePath = validateAndResolvePath(
      group.folder,
      relativePath,
      getFileRootOverride(group),
    );

    if (!fs.existsSync(absolutePath)) {
      return c.json({ error: 'File not found' }, 404);
    }

    const stats = fs.statSync(absolutePath);
    if (stats.isDirectory()) {
      return c.json({ error: 'Cannot download directory' }, 400);
    }

    const fileName = path.basename(absolutePath);
    const fileSize = stats.size;
    const commonHeaders = {
      'Content-Disposition': buildAttachmentContentDisposition(fileName),
      'Content-Type': 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Accept-Ranges': 'bytes',
    };

    const rangeHeader = c.req.header('range');
    if (rangeHeader) {
      const normalizedRange = rangeHeader.trim();
      const isBytesRange = normalizedRange.toLowerCase().startsWith('bytes=');
      const isMultiRange = isBytesRange && normalizedRange.includes(',');

      // 多区间请求当前未实现 multipart/byteranges，回退为完整下载响应
      if (isBytesRange && !isMultiRange) {
        const parsedRange = parseSingleRange(normalizedRange, fileSize);
        if (!parsedRange) {
          return new Response(null, {
            status: 416,
            headers: {
              ...commonHeaders,
              'Content-Range': `bytes */${fileSize}`,
            },
          });
        }

        const { start, end } = parsedRange;
        const stream = Readable.toWeb(
          fs.createReadStream(absolutePath, { start, end }),
        ) as ReadableStream<Uint8Array>;
        return new Response(stream, {
          status: 206,
          headers: {
            ...commonHeaders,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          },
        });
      }
    }

    const stream = Readable.toWeb(
      fs.createReadStream(absolutePath),
    ) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status: 200,
      headers: {
        ...commonHeaders,
        'Content-Length': String(fileSize),
      },
    });
  } catch (error) {
    logger.error({ err: error }, `Failed to download file for ${jid}`);
    return c.json({ error: 'Failed to download file' }, 500);
  }
});

// GET /api/groups/:jid/files/preview/:path - 预览文件
// 可选查询参数 ?thumb=1：返回缩小重编码的 webp 缩略图而非原图，用于生图
// 画廊等省流量场景；仅对静态光栅图片生效，其余类型或生成失败时回退原图。
fileRoutes.get('/:jid/files/preview/:path', authMiddleware, async (c) => {
  const jid = c.req.param('jid');
  const encodedPath = c.req.param('path');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  try {
    // 解码 base64url 路径
    const relativePath = Buffer.from(encodedPath, 'base64url').toString(
      'utf-8',
    );
    const absolutePath = validateAndResolvePath(
      group.folder,
      relativePath,
      getFileRootOverride(group),
    );

    if (!fs.existsSync(absolutePath)) {
      return c.json({ error: 'File not found' }, 404);
    }

    const stats = fs.statSync(absolutePath);
    if (stats.isDirectory()) {
      return c.json({ error: 'Cannot preview directory' }, 400);
    }

    // 检测 MIME 类型（基于扩展名）
    const ext = path.extname(absolutePath).slice(1).toLowerCase();
    const mimeType = MIME_MAP[ext] || 'application/octet-stream';
    const fileName = path.basename(absolutePath);
    const fileSize = stats.size;

    // 判断是否为流媒体类型（视频/音频），需支持 Range 请求
    const isStreamable =
      mimeType.startsWith('video/') || mimeType.startsWith('audio/');

    // 缩略图请求：只对静态光栅图片生效，用远小于原图的 webp 版本节省带宽
    // （生图画廊等场景）；类型不支持或生成失败时静默回退到原图，不报错。
    let servePath = absolutePath;
    let serveStats = stats;
    let serveMimeType = mimeType;
    let serveFileSize = fileSize;
    if (c.req.query('thumb') === '1' && !isStreamable) {
      const thumb = await getOrCreateThumbnail(
        absolutePath,
        group.folder,
        relativePath,
        mimeType,
        stats,
      );
      if (thumb) {
        servePath = thumb.path;
        serveStats = thumb;
        serveMimeType = 'image/webp';
        serveFileSize = thumb.size;
      }
    }

    // 安全头
    const securityHeaders: Record<string, string> = {
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    };

    // Content-Type 和 Content-Disposition
    let contentType: string;
    let disposition: string;
    if (SAFE_PREVIEW_MIME_TYPES.has(serveMimeType)) {
      contentType = serveMimeType;
      disposition = 'inline';
    } else {
      contentType = 'application/octet-stream';
      disposition = `attachment; filename="${encodeURIComponent(fileName)}"`;
    }

    // 缓存校验头：之前完全没有 ETag/Last-Modified/Cache-Control，浏览器
    // 每次刷新都会重新拉取整个文件。这里按 size+mtime 生成弱 ETag，命中
    // 条件请求即返回 304 空体；内容一旦被覆盖写入（mtime/size 变化）会
    // 立即失效，不会返回过期内容。
    const etag = `W/"${serveFileSize.toString(16)}-${Math.floor(serveStats.mtimeMs).toString(16)}"`;
    const lastModified = serveStats.mtime.toUTCString();
    const ifNoneMatch = c.req.header('if-none-match');
    const ifModifiedSince = c.req.header('if-modified-since');
    const notModified = ifNoneMatch
      ? ifNoneMatch === etag
      : ifModifiedSince
        ? serveStats.mtimeMs <= new Date(ifModifiedSince).getTime() + 999
        : false;

    // 生成图片文件名含时间戳 + 随机后缀、内容写入后不变，可以安全地让
    // 浏览器长缓存（零请求返回）；其他文件仍走每次条件请求的 304 协商。
    const isImmutableImage =
      relativePath.startsWith('generated-images/') &&
      serveMimeType.startsWith('image/');

    const commonHeaders = {
      ...securityHeaders,
      'Content-Type': contentType,
      'Content-Disposition': disposition,
      ETag: etag,
      'Last-Modified': lastModified,
      'Cache-Control': isImmutableImage
        ? 'private, max-age=86400, immutable'
        : 'private, no-cache, must-revalidate',
    };

    if (notModified) {
      return new Response(null, { status: 304, headers: commonHeaders });
    }

    // 流媒体类型：支持 Range 请求（浏览器 <video>/<audio> seek 依赖此机制）
    if (isStreamable) {
      const rangeHeader = c.req.header('range');
      if (rangeHeader) {
        const normalizedRange = rangeHeader.trim();
        const isBytesRange = normalizedRange.toLowerCase().startsWith('bytes=');
        const isMultiRange = isBytesRange && normalizedRange.includes(',');

        if (isBytesRange && !isMultiRange) {
          const parsedRange = parseSingleRange(normalizedRange, fileSize);
          if (!parsedRange) {
            return new Response(null, {
              status: 416,
              headers: {
                ...commonHeaders,
                'Content-Range': `bytes */${fileSize}`,
              },
            });
          }

          const { start, end } = parsedRange;
          const stream = Readable.toWeb(
            fs.createReadStream(absolutePath, { start, end }),
          ) as ReadableStream<Uint8Array>;
          return new Response(stream, {
            status: 206,
            headers: {
              ...commonHeaders,
              'Accept-Ranges': 'bytes',
              'Content-Length': String(end - start + 1),
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            },
          });
        }
      }

      // 无 Range 或多区间回退：流式返回完整文件
      const stream = Readable.toWeb(
        fs.createReadStream(absolutePath),
      ) as ReadableStream<Uint8Array>;
      return new Response(stream, {
        status: 200,
        headers: {
          ...commonHeaders,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(fileSize),
        },
      });
    }

    // 非流媒体类型：也使用流式响应避免大文件占满内存
    const stream = Readable.toWeb(
      fs.createReadStream(servePath),
    ) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status: 200,
      headers: {
        ...commonHeaders,
        'Content-Length': String(serveFileSize),
      },
    });
  } catch (error) {
    logger.error({ err: error }, `Failed to preview file for ${jid}`);
    return c.json({ error: 'Failed to preview file' }, 500);
  }
});

// GET /api/groups/:jid/files/content/:path - 读取文本文件内容
fileRoutes.get('/:jid/files/content/:path', authMiddleware, (c) => {
  const jid = c.req.param('jid');
  const encodedPath = c.req.param('path');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  try {
    const rootOverride = getFileRootOverride(group);
    const relativePath = Buffer.from(encodedPath, 'base64url').toString(
      'utf-8',
    );
    const absolutePath = validateAndResolvePath(
      group.folder,
      relativePath,
      rootOverride,
    );

    if (!fs.existsSync(absolutePath)) {
      return c.json({ error: 'File not found' }, 404);
    }

    const stats = fs.statSync(absolutePath);
    if (stats.isDirectory()) {
      return c.json({ error: 'Cannot read directory content' }, 400);
    }

    // 仅允许文本文件
    const ext = path.extname(absolutePath).slice(1).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) {
      return c.json(
        { error: 'File type not supported for content reading' },
        400,
      );
    }

    // 限制文件大小（10MB）
    if (stats.size > 10 * 1024 * 1024) {
      return c.json({ error: 'File too large to read (max 10MB)' }, 400);
    }

    const content = fs.readFileSync(absolutePath, 'utf-8');
    return c.json({ content, size: stats.size });
  } catch (error) {
    logger.error({ err: error }, `Failed to read file content for ${jid}`);
    return c.json({ error: 'Failed to read file content' }, 500);
  }
});

// PUT /api/groups/:jid/files/content/:path - 保存文本文件内容
fileRoutes.put('/:jid/files/content/:path', authMiddleware, async (c) => {
  const jid = c.req.param('jid');
  const encodedPath = c.req.param('path');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  try {
    const rootOverride = getFileRootOverride(group);
    const relativePath = Buffer.from(encodedPath, 'base64url').toString(
      'utf-8',
    );

    // 禁止写入系统路径
    if (isSystemPath(relativePath)) {
      return c.json({ error: 'Cannot edit system file' }, 403);
    }

    const absolutePath = validateAndResolvePath(
      group.folder,
      relativePath,
      rootOverride,
    );

    if (!fs.existsSync(absolutePath)) {
      return c.json({ error: 'File not found' }, 404);
    }

    const stats = fs.statSync(absolutePath);
    if (stats.isDirectory()) {
      return c.json({ error: 'Cannot edit directory content' }, 400);
    }

    // 仅允许文本文件
    const ext = path.extname(absolutePath).slice(1).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) {
      return c.json({ error: 'File type not supported for editing' }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    if (typeof body.content !== 'string') {
      return c.json({ error: 'Content field is required' }, 400);
    }

    // 限制内容大小（10MB）
    if (Buffer.byteLength(body.content, 'utf-8') > 10 * 1024 * 1024) {
      return c.json({ error: 'Content too large (max 10MB)' }, 400);
    }

    if (isBillingEnabled() && group.created_by) {
      const nextSize = Buffer.byteLength(body.content, 'utf-8');
      const additionalBytes = Math.max(0, nextSize - stats.size);
      if (additionalBytes > 0) {
        const currentUsage = getGroupStorageUsage(group.folder, rootOverride);
        const storageCheck = checkStorageLimit(
          group.created_by,
          authUser.role,
          currentUsage,
          additionalBytes,
        );
        if (!storageCheck.allowed) {
          return c.json({ error: storageCheck.reason }, 403);
        }
      }
    }

    // 原子写入：先 lstat 检查目标如已存在则不能是 symlink（防 TOCTOU 把
    // absolutePath 替换成指向系统路径的链接 → rename 走的是目录项替换不会
    // 跟随，但若先存在 symlink 时仍会替换它本身，对调用方语义没有破坏；
    // 但仍然 lstat 校验目录祖先没被偷换）。
    try {
      const lst = fs.lstatSync(absolutePath);
      if (lst.isSymbolicLink()) {
        return c.json({ error: 'Refusing to overwrite symbolic link' }, 403);
      }
    } catch (err: any) {
      if (err && err.code !== 'ENOENT') throw err;
    }
    const tmp = `${absolutePath}.tmp`;
    // 用 fs.writeFileSync(fd, ...) 让 Node 内置循环处理 partial-write
    // (NFS / 容器 IO 限流 / 磁盘满边界都可能 short-write 导致内容截断)。
    // 配合 O_NOFOLLOW + O_EXCL 防 symlink 预放（Windows 不支持 NOFOLLOW，
    // 走 fallback writeFileSync，由前置 lstat 守住 leaf）。
    // tmp 失败务必 unlink，否则下次同文件 PUT 在 O_EXCL 处永久 EEXIST 锁死；
    // rename 阶段失败也走 finally 清理。
    const noFollowFlag = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
    let renameOk = false;
    try {
      if (noFollowFlag !== undefined) {
        const flags =
          fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_TRUNC |
          fs.constants.O_EXCL |
          noFollowFlag;
        let fd: number | null = null;
        try {
          fd = fs.openSync(tmp, flags, 0o644);
          // writeFileSync 接受 fd，内部循环处理 short-write
          fs.writeFileSync(fd, body.content, 'utf-8');
        } finally {
          if (fd !== null) {
            try {
              fs.closeSync(fd);
            } catch {
              /* ignore */
            }
          }
        }
      } else {
        // Windows fallback：用 'wx' 等价的 O_EXCL 创建避免覆写预放 symlink。
        try {
          fs.writeFileSync(tmp, body.content, {
            encoding: 'utf-8',
            flag: 'wx',
            mode: 0o644,
          });
        } catch (err: any) {
          if (err && err.code === 'EEXIST') {
            // 旧 tmp 残留：删后重试一次。
            fs.unlinkSync(tmp);
            fs.writeFileSync(tmp, body.content, {
              encoding: 'utf-8',
              flag: 'wx',
              mode: 0o644,
            });
          } else {
            throw err;
          }
        }
      }
      fs.renameSync(tmp, absolutePath);
      renameOk = true;
    } finally {
      if (!renameOk) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }
    }

    invalidateGroupStorageUsage(group.folder, rootOverride);
    return c.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, `Failed to save file content for ${jid}`);
    return c.json({ error: 'Failed to save file content' }, 500);
  }
});

// DELETE /api/groups/:jid/files/:path - 删除文件
fileRoutes.delete('/:jid/files/:path', authMiddleware, (c) => {
  const jid = c.req.param('jid');
  const encodedPath = c.req.param('path');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  try {
    const rootOverride = getFileRootOverride(group);
    // 解码 base64url 路径
    const relativePath = Buffer.from(encodedPath, 'base64url').toString(
      'utf-8',
    );
    deleteFile(group.folder, relativePath, rootOverride);
    invalidateGroupStorageUsage(group.folder, rootOverride);

    return c.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, `Failed to delete file for ${jid}`);
    const msg = (error as Error).message;
    // Only expose known safe error messages, not internal paths
    const safeMessages = [
      'Cannot delete system path',
      'Cannot delete root directory',
      'File or directory not found',
      'Path traversal detected',
      'Symlink traversal detected',
    ];
    const publicMsg = safeMessages.includes(msg)
      ? msg
      : 'Failed to delete file';
    return c.json({ error: publicMsg }, 400);
  }
});

// POST /api/groups/:jid/directories - 创建目录
fileRoutes.post('/:jid/directories', authMiddleware, async (c) => {
  const jid = c.req.param('jid');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  try {
    const body = await c.req.json();
    const { path: parentPath, name } = body;

    if (!name || typeof name !== 'string') {
      return c.json({ error: 'Directory name is required' }, 400);
    }

    createDirectory(
      group.folder,
      parentPath || '',
      name,
      getFileRootOverride(group),
    );

    return c.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, `Failed to create directory for ${jid}`);
    const msg = (error as Error).message;
    const safeMessages = [
      'Cannot create system path',
      'Cannot create root directory',
      'Directory already exists',
      'Path traversal detected',
      'Symlink traversal detected',
      'Directory name is required',
      'Invalid directory name',
    ];
    const publicMsg = safeMessages.includes(msg)
      ? msg
      : 'Failed to create directory';
    return c.json({ error: publicMsg }, 400);
  }
});

export default fileRoutes;
