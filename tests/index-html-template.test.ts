import { afterEach, describe, expect, test, vi } from 'vitest';

const getAppearanceConfig = vi.fn();
vi.mock('../src/runtime-config.js', () => ({
  getAppearanceConfig,
}));

const { renderIndexHtml, renderManifest } =
  await import('../src/index-html-template.js');

const BASE_APPEARANCE = {
  appName: 'SoftopiaAI',
  aiName: 'SoftopiaAI',
  aiAvatarEmoji: '🐱',
  aiAvatarColor: '#0d9488',
  aiAvatarUrl: null,
  aiAvatarMode: 'brand' as const,
  brandIconUrl: null,
  brandBannerUrl: null,
  faviconUrl: null,
  brandLoadingIconUrl: null,
};

afterEach(() => {
  getAppearanceConfig.mockReset();
});

describe('renderIndexHtml', () => {
  test('leaves the built-in default favicon/apple-touch-icon/title untouched when unconfigured', () => {
    getAppearanceConfig.mockReturnValue(BASE_APPEARANCE);
    const html = renderIndexHtml();
    expect(html).toContain('href="/icons/icon-192.png"');
    expect(html).toContain('href="/icons/apple-touch-icon-180.png"');
    expect(html).toContain('<title>SoftopiaAI</title>');
  });

  test('bakes a configured favicon/brand icon/app name directly into the HTML response', () => {
    getAppearanceConfig.mockReturnValue({
      ...BASE_APPEARANCE,
      appName: '我的助手',
      faviconUrl: '/api/config/brand-assets/brand-favicon-abc123.png',
      brandIconUrl: '/api/config/brand-assets/brand-icon-def456.png',
    });
    const html = renderIndexHtml();
    // The tab favicon and the "Add to Home Screen" icon are two different
    // <link> tags — each must pick up its own configured URL, not swap or
    // bleed into the other.
    expect(html).toContain(
      'href="/api/config/brand-assets/brand-favicon-abc123.png"',
    );
    expect(html).toContain(
      'href="/api/config/brand-assets/brand-icon-def456.png"',
    );
    expect(html).not.toContain('href="/icons/icon-192.png"');
    expect(html).not.toContain('href="/icons/apple-touch-icon-180.png"');
    expect(html).toContain('<title>我的助手</title>');
    expect(html).toContain(
      '<meta name="apple-mobile-web-app-title" content="我的助手" />',
    );
  });

  test('escapes HTML-significant characters in the app name to avoid markup injection', () => {
    getAppearanceConfig.mockReturnValue({
      ...BASE_APPEARANCE,
      appName: '<script>alert(1)</script>',
    });
    const html = renderIndexHtml();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('other document structure (manifest link, root div, entry script) is unaffected', () => {
    getAppearanceConfig.mockReturnValue(BASE_APPEARANCE);
    const html = renderIndexHtml();
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('<div id="root"></div>');
  });

  test("embeds the appearance config as window.__appearancePrewarm so LogoLoading/LoginPage/SetupPage don't flash the default mark while waiting on a fetch", () => {
    getAppearanceConfig.mockReturnValue({
      ...BASE_APPEARANCE,
      appName: '我的助手',
      brandLoadingIconUrl: '/api/config/brand-assets/brand-loading-xyz.png',
    });
    const html = renderIndexHtml();
    expect(html).toContain('window.__appearancePrewarm = ');
    const match = html.match(/window\.__appearancePrewarm = (.*?);<\/script>/);
    expect(match).not.toBeNull();
    const embedded = JSON.parse(match![1]);
    expect(embedded.appName).toBe('我的助手');
    expect(embedded.brandLoadingIconUrl).toBe(
      '/api/config/brand-assets/brand-loading-xyz.png',
    );
  });

  test('escapes </script> inside the embedded prewarm JSON so it cannot break out of the script tag', () => {
    getAppearanceConfig.mockReturnValue({
      ...BASE_APPEARANCE,
      appName: '</script><script>alert(1)</script>',
    });
    const html = renderIndexHtml();
    expect(html).not.toContain('</script><script>alert(1)</script>');
    // The raw string still round-trips correctly once parsed back as JS/JSON.
    const match = html.match(/window\.__appearancePrewarm = (.*?);<\/script>/);
    const embedded = JSON.parse(match![1]);
    expect(embedded.appName).toBe('</script><script>alert(1)</script>');
  });
});

describe('renderManifest', () => {
  test('leaves name/short_name/icons at their built-in defaults when unconfigured', () => {
    getAppearanceConfig.mockReturnValue(BASE_APPEARANCE);
    const manifest = JSON.parse(renderManifest());
    expect(manifest.name).toBe('SoftopiaAI');
    expect(manifest.short_name).toBe('SoftopiaAI');
    expect(manifest.icons).toEqual([
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      {
        src: 'icons/icon-512-maskable.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ]);
  });

  test('replaces name/short_name/every icon src with the configured brand values', () => {
    getAppearanceConfig.mockReturnValue({
      ...BASE_APPEARANCE,
      appName: '我的助手',
      brandIconUrl: '/api/config/brand-assets/brand-icon-def456.png',
    });
    const manifest = JSON.parse(renderManifest());
    expect(manifest.name).toBe('我的助手');
    expect(manifest.short_name).toBe('我的助手');
    // Every icon entry points at the one configurable square mark — sizes
    // stay as declared (browsers scale), only src changes.
    for (const icon of manifest.icons) {
      expect(icon.src).toBe('/api/config/brand-assets/brand-icon-def456.png');
    }
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual([
      '192x192',
      '512x512',
      '512x512',
    ]);
  });

  test('other manifest fields (display, start_url, theme_color) are unaffected', () => {
    getAppearanceConfig.mockReturnValue(BASE_APPEARANCE);
    const manifest = JSON.parse(renderManifest());
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('./chat');
  });
});
