import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, test } from 'vitest';

import {
  acquireExternalCapabilityVaultExclusiveLock,
  acquireExternalCapabilityVaultSharedLock,
} from '../src/external-capability-vault-lock.js';

const execFileAsync = promisify(execFile);
const childPath = fileURLToPath(
  new URL('./external-capability-vault-lock-child.ts', import.meta.url),
);
const roots: string[] = [];

interface LockFixture {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  root: string;
  vaultRoot: string;
}

function createFixture(vaultId = 'vault-lock-test'): LockFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'external-vault-lock-'));
  roots.push(root);
  const dataDir = path.join(root, 'data');
  const vaultRoot = path.join(root, 'vault');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  fs.mkdirSync(vaultRoot, { mode: 0o700 });
  return {
    dataDir,
    env: {
      ...process.env,
      EXTERNAL_CAPABILITY_VAULT_DIR: vaultRoot,
      EXTERNAL_CAPABILITY_VAULT_ID: vaultId,
    },
    root,
    vaultRoot,
  };
}

function getLockRoot(fixture: LockFixture): string {
  const identity = crypto
    .createHash('sha256')
    .update(path.resolve(fixture.vaultRoot))
    .digest('hex');
  return path.join(
    fixture.dataDir,
    'external-capability-vault-locks',
    identity,
  );
}

async function runChild(
  mode: 'shared' | 'exclusive',
  fixture: LockFixture,
  options: { leak?: boolean; vaultId?: string } = {},
): Promise<{ acquired: boolean; error?: string }> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--import',
      'tsx',
      childPath,
      mode,
      fixture.vaultRoot,
      options.vaultId ?? fixture.env.EXTERNAL_CAPABILITY_VAULT_ID!,
      fixture.dataDir,
      ...(options.leak ? ['leak'] : []),
    ],
    { cwd: path.resolve(path.dirname(childPath), '..') },
  );
  return JSON.parse(stdout.trim()) as { acquired: boolean; error?: string };
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('external capability Vault cross-process lock', () => {
  test('blocks an exclusive census while a producer is live', async () => {
    const fixture = createFixture();
    const shared = acquireExternalCapabilityVaultSharedLock(
      fixture.env,
      fixture.dataDir,
    );
    expect(shared).not.toBeNull();
    try {
      await expect(runChild('exclusive', fixture)).resolves.toMatchObject({
        acquired: false,
        error: expect.stringMatching(/blocked by active producers/),
      });
    } finally {
      shared?.release();
    }
  });

  test('blocks a producer while an exclusive census is live', async () => {
    const fixture = createFixture();
    const exclusive = acquireExternalCapabilityVaultExclusiveLock(
      fixture.env,
      fixture.dataDir,
    );
    try {
      await expect(runChild('shared', fixture)).resolves.toEqual({
        acquired: false,
      });
    } finally {
      exclusive.release();
    }
  });

  test('reclaims a shared owner only after its process exits', async () => {
    const fixture = createFixture();
    await expect(runChild('shared', fixture, { leak: true })).resolves.toEqual({
      acquired: true,
    });

    const exclusive = acquireExternalCapabilityVaultExclusiveLock(
      fixture.env,
      fixture.dataDir,
    );
    exclusive.release();
  });

  test('reclaims a dead exclusive owner atomically', async () => {
    const fixture = createFixture();
    await expect(
      runChild('exclusive', fixture, { leak: true }),
    ).resolves.toEqual({ acquired: true });

    const exclusive = acquireExternalCapabilityVaultExclusiveLock(
      fixture.env,
      fixture.dataDir,
    );
    exclusive.release();
  });

  test('reclaims an owner when its PID belongs to a different process incarnation', () => {
    const fixture = createFixture();
    expect(
      acquireExternalCapabilityVaultSharedLock(fixture.env, fixture.dataDir),
    ).not.toBeNull();
    const lockRoot = getLockRoot(fixture);
    const sharedDirectory = path.join(lockRoot, 'shared');
    const [ownerEntry] = fs.readdirSync(sharedDirectory);
    expect(ownerEntry).toBeDefined();
    const ownerPath = path.join(sharedDirectory, ownerEntry!);
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as {
      processStartTicks: string;
    };
    owner.processStartTicks = String(BigInt(owner.processStartTicks) + 1n);
    fs.writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600 });

    const exclusive = acquireExternalCapabilityVaultExclusiveLock(
      fixture.env,
      fixture.dataDir,
    );
    exclusive.release();
    expect(fs.readdirSync(sharedDirectory)).toEqual([]);
  });

  test('publishes complete owner records outside the temporary directory', () => {
    const fixture = createFixture();
    const shared = acquireExternalCapabilityVaultSharedLock(
      fixture.env,
      fixture.dataDir,
    );
    expect(shared).not.toBeNull();
    const lockRoot = getLockRoot(fixture);
    const [ownerEntry] = fs.readdirSync(path.join(lockRoot, 'shared'));
    expect(
      JSON.parse(
        fs.readFileSync(path.join(lockRoot, 'shared', ownerEntry!), 'utf8'),
      ),
    ).toMatchObject({
      version: 2,
      pid: process.pid,
      bootId: expect.any(String),
      processStartTicks: expect.stringMatching(/^\d+$/),
      token: expect.any(String),
    });
    expect(fs.readdirSync(path.join(lockRoot, 'tmp'))).toEqual([]);
    shared?.release();
  });

  test('uses the physical Vault path as the lock namespace across ID changes', async () => {
    const fixture = createFixture('vault-lock-old-id');
    const shared = acquireExternalCapabilityVaultSharedLock(
      fixture.env,
      fixture.dataDir,
    );
    expect(shared).not.toBeNull();
    try {
      await expect(
        runChild('exclusive', fixture, { vaultId: 'vault-lock-new-id' }),
      ).resolves.toMatchObject({
        acquired: false,
        error: expect.stringMatching(/blocked by active producers/),
      });
    } finally {
      shared?.release();
    }
  });

  test('rejects a symbolic-link lock parent', () => {
    const fixture = createFixture();
    const outside = path.join(fixture.root, 'outside');
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.symlinkSync(
      outside,
      path.join(fixture.dataDir, 'external-capability-vault-locks'),
    );

    expect(() =>
      acquireExternalCapabilityVaultSharedLock(fixture.env, fixture.dataDir),
    ).toThrow();
  });
});
