import { useEffect } from 'react';
import { useAuthStore } from '../stores/auth';
import { withBasePath } from '../utils/url';

// Both link tags ship a built-in default href in web/index.html. We capture
// each once so "恢复默认" (clearing the config) can restore it without
// hardcoding the built-in path here.
let defaultFaviconHref: string | null = null;
let defaultAppleTouchIconHref: string | null = null;

/**
 * Applies admin-configured branding (设置 → 常规与品牌) to two document
 * `<link>` tags:
 *   - `rel="icon"` (browser tab favicon) ← `faviconUrl`
 *   - `rel="apple-touch-icon"` (iOS "Add to Home Screen" / Safari tab
 *     switcher / frequently-visited shortcut tile) ← `brandIconUrl`, the
 *     same 400x400 square mark used in the desktop sidebar rail
 * Runs on every route — including pre-login pages like /login and /setup —
 * since appearance is fetched from the public, unauthenticated
 * `/api/config/appearance/public` endpoint.
 *
 * Before this wired apple-touch-icon, iOS Safari's tab-switcher card and
 * "frequently visited" shortcut tile always showed the built-in default
 * icon regardless of any custom brand icon uploaded — that tag was never
 * touched anywhere in the app.
 */
export function useDynamicFavicon() {
  const faviconUrl = useAuthStore((s) => s.appearance?.faviconUrl ?? null);
  const brandIconUrl = useAuthStore((s) => s.appearance?.brandIconUrl ?? null);
  const fetchAppearance = useAuthStore((s) => s.fetchAppearance);

  useEffect(() => {
    void fetchAppearance();
  }, [fetchAppearance]);

  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    if (defaultFaviconHref === null) {
      defaultFaviconHref = link.getAttribute('href') || '';
    }
    link.href = faviconUrl ? withBasePath(faviconUrl) : defaultFaviconHref;
  }, [faviconUrl]);

  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>(
      'link[rel="apple-touch-icon"]',
    );
    if (!link) return;
    if (defaultAppleTouchIconHref === null) {
      defaultAppleTouchIconHref = link.getAttribute('href') || '';
    }
    link.href = brandIconUrl
      ? withBasePath(brandIconUrl)
      : defaultAppleTouchIconHref;
  }, [brandIconUrl]);
}
