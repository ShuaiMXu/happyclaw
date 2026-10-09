import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'external-storage-ledger-'));
const storeDir = path.join(root, 'store');
const dataDir = path.join(root, 'data');
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
const capacity = await import('../src/external-capability-storage-capacity.js');
const storage = await import('../src/external-capability-storage.js');
const storageBackfill =
  await import('../src/external-capability-storage-backfill.js');
const vaultLock = await import('../src/external-capability-vault-lock.js');

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

let sequence = 0;
function reserve(
  bytes: number,
  overrides: Partial<db.ReserveExternalCapabilityStorageInput> = {},
) {
  sequence += 1;
  const suffix = String(sequence);
  return db.reserveExternalCapabilityStorage({
    reservationKey: `reservation-${suffix}`,
    runId: `run-${suffix}`,
    kind: 'input',
    objectKey: `object-${suffix}`,
    reservedBytes: bytes,
    filesystemAvailableBytes: 10_000,
    filesystemSafetyReserveBytes: 100,
    logicalLimitBytes: 10_000,
    ...overrides,
  });
}

interface ReservationChildResult {
  pid: number;
  result: db.ReserveExternalCapabilityStorageResult | null;
}

async function waitForPath(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function runReservationChild(
  workingDirectory: string,
  reservationKey: string | null,
  options: { callback?: boolean; settle?: boolean } = {},
): Promise<ReservationChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(projectRoot, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        'tests/external-capability-storage-reservation-child.test.ts',
        '--maxWorkers=1',
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          EXTERNAL_STORAGE_RESERVATION_CHILD: '1',
          EXTERNAL_STORAGE_RESERVATION_CHILD_ROOT: workingDirectory,
          EXTERNAL_STORAGE_RESERVATION_CHILD_KEY: reservationKey ?? '',
          EXTERNAL_STORAGE_RESERVATION_CHILD_CALLBACK: options.callback
            ? '1'
            : '0',
          EXTERNAL_STORAGE_RESERVATION_CHILD_SETTLE: options.settle ? '1' : '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Reservation child exited with ${String(code)}: ${stderr.trim()} stdout=${stdout.trim()}`,
          ),
        );
        return;
      }
      const result = reservationKey
        ? (JSON.parse(
            fs.readFileSync(
              path.join(workingDirectory, `${reservationKey}.json`),
              'utf8',
            ),
          ) as db.ReserveExternalCapabilityStorageResult)
        : null;
      resolve({ pid: child.pid!, result });
    });
  });
}

