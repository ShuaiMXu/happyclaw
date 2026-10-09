import { afterEach, describe, expect, test, vi } from 'vitest';
import { resolveMarkdownWorkspaceFileHref } from './markdownImageSrc';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveMarkdownWorkspaceFileHref', () => {
  test('routes a relative Markdown document link through the authenticated preview API', () => {
    const filePath = 'output/T2-浙江报价两页评估报告.pdf';
    const expected = Buffer.from(filePath).toString('base64url');

    expect(
      resolveMarkdownWorkspaceFileHref(
        'output/T2-%E6%B5%99%E6%B1%9F%E6%8A%A5%E4%BB%B7%E4%B8%A4%E9%A1%B5%E8%AF%84%E4%BC%B0%E6%8A%A5%E5%91%8A.pdf',
        'web:quote-workspace#agent:session-1',
      ),
    ).toBe(`/api/groups/web%3Aquote-workspace/files/preview/${expected}`);
  });

  test('supports percent-encoded spaces and Unicode in nested paths', () => {
    const filePath = 'output/最终报告/final report 2026.pdf';
    const expected = Buffer.from(filePath).toString('base64url');

    expect(
      resolveMarkdownWorkspaceFileHref(
        'output/%E6%9C%80%E7%BB%88%E6%8A%A5%E5%91%8A/final%20report%202026.pdf',
        'web:quote-workspace#agent:session-1',
      ),
    ).toBe(`/api/groups/web%3Aquote-workspace/files/preview/${expected}`);
  });

  test('leaves external, SPA-relative, traversal, and non-file links untouched', () => {
    expect(
      resolveMarkdownWorkspaceFileHref(
        'https://example.com/report.pdf',
        'web:quote-workspace',
      ),
    ).toBe('https://example.com/report.pdf');
    expect(
      resolveMarkdownWorkspaceFileHref(
        '/chat/output/report.pdf',
        'web:quote-workspace',
      ),
    ).toBe('/chat/output/report.pdf');
    expect(
      resolveMarkdownWorkspaceFileHref(
        '../output/report.pdf',
        'web:quote-workspace',
      ),
    ).toBe('../output/report.pdf');
    expect(
      resolveMarkdownWorkspaceFileHref(
        '%2e%2e/output/report.pdf',
        'web:quote-workspace',
      ),
    ).toBe('%2e%2e/output/report.pdf');
    expect(
      resolveMarkdownWorkspaceFileHref(
        'output\\report.pdf',
        'web:quote-workspace',
      ),
    ).toBe('output\\report.pdf');
    expect(
      resolveMarkdownWorkspaceFileHref('guide', 'web:quote-workspace'),
    ).toBe('guide');
  });

  test('uses the configured application base path', async () => {
    vi.stubEnv('BASE_URL', '/happyclaw/');
    vi.resetModules();
    const { resolveMarkdownWorkspaceFileHref: resolveWithBasePath } =
      await import('./markdownImageSrc');
    const expected = Buffer.from('output/final report.pdf').toString(
      'base64url',
    );

    expect(
      resolveWithBasePath('output/final%20report.pdf', 'web:quote-workspace'),
    ).toBe(
      `/happyclaw/api/groups/web%3Aquote-workspace/files/preview/${expected}`,
    );
  });
});
