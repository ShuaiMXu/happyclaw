/**
 * One-time diagnostic/repair for leftover JID-classifiable DMs still bound to
 * workspace main (`target_main_jid`). This is not a schema migration.
 *
 * Supported main never produced this state after #659+#655 landed together.
 * The tool exists for cherry-picked / interim installs, per the #663 close
 * reason: remounting without a new isolation generation can leave a
 * contaminated main session and post-marker rows recoverable.
 *
 * Usage:
 *   npx tsx scripts/repair-leftover-direct-mounts.ts
 *   npx tsx scripts/repair-leftover-direct-mounts.ts --apply
 *   make leftover-direct-mounts
 *   make leftover-direct-mounts APPLY=1
 */
import '../src/load-env.js';

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

import Database from 'better-sqlite3';

import {
  acquireDatabaseMaintenanceGuard,
  DATABASE_MAINTENANCE_TOKEN_ENV,
  releaseDatabaseMaintenanceGuard,
} from '../src/database-maintenance.js';
import {
  diagnoseLeftoverDirectMountsFromDatabase,
  type LeftoverDirectMountDiagnosis,
} from '../src/leftover-direct-mount-diagnostic.js';
import { CURRENT_SCHEMA_VERSION } from '../src/schema-version.js';

const DATABASE_PATH = path.join(process.cwd(), 'data', 'db', 'messages.db');
const execFileAsync = promisify(execFile);
type DatabaseModule = typeof import('../src/db.js');
type MaintenanceGuard = ReturnType<typeof acquireDatabaseMaintenanceGuard>;

let activeDatabaseModule: DatabaseModule | undefined;
let activeMaintenanceGuard: MaintenanceGuard | undefined;

function cleanupActiveMaintenance(): void {
  const errors: unknown[] = [];
  const database = activeDatabaseModule;
  activeDatabaseModule = undefined;
  if (database) {
    try {
      if (database.isDatabaseInitialized()) database.closeDatabase();
    } catch (error) {
      errors.push(error);
    }
  }

  delete process.env[DATABASE_MAINTENANCE_TOKEN_ENV];
  const guard = activeMaintenanceGuard;
  activeMaintenanceGuard = undefined;
  if (guard) {
    try {
      releaseDatabaseMaintenanceGuard(guard.lockPath, guard.token);
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, 'Failed to clean repair DB/guard state');
  }
}

