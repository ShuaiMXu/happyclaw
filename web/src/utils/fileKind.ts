/**
 * File-extension classification shared between the project-files panel
 * (FilePanel) and anywhere else that needs to decide how to open a
 * workspace file — e.g. a clickable file path mentioned in a chat message.
 * Keeping a single source of truth here avoids the two call sites silently
 * drifting apart on which extensions preview vs. download.
 */

export const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'bmp',
  'ico',
]);

export const TEXT_EXTENSIONS = new Set([
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

export const CODE_EXTENSIONS = new Set([
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

export const ARCHIVE_EXTENSIONS = new Set([
  'zip',
  'tar',
  'gz',
  '7z',
  'rar',
  'bz2',
  'xz',
]);

export const PDF_EXTENSIONS = new Set(['pdf']);

export const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv']);

export const AUDIO_EXTENSIONS = new Set([
  'mp3',
  'wav',
  'ogg',
  'aac',
  'm4a',
  'flac',
]);

const ALL_KNOWN_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ...TEXT_EXTENSIONS,
  ...ARCHIVE_EXTENSIONS,
  ...PDF_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
]);

export function getFileExt(name: string): string {
  return name.split('.').pop()?.toLowerCase() || '';
}

export type FilePreviewKind =
  | 'image'
  | 'pdf'
  | 'video'
  | 'audio'
  | 'text'
  | 'download';

/**
 * Coarse "how should clicking this file behave" classification. Anything
 * that isn't a known previewable type (archives included) falls back to
 * 'download' — that's a much safer default than routing it into the plain
 * text preview, which can only render UTF-8 text.
 */
export function classifyFileKind(name: string): FilePreviewKind {
  const ext = getFileExt(name);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (PDF_EXTENSIONS.has(ext)) return 'pdf';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'download';
}

/**
 * Heuristic for "does this inline-code span in a chat message look like a
 * workspace file path" — used to make such spans clickable. Deliberately
 * conservative: no whitespace or shell/URL-ish punctuation, and a
 * recognized file extension, so ordinary code identifiers or prose don't
 * turn into dead clickable buttons.
 */
export function looksLikeWorkspaceFilePath(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 300) return false;
  if (/[\s`]/.test(trimmed)) return false;
  if (/[*?"<>|;&$(){}[\]\\]/.test(trimmed)) return false;
  const ext = getFileExt(trimmed);
  if (!ext || !ALL_KNOWN_EXTENSIONS.has(ext)) return false;
  const base = trimmed.slice(0, trimmed.length - ext.length - 1);
  return base.length > 0;
}
