/**
 * Reliable file download utilities using fetch + blob.
 *
 * The old pattern `<a href="url" download="name">.click()` breaks on:
 *   - iOS Safari / PWA standalone mode (download attr ignored for server URLs)
 *   - Large data URLs (browser size limits)
 *   - Some mobile browsers (programmatic click not honoured)
 *
 * This module always goes through fetch → Blob → ObjectURL which works
 * consistently across all modern browsers and PWA modes.
 */

import { withBasePath } from './url';

export class DownloadError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

async function readDownloadErrorMessage(response: Response): Promise<string> {
  const fallback = `下载失败 (${response.status})`;
  const contentType = response.headers.get('content-type') || '';

  try {
    if (contentType.includes('application/json')) {
      const body = (await response.json()) as {
        error?: unknown;
        message?: unknown;
      };
      const message =
        typeof body.error === 'string'
          ? body.error
          : typeof body.message === 'string'
            ? body.message
            : null;
      return message?.trim() || fallback;
    }

    if (contentType.startsWith('text/plain')) {
      return (await response.text()).trim() || fallback;
    }
  } catch {
    // Keep a safe status-based message when the response body is malformed.
  }

  return fallback;
}

/**
 * Trigger a browser download from a Blob.
 */
function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a short delay so the browser has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/** Download UTF-8 text generated in the browser (for example a CSV export). */
export function downloadTextFile(
  content: string,
  filename: string,
  mimeType = 'text/plain;charset=utf-8',
): void {
  triggerBlobDownload(new Blob([content], { type: mimeType }), filename);
}

/**
 * Download a file from an API endpoint (or any same-origin URL).
 * Uses fetch with credentials so auth cookies are always included.
 */
export async function downloadFromUrl(
  url: string,
  filename: string,
): Promise<void> {
  const fullUrl = url.startsWith('http') ? url : withBasePath(url);
  const res = await fetch(fullUrl, { credentials: 'include' });
  if (!res.ok) {
    throw new DownloadError(res.status, await readDownloadErrorMessage(res));
  }
  const blob = await res.blob();
  triggerBlobDownload(blob, filename);
}

/**
 * Save a Blob via the native share sheet when available, falling back to
 * the synthetic `<a download>` blob click otherwise.
 *
 * On mobile — especially iOS Safari, including installed-PWA mode — the
 * `<a download>` blob-click pattern above does NOT reliably save into the
 * Photos/相册 app; it tends to just open the file in-place or silently do
 * nothing. `navigator.share({ files })` surfaces the OS share sheet, which
 * offers "存储图像/Save Image" straight into the photo library — the
 * standard, reliable way to get this on mobile. Desktop browsers mostly
 * don't implement file sharing (or don't have a photo library to save
 * into), so they fall through to the existing blob-download path.
 */
export async function shareOrDownloadFile(
  blob: Blob,
  filename: string,
): Promise<void> {
  if (
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function'
  ) {
    try {
      const file = new File([blob], filename, {
        type: blob.type || 'application/octet-stream',
      });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    } catch (err) {
      // The user dismissing the share sheet throws AbortError — that's a
      // deliberate cancel, not a failure, so don't fall through to also
      // triggering a second (blob-download) save attempt.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // Any other share failure (unsupported file type, etc.): fall
      // through to the blob-download path below.
    }
  }
  triggerBlobDownload(blob, filename);
}

/**
 * Like `downloadFromUrl`, but saves via `shareOrDownloadFile` — prefer this
 * for user-facing "save this image" actions (see its docs above).
 */
export async function shareOrDownloadFromUrl(
  url: string,
  filename: string,
): Promise<void> {
  const fullUrl = url.startsWith('http') ? url : withBasePath(url);
  const res = await fetch(fullUrl, { credentials: 'include' });
  if (!res.ok) {
    throw new DownloadError(res.status, await readDownloadErrorMessage(res));
  }
  const blob = await res.blob();
  await shareOrDownloadFile(blob, filename);
}

/**
 * Download a data-URL (e.g. from html-to-image / canvas) as a file.
 * Converts to Blob first to avoid browser data-URL size limits.
 */
export async function downloadFromDataUrl(
  dataUrl: string,
  filename: string,
): Promise<void> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  triggerBlobDownload(blob, filename);
}

/** Like `downloadFromDataUrl`, but saves via `shareOrDownloadFile`. */
export async function shareOrDownloadFromDataUrl(
  dataUrl: string,
  filename: string,
): Promise<void> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  await shareOrDownloadFile(blob, filename);
}
