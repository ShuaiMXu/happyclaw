import { afterEach, describe, expect, test, vi } from 'vitest';

const getAppearanceConfig = vi.fn();
vi.mock('../src/runtime-config.js', () => ({
  getAppearanceConfig,
}));

const { renderIndexHtml } = await import('../src/index-html-template.js');

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
});
