import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { ensureDirectoryTreeNoSymlinks } from '../src/utils.js';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'happyclaw-directory-confinement-'),
  );
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('ensureDirectoryTreeNoSymlinks', () => {
  test('creates a contained directory tree with private target permissions', () => {
    const root = temporaryRoot();
    const target = path.join(root, 'workspace', 'agents', 'agent-1');

    expect(ensureDirectoryTreeNoSymlinks(root, target)).toBe(target);
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(fs.statSync(target).mode & 0o777).toBe(0o700);
  });

  test('rejects lexical escapes from the trusted root', () => {
    const root = temporaryRoot();

    expect(() =>
      ensureDirectoryTreeNoSymlinks(root, path.join(root, '..', 'escaped')),
    ).toThrow(/escapes trusted root/i);
  });

  test('rejects an intermediate symlink even when it resolves to a directory', () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    fs.symlinkSync(outside, path.join(root, 'workspace'));

    expect(() =>
      ensureDirectoryTreeNoSymlinks(
        root,
        path.join(root, 'workspace', 'agents', 'agent-1'),
      ),
    ).toThrow(/unsafe directory component/i);
    expect(fs.existsSync(path.join(outside, 'agents'))).toBe(false);
  });

  test('rejects a regular file used as a directory component', () => {
    const root = temporaryRoot();
    fs.writeFileSync(path.join(root, 'workspace'), 'not a directory');

    expect(() =>
      ensureDirectoryTreeNoSymlinks(
        root,
        path.join(root, 'workspace', 'agents', 'agent-1'),
      ),
    ).toThrow(/unsafe directory component/i);
  });
});
