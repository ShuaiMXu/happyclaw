import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  canonicalizeInstallationDataDir,
  deriveInstallationId,
} from '../src/instance-ownership.js';

const roots: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-installation-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('installation ownership identity', () => {
  test('is stable for the same canonical data directory', () => {
    const root = tempDir();
    const canonical = canonicalizeInstallationDataDir(root);

    expect(deriveInstallationId(canonical)).toBe(
      deriveInstallationId(canonical),
    );
    expect(deriveInstallationId(canonical)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('treats a symlink alias as the same installation', () => {
    const parent = tempDir();
    const dataDir = path.join(parent, 'data');
    const alias = path.join(parent, 'data-alias');
    fs.mkdirSync(dataDir);
    fs.symlinkSync(dataDir, alias);

    const direct = canonicalizeInstallationDataDir(dataDir);
    const throughAlias = canonicalizeInstallationDataDir(alias);
    expect(throughAlias).toBe(direct);
    expect(deriveInstallationId(throughAlias)).toBe(
      deriveInstallationId(direct),
    );
  });

  test('assigns different IDs to different data roots', () => {
    const first = canonicalizeInstallationDataDir(tempDir());
    const second = canonicalizeInstallationDataDir(tempDir());

    expect(deriveInstallationId(first)).not.toBe(deriveInstallationId(second));
  });

  test('fails closed when the data directory cannot be canonicalized', () => {
    const missing = path.join(tempDir(), 'missing');

    expect(() => canonicalizeInstallationDataDir(missing)).toThrow(/ENOENT/);
  });
});
