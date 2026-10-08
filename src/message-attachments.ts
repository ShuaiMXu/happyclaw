import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import {
  detectImageMimeTypeFromBase64Strict,
  detectImageMimeTypeStrict,
} from './image-detector.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DATA_URL_BASE64_RE = /^\s*data:([^;,]+);base64,(.*)\s*$/is;
export const STAGED_CHAT_ATTACHMENT_PREFIX = 'chat-attachments/staged/';
export const STAGED_CHAT_ATTACHMENT_PATH_RE = new RegExp(
  `^${STAGED_CHAT_ATTACHMENT_PREFIX}[0-9a-f-]{36}\\.(?:png|jpe?g|gif|webp|tiff|avif|bmp)$`,
  'i',
);
const CHAT_ATTACHMENT_STORAGE_ROOT = path.join(DATA_DIR, 'chat-attachments');

export interface ImageAttachmentInput {
  type?: unknown;
  data?: unknown;
  path?: unknown;
  mimeType?: unknown;
  name?: unknown;
}

export interface InlineImageAttachment {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface StagedImageAttachment {
  type: 'image';
  path: string;
  mimeType: string;
  name?: string;
}

export type NormalizedImageAttachment =
  | InlineImageAttachment
  | StagedImageAttachment;

export interface ImageAttachmentStorageContext {
  folder: string;
  /** Test-only override for the application-owned attachment root. */
  attachmentRootOverride?: string;
}

interface NormalizeOptions {
  onMimeMismatch?: (ctx: {
    declaredMime: string;
    detectedMime: string;
  }) => void;
}

function normalizeImageMimeType(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const lowered = raw.trim().toLowerCase();
  if (!lowered.startsWith('image/')) return undefined;
  return lowered;
}

function normalizeAttachmentName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.trim();
  return name.length > 0 && name.length <= 255 ? name : undefined;
}

function unwrapBase64Payload(raw: string): {
  base64: string;
  hintedMime?: string;
} {
  const match = DATA_URL_BASE64_RE.exec(raw);
  if (!match) return { base64: raw.replace(/\s+/g, '') };
  return {
    hintedMime: normalizeImageMimeType(match[1]),
    base64: match[2].replace(/\s+/g, ''),
  };
}

function resolveImageMimeType(
  declaredMime: string | undefined,
  detectedMime: string | null,
  options?: NormalizeOptions,
): string {
  if (declaredMime && detectedMime && declaredMime !== detectedMime) {
    options?.onMimeMismatch?.({ declaredMime, detectedMime });
    return detectedMime;
  }
  if (declaredMime) return declaredMime;
  if (detectedMime) return detectedMime;
  return 'image/jpeg';
}

export function isStagedChatAttachmentPath(value: unknown): value is string {
  return (
    typeof value === 'string' && STAGED_CHAT_ATTACHMENT_PATH_RE.test(value)
  );
}

function attachmentStorageRoot(folder: string, rootOverride?: string): string {
  const baseRoot = path.resolve(rootOverride ?? CHAT_ATTACHMENT_STORAGE_ROOT);
  const root = path.resolve(baseRoot, folder);
  const relative = path.relative(baseRoot, root);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Invalid attachment storage folder');
  }
  return root;
}

/**
 * Resolve a server-issued attachment reference under the application-owned store.
 * Chat attachments must never live in the runner-writable workspace file tree.
 */
export function getStagedChatAttachmentStoragePath(
  folder: string,
  attachmentPath: string,
  rootOverride?: string,
): string {
  if (!isStagedChatAttachmentPath(attachmentPath)) {
    throw new Error('Invalid staged image attachment path');
  }
  const root = attachmentStorageRoot(folder, rootOverride);
  const fileName = path.posix.basename(attachmentPath);
  const resolved = path.resolve(root, fileName);
  if (path.dirname(resolved) !== root) {
    throw new Error('Invalid staged image attachment path');
  }
  return resolved;
}

export function getStagedChatAttachmentStorageUsage(
  folder: string,
  rootOverride?: string,
): number {
  const root = attachmentStorageRoot(folder, rootOverride);
  try {
    let total = 0;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        !STAGED_CHAT_ATTACHMENT_PATH_RE.test(
          `${STAGED_CHAT_ATTACHMENT_PREFIX}${entry.name}`,
        )
      ) {
        continue;
      }
      total += fs.statSync(path.join(root, entry.name)).size;
    }
    return total;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

