import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

const enabled = process.env.EXTERNAL_STORAGE_RESERVATION_CHILD === '1';
const childRoot = process.env.EXTERNAL_STORAGE_RESERVATION_CHILD_ROOT ?? '';
const reservationKey = process.env.EXTERNAL_STORAGE_RESERVATION_CHILD_KEY ?? '';
const callbackMode =
  process.env.EXTERNAL_STORAGE_RESERVATION_CHILD_CALLBACK === '1';
const settleAfterReservation =
  process.env.EXTERNAL_STORAGE_RESERVATION_CHILD_SETTLE === '1';

vi.mock('../src/config.js', () => ({
  DATA_DIR: path.join(childRoot, 'data'),
  STORE_DIR: path.join(childRoot, 'data', 'db'),
  GROUPS_DIR: path.join(childRoot, 'data', 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

test.skipIf(!enabled)(
  'reserves storage from an isolated process',
  async () => {
    expect(childRoot).not.toBe('');
    db.initDatabase();
    try {
      if (!reservationKey) return;

      fs.writeFileSync(path.join(childRoot, `${reservationKey}.ready`), '');
      const goPath = path.join(childRoot, `${reservationKey}.go`);
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(goPath)) {
        if (Date.now() >= deadline) {
          throw new Error('Timed out waiting for reservation race barrier');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const filesystemAvailableBytes = callbackMode
        ? () => {
            fs.writeFileSync(
              path.join(childRoot, `${reservationKey}.sampling`),
              '',
            );
            const sampleGoPath = path.join(
              childRoot,
              `${reservationKey}.sample-go`,
            );
            const waitDeadline = Date.now() + 10_000;
            const waitArray = new Int32Array(new SharedArrayBuffer(4));
            while (!fs.existsSync(sampleGoPath)) {
              if (Date.now() >= waitDeadline) {
                throw new Error('Timed out waiting to sample filesystem space');
              }
              Atomics.wait(waitArray, 0, 0, 5);
            }
            return Number(
              fs.readFileSync(path.join(childRoot, 'available-bytes'), 'utf8'),
            );
          }
        : 100;
      const result = db.reserveExternalCapabilityStorage({
        reservationKey,
        runId: `race-${reservationKey}`,
        kind: 'input',
        objectKey: `object-${reservationKey}`,
        reservedBytes: 60,
        filesystemAvailableBytes,
        filesystemSafetyReserveBytes: 20,
        logicalLimitBytes: Number.MAX_SAFE_INTEGER,
      });
      if (settleAfterReservation && result.admitted) {
        fs.writeFileSync(path.join(childRoot, 'available-bytes'), '40');
        expect(db.settleExternalCapabilityStorage(reservationKey, 60)).toBe(
          true,
        );
      }
      fs.writeFileSync(
        path.join(childRoot, `${reservationKey}.json`),
        JSON.stringify(result),
      );
    } finally {
      db.closeDatabase();
    }
  },
  15_000,
);
