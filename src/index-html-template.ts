import fs from 'node:fs';
import path from 'node:path';
import { getAppearanceConfig } from './runtime-config.js';

const INDEX_HTML_PATH = path.resolve('./web/dist/index.html');

let cachedTemplate: { mtimeMs: number; content: string } | null = null;

function readIndexHtmlTemplate(): string {
  const stat = fs.statSync(INDEX_HTML_PATH);
  if (cachedTemplate && cachedTemplate.mtimeMs === stat.mtimeMs) {
    return cachedTemplate.content;
  }
  const content = fs.readFileSync(INDEX_HTML_PATH, 'utf-8');
  cachedTemplate = { mtimeMs: stat.mtimeMs, content };
  return content;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Server-render the tenant's configured favicon/apple-touch-icon/app-name
 * into `index.html` before it reaches the browser.
 *
 * Without this, the browser tab shows the platform's own built-in default
 * icon — visually distinct enough from a custom uploaded brand mark that it
 * reads as a glitch — for the entire round-trip until client-side JS loads
 * and fetches `/api/config/appearance/public` (see
 * `web/src/hooks/useDynamicFavicon.ts`). By the time that fetch resolves,
 * the browser has already painted (and often already fetched) the default
 * `<link>` href baked into the static HTML — patching the DOM afterward
 * can't undo that flash. This closes the gap by baking the correct href
 * into the very first bytes of the HTML response instead. The client-side
 * hook still runs on top of this (harmless no-op on a normal load; picks up
 * live changes without a full page reload from an open settings tab).
 */
export function renderIndexHtml(): string {
  const template = readIndexHtmlTemplate();
  const appearance = getAppearanceConfig();
  let html = template;

  if (appearance.faviconUrl) {
    html = html.replace(
      /(<link\s+rel="icon"[^>]*?href=")[^"]*(")/,
      `$1${escapeHtmlAttr(appearance.faviconUrl)}$2`,
    );
  }
  if (appearance.brandIconUrl) {
    html = html.replace(
      /(<link\s+rel="apple-touch-icon"[^>]*?href=")[^"]*(")/,
      `$1${escapeHtmlAttr(appearance.brandIconUrl)}$2`,
    );
  }
  if (appearance.appName) {
    const escapedName = escapeHtmlText(appearance.appName);
    const escapedNameAttr = escapeHtmlAttr(appearance.appName);
    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${escapedName}</title>`)
      .replace(
        /(<meta\s+name="apple-mobile-web-app-title"\s+content=")[^"]*(")/,
        `$1${escapedNameAttr}$2`,
      );
  }

  return html;
}
