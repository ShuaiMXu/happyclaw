import { toBase64Url } from '../stores/files';
import { withBasePath } from './url';

const ENCODED_BYTE_RUN = /(?:%[0-9a-f]{2})+/gi;
// decodeURI preserves most URI-reserved escapes, but not these seven.
const DECODE_URI_UNESCAPED_RESERVED = /(%(?:21|27|28|29|2a|5b|5d))/gi;
const DECODE_URI_UNESCAPED_RESERVED_EXACT = /^%(?:21|27|28|29|2a|5b|5d)$/i;

function decodeValidPrefixes(value: string): string {
  let decoded = '';
  let remaining = value;

  while (remaining) {
    let decodedLength = 0;
    for (let length = remaining.length; length > 0; length -= 3) {
      try {
        decoded += decodeURI(remaining.slice(0, length));
        decodedLength = length;
        break;
      } catch {
        // Try a shorter prefix so one malformed UTF-8 byte stays literal while
        // later valid UTF-8 in the same run can still be decoded.
      }
    }

    if (decodedLength === 0) {
      decoded += remaining.slice(0, 3);
      decodedLength = 3;
    }
    remaining = remaining.slice(decodedLength);
  }

  return decoded;
}

/**
 * Decode the percent-encoded UTF-8 produced by micromark without changing URI
 * reserved escapes or letting one malformed escape prevent later text from
 * being decoded.
 */
export function decodeMarkdownImagePath(value: string): string {
  return value.replace(ENCODED_BYTE_RUN, (run) =>
    run
      .split(DECODE_URI_UNESCAPED_RESERVED)
      .map((part) =>
        DECODE_URI_UNESCAPED_RESERVED_EXACT.test(part)
          ? part
          : decodeValidPrefixes(part),
      )
      .join(''),
  );
}

/** Resolve a markdown image source to the local file download API. */
export function resolveMarkdownImageSrc(
  src: string,
  groupJid?: string,
): string {
  if (!groupJid || !src) return src;
  if (/^(https?:\/\/|data:|\/\/)/.test(src) || src.startsWith('/')) return src;

  const baseJid = groupJid.replace(/#agent:.*$/, '');
  const encoded = toBase64Url(decodeMarkdownImagePath(src));
  return withBasePath(
    `/api/groups/${encodeURIComponent(baseJid)}/files/download/${encoded}`,
  );
}

/**
 * Resolve a plain relative document link in a chat message through the
 * authenticated workspace-file API. Without this, a Markdown link such as
 * `output/report.pdf` is resolved by the browser below `/chat/` and becomes a
 * non-existent public URL (`/chat/output/report.pdf`).
 */
export function resolveMarkdownWorkspaceFileHref(
  href: string | undefined,
  groupJid?: string,
): string | undefined {
  if (!href || !groupJid) return href;
  const trimmed = href.trim();
  if (
    !trimmed ||
    /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(trimmed) ||
    trimmed.startsWith('/') ||
    trimmed.includes('?') ||
    trimmed.includes('#')
  ) {
    return href;
  }

  const decoded = decodeMarkdownImagePath(trimmed);
  // Only rewrite a relative file path with a conventional extension. Spaces
  // and Unicode are valid workspace filename characters, while empty,
  // traversal, control-character, and Windows-style path segments are not.
  // The server revalidates the decoded path against the workspace root before
  // it ever reads a file.
  const segments = decoded.split('/');
  const fileName = segments.at(-1) ?? '';
  if (
    /[\\\u0000-\u001f\u007f]/.test(decoded) ||
    segments.some(
      (segment) =>
        !segment ||
        !segment.trim() ||
        segment === '.' ||
        segment === '..',
    ) ||
    !/\.[A-Za-z0-9]{1,16}$/.test(fileName)
  ) {
    return href;
  }

  const baseJid = groupJid.replace(/#agent:.*$/, '');
  const encoded = toBase64Url(decoded);
  return withBasePath(
    `/api/groups/${encodeURIComponent(baseJid)}/files/preview/${encoded}`,
  );
}
