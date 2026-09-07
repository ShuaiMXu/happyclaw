import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DATABASE_MAINTENANCE_TOKEN_ENV =
  'HAPPYCLAW_DATABASE_MAINTENANCE_TOKEN';
export const DATABASE_MAINTENANCE_LOCK_FILENAME =
  '.happyclaw-database-maintenance.lock';

interface DatabaseMaintenanceLock {
  pid: number;
  token: string;
  createdAt: string;
}

function maintenanceLockPath(databasePath: string): string {
  return path.join(
    path.dirname(databasePath),
    DATABASE_MAINTENANCE_LOCK_FILENAME,
  );
}

function readMaintenanceLock(lockPath: string): DatabaseMaintenanceLock {
  const parsed = JSON.parse(
    fs.readFileSync(lockPath, 'utf8'),
  ) as Partial<DatabaseMaintenanceLock>;
  if (
    !Number.isInteger(parsed.pid) ||
    Number(parsed.pid) <= 0 ||
    typeof parsed.token !== 'string' ||
    parsed.token.length < 32 ||
    typeof parsed.createdAt !== 'string'
  ) {
    throw new Error(`Invalid database maintenance lock: ${lockPath}`);
  }
  return parsed as DatabaseMaintenanceLock;
}

/**
 * Runtime bootstrap calls this before opening SQLite. A repair guard therefore
 * fences supervisor restarts as well as ordinary concurrent starts.
 */
export function assertDatabaseMaintenanceAccess(databasePath: string): void {
  const lockPath = maintenanceLockPath(databasePath);
  if (!fs.existsSync(lockPath)) return;

  let lock: DatabaseMaintenanceLock;
  try {
    lock = readMaintenanceLock(lockPath);
  } catch (error) {
    throw new Error(
      `Database maintenance lock is unreadable at ${lockPath}; refuse to start until an operator verifies no repair is running and removes it`,
      { cause: error },
    );
  }
  if (process.env[DATABASE_MAINTENANCE_TOKEN_ENV] === lock.token) return;
  throw new Error(
    `Database maintenance is active (pid ${lock.pid}); refuse to start HappyClaw until it finishes`,
  );
}

/** Acquire a fail-closed guard. Stale locks are never reclaimed automatically. */
export function acquireDatabaseMaintenanceGuard(databasePath: string): {
  lockPath: string;
  token: string;
} {
  const lockPath = maintenanceLockPath(databasePath);
  const token = crypto.randomBytes(32).toString('hex');
  const lock: DatabaseMaintenanceLock = {
    pid: process.pid,
    token,
    createdAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(lockPath, `${JSON.stringify(lock)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(
      `Database maintenance lock already exists at ${lockPath}; verify no repair is running before removing a stale lock manually`,
    );
  }
  return { lockPath, token };
}

export function releaseDatabaseMaintenanceGuard(
  lockPath: string,
  token: string,
): void {
  let lock: DatabaseMaintenanceLock;
  try {
    lock = readMaintenanceLock(lockPath);
  } catch {
    return;
  }
  if (lock.token === token && lock.pid === process.pid) {
    fs.rmSync(lockPath, { force: true });
  }
}
