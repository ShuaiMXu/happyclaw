import { describe, expect, test } from 'vitest';
import { classifyFileKind, looksLikeWorkspaceFilePath } from './fileKind';

describe('classifyFileKind', () => {
  test('classifies known previewable types', () => {
    expect(classifyFileKind('photo.png')).toBe('image');
    expect(classifyFileKind('report.pdf')).toBe('pdf');
    expect(classifyFileKind('clip.mp4')).toBe('video');
    expect(classifyFileKind('song.mp3')).toBe('audio');
    expect(classifyFileKind('notes.md')).toBe('text');
    expect(classifyFileKind('deploy.sh')).toBe('text');
  });

  test('falls back to download for archives and unknown extensions', () => {
    expect(classifyFileKind('bundle.zip')).toBe('download');
    expect(classifyFileKind('bundle.tar.gz')).toBe('download');
    expect(classifyFileKind('installer.exe')).toBe('download');
    expect(classifyFileKind('noextension')).toBe('download');
  });
});

describe('looksLikeWorkspaceFilePath', () => {
  test('accepts plausible file paths, including the reported script name', () => {
    expect(
      looksLikeWorkspaceFilePath(
        '/workspace/group/A-V2.60-全渠道销售接入客户合作渠道.sh',
      ),
    ).toBe(true);
    expect(looksLikeWorkspaceFilePath('foo/bar/baz.sh')).toBe(true);
    expect(looksLikeWorkspaceFilePath('package.json')).toBe(true);
    expect(looksLikeWorkspaceFilePath('report_v1.2.3.pdf')).toBe(true);
  });

  test('rejects ordinary inline code that is not a path', () => {
    expect(looksLikeWorkspaceFilePath('array.map()')).toBe(false);
    expect(looksLikeWorkspaceFilePath('version 1.10')).toBe(false);
    expect(looksLikeWorkspaceFilePath('v1.2.0')).toBe(false);
    expect(looksLikeWorkspaceFilePath('npm run build')).toBe(false);
    expect(looksLikeWorkspaceFilePath('$HOME/.bashrc')).toBe(false);
    expect(looksLikeWorkspaceFilePath('')).toBe(false);
    expect(looksLikeWorkspaceFilePath('.md')).toBe(false);
  });
});