/** Persist immutable chat-image bytes outside the workspace and runner mounts. */
export function writeStagedChatAttachment(
  folder: string,
  attachmentPath: string,
  bytes: Buffer,
  rootOverride?: string,
): void {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('Invalid staged image attachment');
  }
  if (!isStagedChatAttachmentPath(attachmentPath)) {
    throw new Error('Invalid staged image attachment path');
  }
  const root = attachmentStorageRoot(folder, rootOverride);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const realRoot = fs.realpathSync(root);
  const target = path.join(realRoot, path.posix.basename(attachmentPath));

  const fd = fs.openSync(
    target,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) {
      offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function normalizeImageAttachment(
  input: ImageAttachmentInput,
  options?: NormalizeOptions,
): NormalizedImageAttachment | null {
  // 历史附件数据可能缺少 type 字段，缺失时默认视为 image。
  if ((input.type ?? 'image') !== 'image') return null;

  if (typeof input.data === 'string' && input.data.length > 0) {
    const { base64, hintedMime } = unwrapBase64Payload(input.data);
    if (base64.length === 0) return null;

    const declared = normalizeImageMimeType(input.mimeType) || hintedMime;
    const detected = detectImageMimeTypeFromBase64Strict(base64);
    return {
      type: 'image',
      data: base64,
      mimeType: resolveImageMimeType(declared, detected, options),
    };
  }

  if (!isStagedChatAttachmentPath(input.path)) return null;
  return {
    type: 'image',
    path: input.path,
    mimeType: normalizeImageMimeType(input.mimeType) || 'image/jpeg',
    name: normalizeAttachmentName(input.name),
  };
}

export function normalizeImageAttachments(
  inputs: unknown,
  options?: NormalizeOptions,
): NormalizedImageAttachment[] {
  if (!Array.isArray(inputs)) return [];
  const normalized: NormalizedImageAttachment[] = [];
  for (const item of inputs) {
    if (!item || typeof item !== 'object') continue;
    const out = normalizeImageAttachment(item as ImageAttachmentInput, options);
    if (out) normalized.push(out);
  }
  return normalized;
}

export function readStagedChatAttachment(
  attachment: StagedImageAttachment,
  storage: ImageAttachmentStorageContext,
  options?: NormalizeOptions,
): { bytes: Buffer; mimeType: string } {
  const storagePath = getStagedChatAttachmentStoragePath(
    storage.folder,
    attachment.path,
    storage.attachmentRootOverride,
  );
  let fd: number | undefined;
  try {
    // Open the final path with O_NOFOLLOW before inspecting it. Reading through
    // this descriptor closes the lstat/realpath/read race that could otherwise
    // follow a replacement symlink outside the attachment store.
    fd = fs.openSync(
      storagePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) {
      throw new Error('Invalid staged image attachment');
    }
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== stat.size) {
      throw new Error('Invalid staged image attachment');
    }
    const detected = detectImageMimeTypeStrict(bytes);
    if (!detected)
      throw new Error('Staged attachment is not a supported image');
    return {
      bytes,
      mimeType: resolveImageMimeType(attachment.mimeType, detected, options),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('Invalid staged image attachment');
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Convert persisted image metadata into runner input. Path-backed attachments are
 * limited to the server-owned staging namespace and revalidated from bytes on
 * every dispatch, including cold-start recovery.
 */
export function toAgentImages(
  attachments: NormalizedImageAttachment[] | undefined,
  storage?: ImageAttachmentStorageContext,
  options?: NormalizeOptions,
): Array<{ data: string; mimeType: string }> | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  const images = attachments.map((attachment) => {
    if ('data' in attachment) {
      return { data: attachment.data, mimeType: attachment.mimeType };
    }
    if (!storage) {
      throw new Error('Missing workspace context for staged image attachment');
    }
    const { bytes, mimeType } = readStagedChatAttachment(
      attachment,
      storage,
      options,
    );
    return { data: bytes.toString('base64'), mimeType };
  });
  return images.length > 0 ? images : undefined;
}
