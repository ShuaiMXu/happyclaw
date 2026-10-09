import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  deleteExternalCapabilityArtifact,
  deleteExternalCapabilityRunArtifacts,
  deleteExternalCapabilityRuntimeDirectory,
  EXTERNAL_CAPABILITY_VAULT_ID_SENTINEL,
  externalCapabilityArtifactExists,
  inventoryExternalCapabilityVault,
  readExternalCapabilityArtifact,
  storeExternalCapabilityArtifact,
  withExternalCapabilityVaultCensus,
} from '../src/external-capability-storage.js';

const roots: string[] = [];
const vaultId = 'vault-11111111-1111-4111-8111-111111111111';

function createVaultRoot(withSentinel = true): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'external-capability-vault-identity-'),
  );
  roots.push(root);
  if (withSentinel) {
    fs.writeFileSync(
      path.join(root, EXTERNAL_CAPABILITY_VAULT_ID_SENTINEL),
      vaultId,
      { mode: 0o600 },
    );
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('external capability Vault identity census', () => {
  test('pins the root and inventories artifacts and runtimes individually', () => {
    const root = createVaultRoot();
    const runId = '11111111-1111-4111-8111-111111111111';
    const runDirectory = path.join(root, 'runs', runId);
    const runtimeName = `${runId}-a1-l1-ABC123`;
    const runtimeDirectory = path.join(root, 'runtime', runtimeName);
    fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(runtimeDirectory, 'output'), {
      recursive: true,
      mode: 0o700,
    });
    fs.writeFileSync(path.join(runDirectory, 'artifact_first'), '1234', {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(runDirectory, 'artifact_second'), '12', {
      mode: 0o600,
    });
    fs.writeFileSync(
      path.join(runtimeDirectory, 'output', 'result.json'),
      '123',
      {
        mode: 0o600,
      },
    );

    const first = withExternalCapabilityVaultCensus(
      root,
      vaultId,
      (census) => census,
    );
    const secondIdentity = withExternalCapabilityVaultCensus(
      root,
      vaultId,
      (census) => census.identity,
    );

    expect(first.identity).toMatch(/^v2:[a-f0-9]{64}$/);
    expect(secondIdentity).toBe(first.identity);
    expect(first.occupancies).toEqual([
      {
        runId,
        kind: 'artifact',
        objectKey: 'artifact_first',
        occupiedBytes: 4,
      },
      {
        runId,
        kind: 'artifact',
        objectKey: 'artifact_second',
        occupiedBytes: 2,
      },
      {
        runId,
        kind: 'runtime',
        objectKey: runtimeName,
        occupiedBytes: 3,
      },
    ]);
    expect(inventoryExternalCapabilityVault(root, vaultId)).toEqual(
      first.occupancies,
    );
  });

  test('requires an existing matching, private, single-link sentinel', () => {
    const missingRoot = path.join(
      os.tmpdir(),
      `external-capability-vault-missing-${crypto.randomUUID()}`,
    );
    expect(() =>
      withExternalCapabilityVaultCensus(missingRoot, vaultId, () => undefined),
    ).toThrow();

    const noSentinel = createVaultRoot(false);
    expect(() =>
      withExternalCapabilityVaultCensus(noSentinel, vaultId, () => undefined),
    ).toThrow();

    const mismatch = createVaultRoot();
    expect(() =>
      withExternalCapabilityVaultCensus(
        mismatch,
        'another-vault',
        () => undefined,
      ),
    ).toThrow(/does not match/);

    const linked = createVaultRoot();
    fs.linkSync(
      path.join(linked, EXTERNAL_CAPABILITY_VAULT_ID_SENTINEL),
      path.join(linked, 'sentinel-hard-link'),
    );
    expect(() =>
      withExternalCapabilityVaultCensus(linked, vaultId, () => undefined),
    ).toThrow(/multiply linked/);
  });

  test('revalidates the configured root before returning from the callback', () => {
    const root = createVaultRoot();
    const movedRoot = `${root}-moved`;
    roots.push(movedRoot);

    expect(() =>
      withExternalCapabilityVaultCensus(root, vaultId, () => {
        fs.renameSync(root, movedRoot);
        fs.mkdirSync(root, { mode: 0o700 });
        fs.writeFileSync(
          path.join(root, EXTERNAL_CAPABILITY_VAULT_ID_SENTINEL),
          vaultId,
          { mode: 0o600 },
        );
      }),
    ).toThrow(/root identity changed/);
  });
});

describe('external capability Vault hard-link fences', () => {
  test('rejects hard-linked artifacts for existence, read, delete, and tree deletion', () => {
    const root = createVaultRoot();
    const runId = '22222222-2222-4222-8222-222222222222';
    const stored = storeExternalCapabilityArtifact(root, {
      runId,
      artifactId: 'artifact_original',
      bytes: Buffer.from('private'),
    });
    const runDirectory = path.join(root, 'runs', runId);
    const linkedArtifact = path.join(runDirectory, 'artifact_link');
    fs.linkSync(path.join(runDirectory, 'artifact_original'), linkedArtifact);

    expect(() =>
      externalCapabilityArtifactExists(root, runId, 'artifact_original'),
    ).toThrow(/hard linked/);
    expect(() => readExternalCapabilityArtifact(root, stored)).toThrow(
      /hard linked/,
    );
    expect(() =>
      deleteExternalCapabilityArtifact(root, stored.storageRef),
    ).toThrow(/hard linked/);
    expect(() => deleteExternalCapabilityRunArtifacts(root, runId)).toThrow(
      /multiply linked/,
    );
    expect(() => inventoryExternalCapabilityVault(root, vaultId)).toThrow(
      /multiply linked/,
    );

    fs.unlinkSync(linkedArtifact);
    deleteExternalCapabilityRunArtifacts(root, runId);
  });

  test('rejects hard-linked files before runtime tree deletion', () => {
    const root = createVaultRoot();
    const runId = '33333333-3333-4333-8333-333333333333';
    const runtimeName = `${runId}-ABC123`;
    const runtimeDirectory = path.join(root, 'runtime', runtimeName);
    fs.mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
    const runtimeFile = path.join(runtimeDirectory, 'result.json');
    const runtimeLink = path.join(runtimeDirectory, 'result-link.json');
    fs.writeFileSync(runtimeFile, '{}', { mode: 0o600 });
    fs.linkSync(runtimeFile, runtimeLink);

    expect(() =>
      deleteExternalCapabilityRuntimeDirectory(root, runtimeName),
    ).toThrow(/multiply linked/);
    expect(fs.existsSync(runtimeDirectory)).toBe(true);

    fs.unlinkSync(runtimeLink);
    deleteExternalCapabilityRuntimeDirectory(root, runtimeName);
  });
});