function terminateFromSignal(signal: 'SIGINT' | 'SIGTERM'): never {
  try {
    cleanupActiveMaintenance();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

async function pauseAfterDatabaseInitForTest(): Promise<void> {
  if (process.env.NODE_ENV !== 'test') return;
  const marker = process.env.HAPPYCLAW_TEST_REPAIR_AFTER_DB_INIT_MARKER;
  if (marker) fs.writeFileSync(marker, `${process.pid}\n`, 'utf8');
  const delay = Number.parseInt(
    process.env.HAPPYCLAW_TEST_REPAIR_PAUSE_AFTER_DB_INIT_MS || '0',
    10,
  );
  if (Number.isInteger(delay) && delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

function configuredWebPort(): number {
  const raw = process.env.WEB_PORT || '3000';
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid WEB_PORT: ${raw}`);
  }
  return port;
}

function printUsage(): void {
  console.log(`Diagnose leftover JID-classifiable DMs still on workspace main.

This is a one-time tool, not a schema migration. Dry-run is the default.
Repair remounts onto channel_direct and resets isolation/recovery with a
new generation so contaminated main sessions and post-marker rows cannot
stay recoverable.
Both modes require a cleanly stopped service and the current DB schema.

Usage:
  npx tsx scripts/repair-leftover-direct-mounts.ts
  npx tsx scripts/repair-leftover-direct-mounts.ts --apply
  make leftover-direct-mounts
  make leftover-direct-mounts APPLY=1

Exit codes:
  0  no leftovers, or --apply succeeded
  1  usage / runtime error
  2  leftovers found (dry-run only)
`);
}

function parseArgs(argv: string[]): { apply: boolean } {
  let apply = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    console.error(`Unknown argument: ${arg}`);
    printUsage();
    process.exit(1);
  }
  return { apply };
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function assertServiceStopped(): Promise<void> {
  const webPort = configuredWebPort();
  const listening =
    (await canConnect('127.0.0.1', webPort)) ||
    (await canConnect('::1', webPort));
  if (listening) {
    throw new Error(
      `Refusing --apply while a service is listening on port ${webPort}. Stop HappyClaw and its process supervisor first.`,
    );
  }
}

function sqliteSidecarPaths(): string[] {
  return [
    `${DATABASE_PATH}-wal`,
    `${DATABASE_PATH}-shm`,
    `${DATABASE_PATH}-journal`,
  ];
}

function assertNoSqliteSidecars(): void {
  const present = sqliteSidecarPaths().filter((candidate) =>
    fs.existsSync(candidate),
  );
  if (present.length > 0) {
    throw new Error(
      `Refusing maintenance while SQLite sidecars exist: ${present.join(', ')}. Stop HappyClaw cleanly and verify it is no longer using the database; do not delete live WAL/SHM files.`,
    );
  }
}

async function assertDatabaseFilesUnused(): Promise<void> {
  const candidates = [DATABASE_PATH, ...sqliteSidecarPaths()].filter(
    (candidate) => fs.existsSync(candidate),
  );
  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-t', '--', ...candidates],
      {
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    if (!stdout.trim()) {
      throw new Error(
        'lsof exited successfully without reporting a PID; unable to prove database quiescence',
      );
    }
    throw new Error(
      `Refusing maintenance while messages.db is open by process(es): ${stdout
        .trim()
        .split(/\s+/)
        .join(', ')}`,
    );
  } catch (error) {
    const commandError = error as NodeJS.ErrnoException & {
      code?: string | number;
      stdout?: string;
      stderr?: string;
    };
    // lsof uses exit 1, without output, to mean that no matching open file
    // exists. Missing lsof, timeout, permission errors, and malformed output
    // all fail closed because this command can mutate privacy-sensitive state.
    if (
      commandError.code === 1 &&
      !commandError.stdout?.trim() &&
      !commandError.stderr?.trim()
    ) {
      return;
    }
    if (error instanceof Error && error.message.startsWith('Refusing ')) {
      throw error;
    }
    throw new Error(
      `Unable to prove that messages.db is unused with lsof: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

interface StableFileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function fileIdentity(fd: number): StableFileIdentity {
  const stat = fs.fstatSync(fd, { bigint: true });
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameFileIdentity(
  before: StableFileIdentity,
  after: StableFileIdentity,
): boolean {
  return Object.keys(before).every(
    (key) =>
      before[key as keyof StableFileIdentity] ===
      after[key as keyof StableFileIdentity],
  );
}

/**
 * Load an OS-read-only, file-must-exist snapshot into an in-memory query-only
 * connection. Opening the production WAL database through SQLite, even with
 * readonly:true, creates -wal/-shm sidecars; copying bytes into memory avoids
 * every source-tree write. Quiescence and sidecar checks ensure the main file
 * is a complete snapshot before its WAL header is adapted in memory only.
 */
function readSideEffectFreeDiagnosis(): LeftoverDirectMountDiagnosis {
  assertNoSqliteSidecars();
  const fd = fs.openSync(DATABASE_PATH, fs.constants.O_RDONLY);
  let bytes: Buffer;
  try {
    const before = fileIdentity(fd);
    bytes = fs.readFileSync(fd);
    const after = fileIdentity(fd);
    if (
      !sameFileIdentity(before, after) ||
      BigInt(bytes.length) !== before.size
    ) {
      throw new Error('Database changed while its read-only snapshot was read');
    }
  } finally {
    fs.closeSync(fd);
  }
  assertNoSqliteSidecars();

  if (
    bytes.length < 100 ||
    bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\u0000'
  ) {
    throw new Error('messages.db is not a valid SQLite 3 database');
  }
  const snapshot = Buffer.from(bytes);
  if (![1, 2].includes(snapshot[18]!) || ![1, 2].includes(snapshot[19]!)) {
    throw new Error('messages.db uses unsupported SQLite header versions');
  }
  // Serialized WAL-mode headers cannot be queried without a WAL filename.
  // Change only the private in-memory copy to rollback-journal mode.
  snapshot[18] = 1;
  snapshot[19] = 1;

  const probe = new Database(snapshot);
  try {
    probe.pragma('query_only = ON');
    return diagnoseLeftoverDirectMountsFromDatabase(
      probe,
      CURRENT_SCHEMA_VERSION,
    );
  } finally {
    probe.close();
  }
}

function printDiagnosis(diagnosis: LeftoverDirectMountDiagnosis): void {
  console.log('HappyClaw leftover classifiable DM diagnostic');
  console.log(`Schema version: ${diagnosis.schemaVersion}`);
  console.log(`CURRENT_SCHEMA_VERSION: ${CURRENT_SCHEMA_VERSION}`);
  console.log(`Database: ${DATABASE_PATH}`);
  console.log('');

  if (diagnosis.leftovers.length === 0) {
    console.log(
      'No leftover JID-classifiable DMs are bound to target_main_jid.',
    );
  } else {
    console.log(
      `Found ${diagnosis.leftovers.length} leftover direct mount(s) on workspace main:`,
    );
    for (const [index, leftover] of diagnosis.leftovers.entries()) {
      console.log('');
      console.log(`${index + 1}. ${leftover.channelJid}`);
      console.log(
        `   workspace: ${leftover.workspaceJid} (${leftover.workspaceFolder})`,
      );
      if (leftover.channelAccountId) {
        console.log(`   channel account: ${leftover.channelAccountId}`);
      }
      console.log(`   main owner: ${leftover.mainOwnerJid ?? '(none)'}`);
      console.log(
        `   main owner is this chat: ${leftover.mainOwnerIsThisChat}`,
      );
      console.log(`   main session: ${leftover.mainSessionId ?? '(none)'}`);
      console.log(
        `   isolation marker: ${leftover.existingIsolationMarker ?? '(none)'}`,
      );
      console.log(
        `   recoverable inbound from this chat: ${leftover.recoverableInboundFromThisChat}`,
      );
    }
  }

  if (diagnosis.aliasConflicts.length > 0) {
    console.log('');
    console.log(
      'WhatsApp alias routing conflicts require manual unbind; automatic repair will not guess an owner, workspace, or session:',
    );
    for (const conflict of diagnosis.aliasConflicts) {
      console.log(`- ${conflict.canonicalJid}: ${conflict.aliases.join(', ')}`);
      console.log(`  action: ${conflict.manualAction}`);
    }
  }

  if (diagnosis.affectedWorkspaces.length > 0) {
    console.log('');
    console.log(
      'Affected workspaces (a repair would reset isolation generation):',
    );
    for (const workspace of diagnosis.affectedWorkspaces) {
      console.log(
        `- ${workspace.workspaceJid} leftovers=${workspace.leftoverCount} marker=${
          workspace.existingIsolationMarker ?? '(none)'
        } recoverable_leaks=${workspace.recoverableInboundFromLeftovers} main_session=${
          workspace.mainSessionId ?? '(none)'
        }`,
      );
    }
  }
}

function printRepair(result: {
  remounted: number;
  isolationGenerationsReset: number;
  isolationMarkers: Record<string, string>;
  schemaVersion: string;
}): void {
  console.log('');
  console.log(
    `Repaired ${result.remounted} leftover mount(s). Reset isolation generation for ${result.isolationGenerationsReset} workspace(s).`,
  );
  for (const [workspaceJid, marker] of Object.entries(
    result.isolationMarkers,
  )) {
    console.log(`  ${workspaceJid} -> ${marker}`);
  }
  console.log(`Schema version remains ${result.schemaVersion}.`);
}

async function main(): Promise<void> {
  const { apply } = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(DATABASE_PATH)) {
    console.log(`No database at ${DATABASE_PATH}; nothing to diagnose.`);
    return;
  }

  if (!apply) {
    await assertDatabaseFilesUnused();
    const diagnosis = readSideEffectFreeDiagnosis();
    console.log('Mode: dry-run (strictly read-only; no writes)');
    printDiagnosis(diagnosis);
    if (
      diagnosis.leftovers.length === 0 &&
      diagnosis.aliasConflicts.length === 0
    )
      return;
    console.log('');
    console.log(
      'No changes written. Re-run with --apply to remount onto channel_direct and reset isolation/recovery state with a new generation.',
    );
    process.exitCode = 2;
    return;
  }

  const guard = acquireDatabaseMaintenanceGuard(DATABASE_PATH);
  activeMaintenanceGuard = guard;
  process.env[DATABASE_MAINTENANCE_TOKEN_ENV] = guard.token;
  try {
    await assertDatabaseFilesUnused();
    await assertServiceStopped();
    const before = readSideEffectFreeDiagnosis();
    console.log('Mode: apply');
    printDiagnosis(before);
    if (before.aliasConflicts.length > 0) {
      throw new Error(
        'Refusing automatic repair while WhatsApp alias routes conflict; manually unbind the listed aliases and rerun the diagnostic.',
      );
    }
    if (before.leftovers.length === 0) return;

    // The schema was verified through the side-effect-free repository before
    // importing config.ts/db.ts. initDatabase therefore cannot migrate or make
    // a pre-migration backup in this maintenance command.
    const db = await import('../src/db.js');
    activeDatabaseModule = db;
    const { repairLeftoverClassifiableDirectWorkspaceMounts } =
      await import('../src/leftover-direct-mount-repair.js');
    if (db.CURRENT_SCHEMA_VERSION !== CURRENT_SCHEMA_VERSION) {
      throw new Error('Schema version modules disagree; refusing repair');
    }

    try {
      db.initDatabase({ requireCurrentSchema: true });
      await pauseAfterDatabaseInitForTest();
      const result = repairLeftoverClassifiableDirectWorkspaceMounts({
        apply: true,
      });
      printRepair(result);
    } finally {
      if (db.isDatabaseInitialized()) db.closeDatabase();
    }
  } finally {
    cleanupActiveMaintenance();
  }
}

process.once('SIGINT', () => terminateFromSignal('SIGINT'));
process.once('SIGTERM', () => terminateFromSignal('SIGTERM'));

void main().then(
  () => {
    // The earliest load-env import may install an undici proxy dispatcher whose
    // idle handles outlive this one-shot command. All DB/guard cleanup has
    // completed when main resolves, so terminate explicitly after one flush.
    setImmediate(() => process.exit(process.exitCode ?? 0));
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    setImmediate(() => process.exit(1));
  },
);
