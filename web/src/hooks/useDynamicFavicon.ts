import { useEffect } from 'react';
import { useAuthStore } from '../stores/auth';
import { withBasePath } from '../utils/url';

// The favicon `<link>` ships a built-in default href in web/index.html. We
// capture it once so "恢复默认" (clearing the config) can restore it without
// hardcoding the built-in path here.
let defaultFaviconHref: string | null = null;

/**
 * Applies the admin-configured favicon (设置 → 常规与品牌) to the document's
 * `<link rel="icon">` tag. Runs on every route — including pre-login pages
 * like /login and /setup — since appearance is fetched from the public,
 * unauthenticated `/api/config/appearance/public` endpoint.
 */
export function useDynamicFavicon() {
  const faviconUrl = useAuthStore((s) => s.appearance?.faviconUrl ?? null);
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
}
