import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  deleteExternalCapabilityArtifact,
  deleteExternalCapabilityRunArtifacts,
  deleteExternalCapabilityRuntimeDirectory,
  getExternalCapabilityVaultRoot,
  listExternalCapabilityRunDirectories,
  listExternalCapabilityRuntimeDirectories,
  probeExternalCapabilityVault,
  readExternalCapabilityArtifact,
  storeExternalCapabilityArtifact,
  validateExternalCapabilityVaultRoot,
} from '../src/external-capability-storage.js';

const roots: string[] = [];

function createVaultRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'external-capability-vault-'),
  );
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('external capability private input vault', () => {
  test('stores immutable bytes outside workspaces and returns only an opaque reference', () => {
    const root = createVaultRoot();
    const bytes = Buffer.from('报价单内容', 'utf8');
    const stored = storeExternalCapabilityArtifact(root, {
      runId: 'run_01',
      artifactId: 'artifact_01',
      bytes,
    });

    expect(stored).toEqual({
      storageRef: 'ecv1:run_01:artifact_01',
      byteLength: bytes.byteLength,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
    expect(stored.storageRef).not.toContain(root);
    expect(
      readExternalCapabilityArtifact(root, {
        storageRef: stored.storageRef,
        byteLength: stored.byteLength,
        sha256: stored.sha256,
      }),
    ).toEqual(bytes);

    const runDirectory = path.join(root, 'runs', 'run_01');
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(runDirectory).mode & 0o777).toBe(0o700);
    expect(
      fs.statSync(path.join(runDirectory, 'artifact_01')).mode & 0o777,
    ).toBe(0o600);
  });

  test('probes create, fsync, read, digest, and delete readiness', () => {
    const root = createVaultRoot();
    probeExternalCapabilityVault(root);

    expect(listExternalCapabilityRunDirectories(root)).toEqual([]);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, 'runs')).mode & 0o777).toBe(0o700);
  });

  test('deletes only the selected immutable artifact', () => {
    const root = createVaultRoot();
    const first = storeExternalCapabilityArtifact(root, {
      runId: 'run_delete',
      artifactId: 'artifact_first',
      bytes: Buffer.from('first'),
    });
    const second = storeExternalCapabilityArtifact(root, {
      runId: 'run_delete',
      artifactId: 'artifact_second',
      bytes: Buffer.from('second'),
    });

    deleteExternalCapabilityArtifact(root, first.storageRef);
    expect(() =>
      deleteExternalCapabilityArtifact(root, first.storageRef),
    ).not.toThrow();
    expect(() =>
      readExternalCapabilityArtifact(root, {
        storageRef: first.storageRef,
        byteLength: first.byteLength,
        sha256: first.sha256,
      }),
    ).toThrow();
    expect(
      readExternalCapabilityArtifact(root, {
        storageRef: second.storageRef,
        byteLength: second.byteLength,
        sha256: second.sha256,
      }).toString(),
    ).toBe('second');

    fs.rmSync(path.join(root, 'runs', 'run_delete'), {
      recursive: true,
      force: true,
    });
    expect(() =>
      deleteExternalCapabilityArtifact(root, second.storageRef),
    ).not.toThrow();
  });

  test('deletes a whole run idempotently without following the runs parent', () => {
    const root = createVaultRoot();
    const runId = '11111111-1111-4111-8111-111111111111';
    storeExternalCapabilityArtifact(root, {
      runId,
      artifactId: 'artifact_first',
      bytes: Buffer.from('first'),
    });
    storeExternalCapabilityArtifact(root, {
      runId,
      artifactId: 'artifact_second',
      bytes: Buffer.from('second'),
    });

    expect(listExternalCapabilityRunDirectories(root)).toMatchObject([
      { name: runId, runId },
    ]);
    deleteExternalCapabilityRunArtifacts(root, runId);
    expect(fs.existsSync(path.join(root, 'runs', runId))).toBe(false);
    expect(() =>
      deleteExternalCapabilityRunArtifacts(root, runId),
    ).not.toThrow();

    const external = fs.mkdtempSync(
      path.join(os.tmpdir(), 'external-capability-sentinel-'),
    );
    roots.push(external);
    fs.rmSync(path.join(root, 'runs'), { recursive: true, force: true });
    fs.mkdirSync(path.join(external, runId), { recursive: true });
    const sentinel = path.join(external, runId, 'sentinel');
    fs.writeFileSync(sentinel, 'safe');
    fs.symlinkSync(external, path.join(root, 'runs'));

    expect(() => deleteExternalCapabilityRunArtifacts(root, runId)).toThrow(
      /real directory/,
    );
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('safe');
  });

  test('lists and deletes only strictly named runtime directories', () => {
    const root = createVaultRoot();
    const runtimeRoot = path.join(root, 'runtime');
    const runId = '22222222-2222-4222-8222-222222222222';
    const runtimeName = `${runId}-ABC123`;
    fs.mkdirSync(path.join(runtimeRoot, runtimeName), {
      recursive: true,
      mode: 0o700,
    });
    fs.mkdirSync(path.join(runtimeRoot, 'unknown'), { mode: 0o700 });

    expect(listExternalCapabilityRuntimeDirectories(root)).toMatchObject([
      { name: runtimeName, runId },
    ]);
    deleteExternalCapabilityRuntimeDirectory(root, runtimeName);
    expect(fs.existsSync(path.join(runtimeRoot, runtimeName))).toBe(false);
    expect(fs.existsSync(path.join(runtimeRoot, 'unknown'))).toBe(true);
    expect(() =>
      deleteExternalCapabilityRuntimeDirectory(root, runtimeName),
    ).not.toThrow();
    expect(() =>
      deleteExternalCapabilityRuntimeDirectory(root, 'unknown'),
    ).toThrow(/server-generated/);

    const external = fs.mkdtempSync(
      path.join(os.tmpdir(), 'external-runtime-sentinel-'),
    );
    roots.push(external);
    const sentinel = path.join(external, 'sentinel');
    fs.writeFileSync(sentinel, 'safe');
    fs.symlinkSync(external, path.join(runtimeRoot, runtimeName));
    expect(listExternalCapabilityRuntimeDirectories(root)).toEqual([]);
    expect(() =>
      deleteExternalCapabilityRuntimeDirectory(root, runtimeName),
    ).toThrow(/real directory/);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('safe');
  });

  test('does not overwrite a duplicate server-generated artifact ID', () => {
    const root = createVaultRoot();
    const input = { runId: 'run_02', artifactId: 'artifact_02' };
    const first = storeExternalCapabilityArtifact(root, {
      ...input,
      bytes: Buffer.from('first'),
    });

    expect(() =>
      storeExternalCapabilityArtifact(root, {
        ...input,
        bytes: Buffer.from('second'),
      }),
    ).toThrow();
    expect(
      readExternalCapabilityArtifact(root, {
        storageRef: first.storageRef,
        byteLength: first.byteLength,
        sha256: first.sha256,
      }).toString(),
    ).toBe('first');
  });

  test('rejects traversal-like identifiers and a vault inside the project root', () => {
    const root = createVaultRoot();
    expect(() =>
      storeExternalCapabilityArtifact(root, {
        runId: '../run',
        artifactId: 'artifact_03',
        bytes: Buffer.from('x'),
      }),
    ).toThrow(/server-generated identifier/);
    expect(() =>
      storeExternalCapabilityArtifact(root, {
        runId: 'run_03',
        artifactId: '../../artifact',
        bytes: Buffer.from('x'),
      }),
    ).toThrow(/server-generated identifier/);
    expect(() =>
      validateExternalCapabilityVaultRoot(
        path.join(process.cwd(), 'data', 'external-capability-inputs'),
      ),
    ).toThrow(/dedicated path outside project and home roots/);
    expect(() => getExternalCapabilityVaultRoot({})).toThrow(/required/);
  });

  test('rejects dangerous roots and symbolic-link ancestors', () => {
    expect(() =>
      validateExternalCapabilityVaultRoot(path.parse('/').root),
    ).toThrow(/dedicated path/);
    expect(() => validateExternalCapabilityVaultRoot(os.homedir())).toThrow(
      /dedicated path/,
    );
    expect(() =>
      validateExternalCapabilityVaultRoot(path.dirname(process.cwd())),
    ).toThrow(/dedicated path/);

    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'external-vault-link-'));
    const target = fs.mkdtempSync(
      path.join(os.tmpdir(), 'external-vault-target-'),
    );
    roots.push(base, target);
    fs.symlinkSync(target, path.join(base, 'linked'));
    expect(() =>
      validateExternalCapabilityVaultRoot(path.join(base, 'linked', 'vault')),
    ).toThrow(/symbolic-link ancestors/);
  });

  test('does not chmod an existing shared directory into a private vault', () => {
    const root = createVaultRoot();
    fs.chmodSync(root, 0o755);
    expect(() =>
      storeExternalCapabilityArtifact(root, {
        runId: 'run_shared',
        artifactId: 'artifact_shared',
        bytes: Buffer.from('x'),
      }),
    ).toThrow(/group or world accessible/);
    expect(fs.statSync(root).mode & 0o777).toBe(0o755);
  });

  test('rejects a symlink rather than following it for storage or reads', () => {
    const root = createVaultRoot();
    const runDirectory = path.join(root, 'runs', 'run_04');
    fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(root, 'target');
    fs.writeFileSync(target, 'safe');
    fs.symlinkSync(target, path.join(runDirectory, 'artifact_04'));

    expect(() =>
      storeExternalCapabilityArtifact(root, {
        runId: 'run_04',
        artifactId: 'artifact_04',
        bytes: Buffer.from('unsafe'),
      }),
    ).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('safe');
    expect(() =>
      readExternalCapabilityArtifact(root, {
        storageRef: 'ecv1:run_04:artifact_04',
        byteLength: 4,
        sha256: crypto.createHash('sha256').update('safe').digest('hex'),
      }),
    ).toThrow();
    expect(() =>
      deleteExternalCapabilityArtifact(root, 'ecv1:run_04:artifact_04'),
    ).toThrow(/not a regular file/);
    expect(fs.readFileSync(target, 'utf8')).toBe('safe');
  });

  test('detects changed artifact bytes before a runner can consume them', () => {
    const root = createVaultRoot();
    const stored = storeExternalCapabilityArtifact(root, {
      runId: 'run_05',
      artifactId: 'artifact_05',
      bytes: Buffer.from('same'),
    });
    fs.writeFileSync(path.join(root, 'runs', 'run_05', 'artifact_05'), 'evil');

    expect(() =>
      readExternalCapabilityArtifact(root, {
        storageRef: stored.storageRef,
        byteLength: stored.byteLength,
        sha256: stored.sha256,
      }),
    ).toThrow(/digest no longer matches/);
  });
});
