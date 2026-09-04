import fs from 'node:fs';
import path from 'node:path';
import { getAppearanceConfig } from './runtime-config.js';

const INDEX_HTML_PATH = path.resolve('./web/dist/index.html');
const MANIFEST_PATH = path.resolve('./web/dist/manifest.webmanifest');

function readCachedFile(
  filePath: string,
  cache: { mtimeMs: number; content: string } | null,
): { content: string; cache: { mtimeMs: number; content: string } } {
  const stat = fs.statSync(filePath);
  if (cache && cache.mtimeMs === stat.mtimeMs) {
    return { content: cache.content, cache };
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const next = { mtimeMs: stat.mtimeMs, content };
  return { content, cache: next };
}

let cachedTemplate: { mtimeMs: number; content: string } | null = null;

function readIndexHtmlTemplate(): string {
  const { content, cache } = readCachedFile(INDEX_HTML_PATH, cachedTemplate);
  cachedTemplate = cache;
  return content;
}

let cachedManifestTemplate: { mtimeMs: number; content: string } | null = null;

function readManifestTemplate(): string {
  const { content, cache } = readCachedFile(
    MANIFEST_PATH,
    cachedManifestTemplate,
  );
  cachedManifestTemplate = cache;
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
 * JSON.stringify, but safe to inline inside a `<script>` tag — plain
 * JSON.stringify can emit a literal `</script>` (if a string value contains
 * it) which would prematurely close the tag and let the rest of the
 * response be parsed as HTML/markup instead of JS. `<`, `>` and `/` are
 * escaped as `\uXXXX` sequences, which JS parses back to the original
 * characters at runtime — this only changes how the *script source text*
 * reads, not the resulting value.
 */
function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\//g, '\\u002f');
}

/**
 * Server-render the tenant's configured favicon/apple-touch-icon/app-name
 * into `index.html` before it reaches the browser, and embed the full
 * appearance config as `window.__appearancePrewarm` so the store can read
 * it synchronously on init instead of waiting on a network round-trip.
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
 *
 * `__appearancePrewarm` fixes the same class of flash for anything that
 * reads `appearance` from the store before the app's own fetch resolves —
 * the boot loading screen (`LogoLoading.tsx`) and the pre-login pages
 * (`LoginPage.tsx`/`SetupPage.tsx`), none of which get `appearance` from the
 * `/api/auth/me` prewarm (only an authenticated session response includes
 * it) — without a second real network request, since `getAppearanceConfig`
 * is cheap and already being read for the favicon/title substitutions
 * above.
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

  const prewarmScript = `<script>window.__appearancePrewarm = ${jsonForInlineScript(appearance)};</script>`;
  html = html.replace('</head>', `${prewarmScript}\n  </head>`);

  return html;
}

/**
 * Server-render `manifest.webmanifest`'s `name`/`short_name`/`icons` from
 * the tenant's appearance config. Static-only before this — a custom brand
 * icon never showed up in the OS "Add to Home Screen" / app-switcher tile,
 * regardless of what was configured for the favicon/sidebar mark.
 *
 * Only one square icon size is actually configurable (`brandIconUrl`, the
 * same 400x400 mark used elsewhere) — reused across every `sizes` entry
 * from the built-in manifest rather than only replacing one. Browsers
 * scale a single source image to whatever size slot they pick; this isn't
 * as crisp as purpose-built assets per size, but is a large step up from
 * always showing the platform's own default mark.
 */
export function renderManifest(): string {
  const template = readManifestTemplate();
  const appearance = getAppearanceConfig();
  const manifest = JSON.parse(template) as {
    name?: string;
    short_name?: string;
    icons?: Array<{
      src: string;
      sizes?: string;
      type?: string;
      purpose?: string;
    }>;
  };

  if (appearance.appName) {
    manifest.name = appearance.appName;
    manifest.short_name = appearance.appName;
  }
  if (appearance.brandIconUrl && Array.isArray(manifest.icons)) {
    manifest.icons = manifest.icons.map((icon) => ({
      ...icon,
      src: appearance.brandIconUrl as string,
    }));
  }

  return JSON.stringify(manifest, null, 2);
}
