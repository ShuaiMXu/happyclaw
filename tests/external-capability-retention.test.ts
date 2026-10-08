import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'external-retention-'));
const storeDir = path.join(root, 'store');
const dataDir = path.join(root, 'data');
const vaultRoot = path.join(root, 'vault');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { runExternalCapabilityRetention } =
  await import('../src/external-capability-retention.js');
const { storeExternalCapabilityArtifact } =
  await import('../src/external-capability-storage.js');

let defaultKeyId = '';
beforeAll(() => {
  db.initDatabase();
  db.setExternalCapabilityStatus('quote-document-process', 'active');
  defaultKeyId = db.createExternalCapabilityKey({
    capabilitySlug: 'quote-document-process',
    label: 'retention default',
  }).key.id;
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

let sequence = 0;
function createRun(availableAt?: string) {
  sequence += 1;
  return db.createExternalCapabilityRun({
    capabilitySlug: 'quote-document-process',
    keyId: defaultKeyId,
    externalTaskId: `retention-task-${sequence}`,
    idempotencyKey: `retention-key-${sequence}`,
    inputManifest: { version: 1 },
    availableAt,
  }).run;
}

function createArtifact(runId: string): void {
  storeExternalCapabilityArtifact(vaultRoot, {
    runId,
    artifactId: `artifact-${sequence}`,
    bytes: Buffer.from('private'),
  });
}

function createRuntime(runId: string): string {
  const runtimeName = `${runId}-A${String(sequence).padStart(5, '0')}`;
  fs.mkdirSync(path.join(vaultRoot, 'runtime', runtimeName), {
    recursive: true,
    mode: 0o700,
  });
  return runtimeName;
}

function completeRun(status: 'succeeded' | 'failed' | 'cancelled') {
  const run = createRun();
  createArtifact(run.id);
  const runtimeName = createRuntime(run.id);
  const claim = db.claimNextExternalCapabilityRun('retention-test', 60_000)!;
  expect(claim.id).toBe(run.id);
  const settled =
    status === 'succeeded'
      ? db.completeExternalCapabilityRun(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          { status, result: { format: 'xlsx' } },
        )
      : db.completeExternalCapabilityRun(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          status === 'failed'
            ? {
                status,
                error: { code: 'TEST_FAILURE', message: 'safe failure' },
              }
            : { status },
        );
  expect(settled).toBe(true);
  return { run, runtimeName };
}

const FUTURE_NOW = new Date(Date.now() + 48 * 60 * 60_000);
const RETENTION_MS = 24 * 60 * 60_000;

describe('external capability retention', () => {
  test('deletes terminal rows and their durable and runtime data', () => {
    const completed = [
      completeRun('succeeded'),
      completeRun('failed'),
      completeRun('cancelled'),
    ];

    const result = runExternalCapabilityRetention({
      now: FUTURE_NOW,
      retentionMs: RETENTION_MS,
      vaultRoot,
    });

    expect(result).toMatchObject({ deletedRuns: 3, errors: 0 });
    for (const { run, runtimeName } of completed) {
      expect(db.getExternalCapabilityRunById(run.id)).toBeUndefined();
      expect(fs.existsSync(path.join(vaultRoot, 'runs', run.id))).toBe(false);
      expect(fs.existsSync(path.join(vaultRoot, 'runtime', runtimeName))).toBe(
        false,
      );
    }
  });

  test('never deletes queued, running, or retry-wait runs even past the cutoff', () => {
    const running = createRun();
    createArtifact(running.id);
    const runningRuntime = createRuntime(running.id);
    const runningClaim = db.claimNextExternalCapabilityRun(
      'retention-running',
      60_000,
    )!;
    expect(runningClaim.id).toBe(running.id);

    const retry = createRun();
    createArtifact(retry.id);
    const retryRuntime = createRuntime(retry.id);
    const retryClaim = db.claimNextExternalCapabilityRun(
      'retention-retry',
      60_000,
    )!;
    expect(retryClaim.id).toBe(retry.id);
    expect(
      db.releaseExternalCapabilityRunForRetry(
        retryClaim.id,
        retryClaim.lease_owner,
        retryClaim.lease_token,
        new Date(Date.now() + 60_000).toISOString(),
        { code: 'RETRY', message: 'retry later' },
      ),
    ).toBe(true);

    const queued = createRun(new Date(Date.now() + 60_000).toISOString());
    createArtifact(queued.id);
    const queuedRuntime = createRuntime(queued.id);

    const result = runExternalCapabilityRetention({
      now: FUTURE_NOW,
      retentionMs: RETENTION_MS,
      vaultRoot,
    });

    expect(result.deletedRuns).toBe(0);
    for (const [run, runtimeName] of [
      [running, runningRuntime],
      [retry, retryRuntime],
      [queued, queuedRuntime],
    ] as const) {
      expect(db.getExternalCapabilityRunById(run.id)).toBeDefined();
      expect(fs.existsSync(path.join(vaultRoot, 'runs', run.id))).toBe(true);
      expect(fs.existsSync(path.join(vaultRoot, 'runtime', runtimeName))).toBe(
        true,
      );
      expect(
        db.deleteExternalCapabilityRunForRetention(
          run.id,
          FUTURE_NOW.toISOString(),
        ),
      ).toBe(false);
    }
  });

  test('removes only old strictly named orphan directories and is idempotent', () => {
    const oldRunId = crypto.randomUUID();
    createArtifact(oldRunId);
    const oldRuntime = createRuntime(oldRunId);
    const old = new Date(Date.now() - 48 * 60 * 60_000);
    fs.utimesSync(path.join(vaultRoot, 'runs', oldRunId), old, old);
    fs.utimesSync(path.join(vaultRoot, 'runtime', oldRuntime), old, old);

    const freshRunId = crypto.randomUUID();
    createArtifact(freshRunId);
    const unknown = path.join(vaultRoot, 'runtime', 'unknown');
    fs.mkdirSync(unknown, { recursive: true });

    const first = runExternalCapabilityRetention({
      now: new Date(),
      retentionMs: RETENTION_MS,
      vaultRoot,
    });
    expect(first).toMatchObject({
      deletedOrphanRunDirectories: 1,
      deletedRuntimeDirectories: 1,
      errors: 0,
    });
    expect(fs.existsSync(path.join(vaultRoot, 'runs', oldRunId))).toBe(false);
    expect(fs.existsSync(path.join(vaultRoot, 'runtime', oldRuntime))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(vaultRoot, 'runs', freshRunId))).toBe(true);
    expect(fs.existsSync(unknown)).toBe(true);

    expect(
      runExternalCapabilityRetention({
        now: new Date(),
        retentionMs: RETENTION_MS,
        vaultRoot,
      }),
    ).toMatchObject({
      deletedRuns: 0,
      deletedOrphanRunDirectories: 0,
      deletedRuntimeDirectories: 0,
      errors: 0,
    });
  });
});