describe('external capability Vault reservations', () => {
  test('reserves atomically and settles to exact occupied bytes', () => {
    const first = reserve(60, {
      reservationKey: 'settle-first',
      runId: 'settle-run-first',
      objectKey: 'settle-object-first',
      logicalLimitBytes: 100,
    });
    expect(first).toMatchObject({ admitted: true, existing: false });
    expect(db.getExternalCapabilityStorageUsageForTest()).toMatchObject({
      logicalBytes: expect.any(Number),
      pendingBytes: expect.any(Number),
    });
    expect(db.settleExternalCapabilityStorage('settle-first', 40)).toBe(true);
    expect(db.settleExternalCapabilityStorage('settle-first', 40)).toBe(true);
    expect(db.settleExternalCapabilityStorage('settle-first', 41)).toBe(false);

    const second = reserve(60, {
      reservationKey: 'settle-second',
      runId: 'settle-run-second',
      objectKey: 'settle-object-second',
      logicalLimitBytes:
        db.getExternalCapabilityStorageUsageForTest().logicalBytes + 60,
    });
    expect(second.admitted).toBe(true);
    expect(db.settleExternalCapabilityStorage('settle-second', 60)).toBe(true);
  });

  test('subtracts pending reservations from the same filesystem snapshot', () => {
    const first = reserve(60, {
      reservationKey: 'physical-first',
      runId: 'physical-run-first',
      objectKey: 'physical-object-first',
      filesystemAvailableBytes: 100,
      filesystemSafetyReserveBytes: 20,
      logicalLimitBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(first.admitted).toBe(true);

    const second = reserve(30, {
      reservationKey: 'physical-second',
      runId: 'physical-run-second',
      objectKey: 'physical-object-second',
      filesystemAvailableBytes: 100,
      filesystemSafetyReserveBytes: 20,
      logicalLimitBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(second).toEqual({
      admitted: false,
      reason: 'filesystem_capacity',
    });
  });

  test('subtracts only unmaterialized reservation headroom from free space', () => {
    const existingPending =
      db.getExternalCapabilityStorageUsageForTest().pendingBytes;
    const first = reserve(60, {
      reservationKey: 'materialized-first',
      runId: 'materialized-run-first',
      objectKey: 'materialized-object-first',
      filesystemAvailableBytes: existingPending + 100,
      filesystemSafetyReserveBytes: 20,
      logicalLimitBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(first.admitted).toBe(true);
    expect(
      db.recordExternalCapabilityStorageMaterializedBytes(
        'materialized-first',
        50,
      ),
    ).toBe(true);
    expect(
      db.getExternalCapabilityStorageReservationForTest('materialized-first'),
    ).toMatchObject({ state: 'reserved', occupied_bytes: 50 });

    const second = reserve(60, {
      reservationKey: 'materialized-second',
      runId: 'materialized-run-second',
      objectKey: 'materialized-object-second',
      filesystemAvailableBytes: existingPending + 100,
      filesystemSafetyReserveBytes: 20,
      logicalLimitBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(second.admitted).toBe(true);
    expect(db.settleExternalCapabilityStorage('materialized-first', 50)).toBe(
      true,
    );
  });

  test('rejects materialization beyond the reservation and non-monotonic settlement', () => {
    expect(
      reserve(20, {
        reservationKey: 'materialized-bounds',
        runId: 'materialized-bounds-run',
        objectKey: 'materialized-bounds-object',
      }).admitted,
    ).toBe(true);
    expect(
      db.recordExternalCapabilityStorageMaterializedBytes(
        'materialized-bounds',
        21,
      ),
    ).toBe(false);
    expect(
      db.recordExternalCapabilityStorageMaterializedBytes(
        'materialized-bounds',
        15,
      ),
    ).toBe(true);
    expect(db.settleExternalCapabilityStorage('materialized-bounds', 14)).toBe(
      false,
    );
  });

  test('commits storage admission under FULL synchronous durability and restores NORMAL', () => {
    const before = db.getExternalCapabilityDatabaseSynchronousModeForTest();
    let during = -1;
    const result = reserve(1, {
      reservationKey: 'full-synchronous-reservation',
      runId: 'full-synchronous-run',
      objectKey: 'full-synchronous-object',
      filesystemAvailableBytes: () => {
        during = db.getExternalCapabilityDatabaseSynchronousModeForTest();
        return 10_000;
      },
    });

    expect(result.admitted).toBe(true);
    expect(during).toBe(2);
    expect(db.getExternalCapabilityDatabaseSynchronousModeForTest()).toBe(
      before,
    );
  });

  test('serializes same-filesystem admission across independent processes', async () => {
    const raceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'external-storage-process-race-'),
    );

    try {
      await runReservationChild(raceRoot, null);
      const first = runReservationChild(raceRoot, 'process-a');
      await waitForPath(path.join(raceRoot, 'process-a.ready'));
      const second = runReservationChild(raceRoot, 'process-b');
      await waitForPath(path.join(raceRoot, 'process-b.ready'));
      fs.writeFileSync(path.join(raceRoot, 'process-a.go'), '');
      fs.writeFileSync(path.join(raceRoot, 'process-b.go'), '');
      const results = await Promise.all([first, second]);

      expect(new Set(results.map((entry) => entry.pid)).size).toBe(2);
      expect(results.map((entry) => entry.result)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ admitted: true, existing: false }),
          { admitted: false, reason: 'filesystem_capacity' },
        ]),
      );
    } finally {
      fs.rmSync(raceRoot, { recursive: true, force: true });
    }
  }, 20_000);

  test('samples filesystem capacity only after acquiring the cross-process writer fence', async () => {
    const raceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'external-storage-statfs-race-'),
    );

    try {
      await runReservationChild(raceRoot, null);
      fs.writeFileSync(path.join(raceRoot, 'available-bytes'), '100');

      const winner = runReservationChild(raceRoot, 'materializer', {
        callback: true,
        settle: true,
      });
      await waitForPath(path.join(raceRoot, 'materializer.ready'));
      const contender = runReservationChild(raceRoot, 'contender', {
        callback: true,
      });
      await waitForPath(path.join(raceRoot, 'contender.ready'));
      fs.writeFileSync(path.join(raceRoot, 'materializer.go'), '');
      await waitForPath(path.join(raceRoot, 'materializer.sampling'));

      fs.writeFileSync(path.join(raceRoot, 'contender.go'), '');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fs.existsSync(path.join(raceRoot, 'contender.sampling'))).toBe(
        false,
      );

      fs.writeFileSync(path.join(raceRoot, 'materializer.sample-go'), '');
      await waitForPath(path.join(raceRoot, 'contender.sampling'));
      fs.writeFileSync(path.join(raceRoot, 'contender.sample-go'), '');

      const [winnerResult, contenderResult] = await Promise.all([
        winner,
        contender,
      ]);
      expect(winnerResult.result).toMatchObject({
        admitted: true,
        existing: false,
      });
      expect(contenderResult.result).toEqual({
        admitted: false,
        reason: 'filesystem_capacity',
      });
    } finally {
      fs.rmSync(raceRoot, { recursive: true, force: true });
    }
  }, 25_000);

  test('replays only the exact live reservation and rejects object aliasing', () => {
    const input: db.ReserveExternalCapabilityStorageInput = {
      reservationKey: 'idempotent-reservation',
      runId: 'idempotent-run',
      kind: 'runtime',
      objectKey: 'idempotent-object',
      reservedBytes: 25,
      filesystemAvailableBytes: 10_000,
      filesystemSafetyReserveBytes: 0,
      logicalLimitBytes: Number.MAX_SAFE_INTEGER,
    };
    expect(db.reserveExternalCapabilityStorage(input)).toMatchObject({
      admitted: true,
      existing: false,
    });
    expect(db.reserveExternalCapabilityStorage(input)).toMatchObject({
      admitted: true,
      existing: true,
    });
    expect(
      db.reserveExternalCapabilityStorage({ ...input, reservedBytes: 26 }),
    ).toEqual({ admitted: false, reason: 'conflict' });
    expect(
      db.reserveExternalCapabilityStorage({
        ...input,
        reservationKey: 'different-key-same-object',
      }),
    ).toEqual({ admitted: false, reason: 'conflict' });
  });

  test('keeps quarantined bytes charged until physical deletion is released', () => {
    const admitted = reserve(33, {
      reservationKey: 'quarantine-reservation',
      runId: 'quarantine-run',
      objectKey: 'quarantine-object',
    });
    expect(admitted.admitted).toBe(true);
    expect(
      db.quarantineExternalCapabilityStorage('quarantine-reservation'),
    ).toBe(true);
    expect(
      db.getExternalCapabilityStorageReservationForTest(
        'quarantine-reservation',
      ),
    ).toMatchObject({ state: 'quarantined' });
    expect(db.releaseExternalCapabilityStorage('quarantine-reservation')).toBe(
      true,
    );
    expect(db.releaseExternalCapabilityStorage('quarantine-reservation')).toBe(
      true,
    );
    expect(
      db.getExternalCapabilityStorageReservationForTest(
        'quarantine-reservation',
      ),
    ).toMatchObject({ state: 'released', released_at: expect.any(String) });
  });

  test('releases every run charge exactly once after filesystem cleanup', () => {
    for (const [kind, objectKey] of [
      ['input', 'all-input'],
      ['runtime', 'all-runtime'],
      ['output', 'all-output'],
    ] as const) {
      const result = reserve(10, {
        reservationKey: `release-all-${kind}`,
        runId: 'release-all-run',
        kind,
        objectKey,
      });
      expect(result.admitted).toBe(true);
    }
    expect(db.releaseExternalCapabilityStorageForRun('release-all-run')).toBe(
      3,
    );
    expect(db.releaseExternalCapabilityStorageForRun('release-all-run')).toBe(
      0,
    );
  });

  test('artifact-only cleanup never releases runtime capacity', () => {
    for (const [kind, objectKey] of [
      ['input', 'artifact-input'],
      ['runtime', 'artifact-runtime'],
      ['output', 'artifact-output'],
    ] as const) {
      expect(
        reserve(10, {
          reservationKey: `release-artifacts-${kind}`,
          runId: 'release-artifacts-run',
          kind,
          objectKey,
        }).admitted,
      ).toBe(true);
    }

    expect(
      db.releaseExternalCapabilityStorageForRunArtifacts(
        'release-artifacts-run',
      ),
    ).toBe(2);
    expect(
      db.getExternalCapabilityStorageReservationForTest(
        'release-artifacts-runtime',
      ),
    ).toMatchObject({ state: 'reserved' });
  });

  test('purges only grace-expired released rows for missing runs', () => {
    const released = reserve(7, {
      reservationKey: 'gc-released',
      runId: 'gc-missing-run',
      objectKey: 'gc-released-object',
    });
    const live = reserve(7, {
      reservationKey: 'gc-live',
      runId: 'gc-live-run',
      objectKey: 'gc-live-object',
    });
    expect(released.admitted).toBe(true);
    expect(live.admitted).toBe(true);
    expect(db.releaseExternalCapabilityStorage('gc-released')).toBe(true);
    const releasedAt =
      db.getExternalCapabilityStorageReservationForTest(
        'gc-released',
      )!.released_at!;

    expect(
      db.purgeReleasedExternalCapabilityStorageReservations(releasedAt),
    ).toBeGreaterThanOrEqual(1);
    expect(
      db.getExternalCapabilityStorageReservationForTest('gc-released'),
    ).toBeUndefined();
    expect(
      db.getExternalCapabilityStorageReservationForTest('gc-live'),
    ).toMatchObject({ state: 'reserved' });
    expect(db.releaseExternalCapabilityStorage('gc-released')).toBe(true);
    expect(db.settleExternalCapabilityStorage('gc-released', 7)).toBe(false);
    expect(() =>
      db.purgeReleasedExternalCapabilityStorageReservations('not-a-date'),
    ).toThrow('Invalid external capability storage purge time');
  });

  test('bounds released-reservation garbage collection batches', () => {
    const cutoff = new Date(Date.now() + 60_000).toISOString();
    while (
      db.purgeReleasedExternalCapabilityStorageReservations(cutoff, 1_000) > 0
    ) {
      // Start from an empty eligible set so ordering from prior tests cannot
      // affect which rows the bounded batch selects.
    }

    const keys = ['gc-batch-1', 'gc-batch-2', 'gc-batch-3'];
    for (const key of keys) {
      expect(
        reserve(1, {
          reservationKey: key,
          runId: `${key}-missing-run`,
          objectKey: `${key}-object`,
        }).admitted,
      ).toBe(true);
      expect(db.releaseExternalCapabilityStorage(key)).toBe(true);
    }

    expect(
      db.purgeReleasedExternalCapabilityStorageReservations(cutoff, 2),
    ).toBe(2);
    expect(
      keys.filter((key) =>
        db.getExternalCapabilityStorageReservationForTest(key),
      ),
    ).toHaveLength(1);
  });

  test('backfills legacy occupancy atomically without double-charging existing rows', () => {
    const runId = 'backfill-ledger-run';
    const existing = reserve(6, {
      reservationKey: 'backfill-existing-input',
      runId,
      kind: 'input',
      objectKey: 'run-artifacts',
    });
    expect(existing.admitted).toBe(true);
    expect(
      db.settleExternalCapabilityStorage('backfill-existing-input', 6),
    ).toBe(true);
    const runtimeObject = '123e4567-e89b-42d3-a456-426614174000-a1-l1-ABC123';
    const legacyObject = 'legacy-run-artifacts';
    const before = db.getExternalCapabilityStorageUsageForTest();

    expect(
      db.backfillExternalCapabilityStorageOccupancy({
        markerKey: 'test-storage-backfill-marker',
        markerValue: 'v1:test-root',
        occupancies: [
          {
            runId,
            kind: 'input',
            objectKey: legacyObject,
            occupiedBytes: 10,
          },
          {
            runId,
            kind: 'runtime',
            objectKey: runtimeObject,
            occupiedBytes: 5,
          },
        ],
      }),
    ).toEqual({
      alreadyComplete: false,
      insertedRows: 2,
      expandedRows: 0,
      importedBytes: 15,
    });
    expect(
      db.getExternalCapabilityStorageReservationForTest(
        capacity.externalCapabilityStorageReservationKey({
          runId,
          kind: 'input',
          objectKey: legacyObject,
        }),
      ),
    ).toMatchObject({ state: 'occupied', occupied_bytes: 10 });
    expect(
      db.getExternalCapabilityStorageReservationForTest(
        capacity.externalCapabilityStorageReservationKey({
          runId,
          kind: 'runtime',
          objectKey: runtimeObject,
        }),
      ),
    ).toMatchObject({ state: 'occupied', occupied_bytes: 5 });
    expect(db.getExternalCapabilityStorageUsageForTest()).toEqual({
      logicalBytes: before.logicalBytes + 15,
      pendingBytes: before.pendingBytes,
    });

    expect(
      db.backfillExternalCapabilityStorageOccupancy({
        markerKey: 'test-storage-backfill-marker',
        markerValue: 'v1:test-root',
        occupancies: [],
      }),
    ).toEqual({
      alreadyComplete: true,
      insertedRows: 0,
      expandedRows: 0,
      importedBytes: 0,
    });
  });

  test('repairs a configured legacy Vault before intake publication', () => {
    expect(
      storageBackfill.backfillConfiguredExternalCapabilityVaultOccupancy(
        'blocked:no-config',
        {},
      ),
    ).toBeNull();
    const vaultRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'external-storage-backfill-vault-'),
    );
    const runId = '223e4567-e89b-42d3-a456-426614174000';
    const vaultId = 'vault-storage-backfill-test';
    try {
      fs.chmodSync(vaultRoot, 0o700);
      fs.writeFileSync(
        path.join(vaultRoot, storage.EXTERNAL_CAPABILITY_VAULT_ID_SENTINEL),
        vaultId,
        { mode: 0o600 },
      );
      storage.storeExternalCapabilityArtifact(vaultRoot, {
        runId,
        artifactId: 'source_1',
        bytes: Buffer.from('abc'),
      });
      const env = {
        EXTERNAL_CAPABILITY_VAULT_DIR: vaultRoot,
        EXTERNAL_CAPABILITY_VAULT_ID: vaultId,
      };
      db.setRouterState(
        storageBackfill.EXTERNAL_CAPABILITY_STORAGE_BACKFILL_MARKER,
        'v1:legacy-path-marker',
      );
      expect(storageBackfill.isExternalCapabilityVaultCensusReady(env)).toBe(
        false,
      );
      const firstCensus =
        storageBackfill.beginConfiguredExternalCapabilityVaultCensus(env);
      expect(firstCensus).not.toBeNull();
      try {
        expect(
          storageBackfill.backfillConfiguredExternalCapabilityVaultOccupancy(
            firstCensus!.blockedValue,
            env,
          ),
        ).toMatchObject({
          alreadyComplete: false,
          insertedRows: 1,
          importedBytes: 3,
        });
      } finally {
        firstCensus?.release();
      }
      expect(
        db.getExternalCapabilityStorageReservationForTest(
          capacity.externalCapabilityStorageReservationKey({
            runId,
            kind: 'input',
            objectKey: storage.EXTERNAL_CAPABILITY_LEGACY_RUN_OBJECT_KEY,
          }),
        ),
      ).toMatchObject({ state: 'occupied', occupied_bytes: 3 });
      expect(storageBackfill.isExternalCapabilityVaultCensusReady(env)).toBe(
        true,
      );

      const producerLock =
        vaultLock.acquireExternalCapabilityVaultSharedLock(env);
      expect(producerLock).not.toBeNull();
      try {
        expect(() =>
          storageBackfill.beginConfiguredExternalCapabilityVaultCensus(env),
        ).toThrow(/blocked by active producers/);
      } finally {
        producerLock?.release();
      }
      expect(storageBackfill.isExternalCapabilityVaultCensusReady(env)).toBe(
        true,
      );

      const secondCensus =
        storageBackfill.beginConfiguredExternalCapabilityVaultCensus(env);
      expect(secondCensus).not.toBeNull();
      try {
        expect(storageBackfill.isExternalCapabilityVaultCensusReady(env)).toBe(
          false,
        );
        expect(
          storageBackfill.backfillConfiguredExternalCapabilityVaultOccupancy(
            secondCensus!.blockedValue,
            env,
          ),
        ).toMatchObject({ alreadyComplete: false, importedBytes: 0 });
      } finally {
        secondCensus?.release();
      }

      const thirdCensus =
        storageBackfill.beginConfiguredExternalCapabilityVaultCensus(env);
      expect(thirdCensus).not.toBeNull();
      try {
        expect(
          storageBackfill.backfillConfiguredExternalCapabilityVaultOccupancy(
            thirdCensus!.blockedValue,
            env,
          ),
        ).toMatchObject({ alreadyComplete: false, importedBytes: 0 });
      } finally {
        thirdCensus?.release();
      }
    } finally {
      fs.rmSync(vaultRoot, { recursive: true, force: true });
    }
  });

  test('attributes exact artifact reservations and repairs materialized bytes without consuming headroom twice', () => {
    const runId = 'backfill-exact-artifact-run';
    const artifactId = 'result-artifact';
    const reservationKey = capacity.externalCapabilityStorageReservationKey({
      runId,
      kind: 'output',
      objectKey: artifactId,
    });
    expect(
      reserve(100, {
        reservationKey,
        runId,
        kind: 'output',
        objectKey: artifactId,
      }).admitted,
    ).toBe(true);
    const before = db.getExternalCapabilityStorageUsageForTest();

    expect(
      db.backfillExternalCapabilityStorageOccupancy({
        markerKey: 'test-storage-object-attribution-marker',
        markerValue: 'v2:test-root',
        occupancies: [
          {
            runId,
            kind: 'artifact',
            objectKey: artifactId,
            occupiedBytes: 40,
          },
        ],
      }),
    ).toEqual({
      alreadyComplete: false,
      insertedRows: 0,
      expandedRows: 1,
      importedBytes: 0,
    });
    expect(
      db.getExternalCapabilityStorageReservationForTest(reservationKey),
    ).toMatchObject({
      state: 'reserved',
      reserved_bytes: 100,
      occupied_bytes: 40,
    });
    expect(db.getExternalCapabilityStorageUsageForTest()).toEqual({
      logicalBytes: before.logicalBytes,
      pendingBytes: before.pendingBytes - 40,
    });
    expect(
      db.getExternalCapabilityStorageReservationForTest(
        capacity.externalCapabilityStorageReservationKey({
          runId,
          kind: 'input',
          objectKey: storage.EXTERNAL_CAPABILITY_LEGACY_RUN_OBJECT_KEY,
        }),
      ),
    ).toBeUndefined();
  });

  test('attributes pre-publication artifacts to an aggregate intake reservation', () => {
    const runId = 'backfill-prepublication-input-run';
    const reservationKey = capacity.externalCapabilityStorageReservationKey({
      runId,
      kind: 'input',
      objectKey: 'run-artifacts',
    });
    expect(
      reserve(100, {
        reservationKey,
        runId,
        kind: 'input',
        objectKey: 'run-artifacts',
      }).admitted,
    ).toBe(true);
    const before = db.getExternalCapabilityStorageUsageForTest();

    expect(
      db.backfillExternalCapabilityStorageOccupancy({
        markerKey: 'test-storage-prepublication-attribution-marker',
        markerValue: 'v2:test-prepublication-root',
        occupancies: [
          {
            runId,
            kind: 'artifact',
            objectKey: 'source-before-run',
            occupiedBytes: 40,
          },
        ],
      }),
    ).toEqual({
      alreadyComplete: false,
      insertedRows: 0,
      expandedRows: 1,
      importedBytes: 0,
    });
    expect(
      db.getExternalCapabilityStorageReservationForTest(reservationKey),
    ).toMatchObject({
      state: 'reserved',
      reserved_bytes: 100,
      occupied_bytes: 40,
    });
    expect(db.getExternalCapabilityStorageUsageForTest()).toEqual({
      logicalBytes: before.logicalBytes,
      pendingBytes: before.pendingBytes - 40,
    });
    expect(
      db.getExternalCapabilityStorageReservationForTest(
        capacity.externalCapabilityStorageReservationKey({
          runId,
          kind: 'input',
          objectKey: storage.EXTERNAL_CAPABILITY_LEGACY_RUN_OBJECT_KEY,
        }),
      ),
    ).toBeUndefined();
  });

  test('fails storage backfill on released materialized identities', () => {
    const runId = 'backfill-released-run';
    const objectKey = 'legacy-run-artifacts';
    const reservationKey = capacity.externalCapabilityStorageReservationKey({
      runId,
      kind: 'input',
      objectKey,
    });
    expect(
      reserve(1, {
        reservationKey,
        runId,
        kind: 'input',
        objectKey,
      }).admitted,
    ).toBe(true);
    expect(db.releaseExternalCapabilityStorage(reservationKey)).toBe(true);

    expect(() =>
      db.backfillExternalCapabilityStorageOccupancy({
        markerKey: 'test-storage-backfill-conflict-marker',
        markerValue: 'v1:test-root',
        occupancies: [{ runId, kind: 'input', objectKey, occupiedBytes: 1 }],
      }),
    ).toThrow('released materialized storage');
    expect(
      db.getRouterState('test-storage-backfill-conflict-marker'),
    ).toBeUndefined();
  });

  test('runs the activation write probe under durable capacity accounting', () => {
    const before = db.getExternalCapabilityStorageUsageForTest();

    capacity.probeExternalCapabilityVaultWithCapacity(root);

    expect(db.getExternalCapabilityStorageUsageForTest()).toEqual(before);
    expect(fs.readdirSync(path.join(root, 'runs'))).toEqual([]);
  });

  test('fails closed at the injected statfs safety boundary', () => {
    expect(() =>
      capacity.reserveExternalCapabilityStorageCapacity({
        runId: 'statfs-boundary-run',
        kind: 'input',
        objectKey: 'run-artifacts',
        byteCount: 2,
        vaultRoot: root,
        availableBytes: 10,
        config: {
          logicalLimitBytes: Number.MAX_SAFE_INTEGER,
          filesystemSafetyReserveBytes: 9,
        },
      }),
    ).toThrow(capacity.ExternalCapabilityStorageCapacityError);
  });

  test('rejects a ready marker after the configured Vault root is replaced', () => {
    db.deleteRouterState(db.EXTERNAL_CAPABILITY_VAULT_CENSUS_STATE_KEY);
    db.deleteRouterState(db.EXTERNAL_CAPABILITY_VAULT_PHYSICAL_IDENTITY_KEY);
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), 'external-storage-identity-replacement-'),
    );
    const vaultRoot = path.join(parent, 'vault');
    const replacedRoot = path.join(parent, 'vault-replaced');
    const vaultId = 'vault-identity-replacement-test';
    const env = {
      EXTERNAL_CAPABILITY_VAULT_DIR: vaultRoot,
      EXTERNAL_CAPABILITY_VAULT_ID: vaultId,
    };
    try {
      fs.mkdirSync(vaultRoot, { mode: 0o700 });
      fs.writeFileSync(
        path.join(vaultRoot, storage.EXTERNAL_CAPABILITY_VAULT_ID_SENTINEL),
        vaultId,
        { mode: 0o600 },
      );
      const census =
        storageBackfill.beginConfiguredExternalCapabilityVaultCensus(env);
      expect(census).not.toBeNull();
      try {
        storageBackfill.backfillConfiguredExternalCapabilityVaultOccupancy(
          census!.blockedValue,
          env,
        );
      } finally {
        census?.release();
      }
      expect(storageBackfill.isExternalCapabilityVaultCensusReady(env)).toBe(
        true,
      );

      fs.renameSync(vaultRoot, replacedRoot);
      fs.mkdirSync(vaultRoot, { mode: 0o700 });
      fs.writeFileSync(
        path.join(vaultRoot, storage.EXTERNAL_CAPABILITY_VAULT_ID_SENTINEL),
        vaultId,
        { mode: 0o600 },
      );
      expect(storageBackfill.isExternalCapabilityVaultCensusReady(env)).toBe(
        false,
      );
      expect(() =>
        storageBackfill.beginConfiguredExternalCapabilityVaultCensus(env),
      ).toThrow(/physical identity changed/);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test('restores the owner-fenced blocked marker after a published census fails', () => {
    db.deleteRouterState(db.EXTERNAL_CAPABILITY_VAULT_CENSUS_STATE_KEY);
    db.deleteRouterState(db.EXTERNAL_CAPABILITY_VAULT_PHYSICAL_IDENTITY_KEY);
    const blockedValue = 'blocked:11111111-1111-4111-8111-111111111111';
    const publishedValue = `v2:${'a'.repeat(64)}`;
    db.beginExternalCapabilityVaultCensus(blockedValue, publishedValue);
    expect(
      db.backfillExternalCapabilityStorageOccupancy({
        markerKey: db.EXTERNAL_CAPABILITY_VAULT_CENSUS_STATE_KEY,
        markerValue: publishedValue,
        occupancies: [],
        blockedValue,
      }),
    ).toMatchObject({ alreadyComplete: false });
    expect(
      db.getRouterState(db.EXTERNAL_CAPABILITY_VAULT_CENSUS_STATE_KEY),
    ).toBe(publishedValue);

    db.abortExternalCapabilityVaultCensus(publishedValue, blockedValue);
    expect(
      db.getRouterState(db.EXTERNAL_CAPABILITY_VAULT_CENSUS_STATE_KEY),
    ).toBe(blockedValue);

    db.beginExternalCapabilityVaultCensus(
      'blocked:22222222-2222-4222-8222-222222222222',
      publishedValue,
    );
    expect(() =>
      db.abortExternalCapabilityVaultCensus(null, blockedValue),
    ).toThrow(/ownership was lost/);
  });

  test('rejects unsafe byte counts and expansion beyond the reservation', () => {
    expect(() => reserve(-1)).toThrow('non-negative safe integer');
    expect(() => reserve(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      'non-negative safe integer',
    );
    const result = reserve(5, {
      reservationKey: 'bounded-settlement',
      runId: 'bounded-settlement-run',
      objectKey: 'bounded-settlement-object',
    });
    expect(result.admitted).toBe(true);
    expect(db.settleExternalCapabilityStorage('bounded-settlement', 6)).toBe(
      false,
    );
  });
});
