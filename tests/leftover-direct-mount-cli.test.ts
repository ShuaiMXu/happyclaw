import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

import {
  acquireDatabaseMaintenanceGuard,
  assertDatabaseMaintenanceAccess,
  DATABASE_MAINTENANCE_TOKEN_ENV,
  releaseDatabaseMaintenanceGuard,
} from '../src/database-maintenance.js';
import { CURRENT_SCHEMA_VERSION } from '../src/schema-version.js';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'leftover-direct-mount-cli-'),
);
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const scriptPath = path.join(
  repositoryRoot,
  'scripts',
  'repair-leftover-direct-mounts.ts',
);
const tsxCli = path.join(
  repositoryRoot,
  'node_modules',
  'tsx',
  'dist',
  'cli.mjs',
);
const defaultTestWebPort = (() => {
  for (let offset = 0; offset < 200; offset++) {
    const candidate = 40_000 + ((process.pid + offset) % 20_000);
    const probe = spawnSync('lsof', [
      '-nP',
      `-iTCP:${candidate}`,
      '-sTCP:LISTEN',
    ]);
    if (probe.status !== 0) return candidate;
  }
  throw new Error('Unable to find an unused test WEB_PORT');
})();

afterAll(() => {
  delete process.env[DATABASE_MAINTENANCE_TOKEN_ENV];
  fs.rmSync(root, { recursive: true, force: true });
});

function instanceRoot(name: string): string {
  const target = path.join(root, name);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    path.join(target, '.env'),
    `WEB_PORT=${defaultTestWebPort}\n`,
  );
  return target;
}

function databasePath(instance: string): string {
  return path.join(instance, 'data', 'db', 'messages.db');
}

function createDiagnosticDatabase(
  instance: string,
  options: { schemaVersion?: number; leftover?: boolean } = {},
): string {
  const dbPath = databasePath(instance);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const probe = new Database(dbPath);
  probe.pragma('journal_mode = DELETE');
  probe.exec(`
    CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      created_by TEXT,
      channel_account_id TEXT,
      target_agent_id TEXT,
      target_main_jid TEXT,
      owner_im_id TEXT,
      owner_claim_source TEXT,
      binding_mode TEXT,
      reply_policy TEXT,
      require_mention INTEGER,
      activation_mode TEXT,
      audience_mode TEXT,
      sender_allowlist TEXT
    );
    CREATE TABLE messages (
      id TEXT,
      chat_jid TEXT,
      source_jid TEXT,
      is_from_me INTEGER,
      history_recovery_allowed INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE sessions (
      group_folder TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (group_folder, agent_id)
    );
    CREATE TABLE workspace_runtime_sessions (
      group_folder TEXT NOT NULL,
      runtime_agent_id TEXT NOT NULL DEFAULT '',
      sdk_session_id TEXT,
      PRIMARY KEY (group_folder, runtime_agent_id)
    );
  `);
  probe
    .prepare('INSERT INTO router_state (key, value) VALUES (?, ?)')
    .run(
      'schema_version',
      String(options.schemaVersion ?? CURRENT_SCHEMA_VERSION),
    );
  if (options.leftover) {
    probe
      .prepare(
        `INSERT INTO registered_groups
           (jid, name, folder, channel_account_id, target_agent_id, target_main_jid)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'web:cli-workspace',
        'CLI workspace',
        'cli-workspace',
        null,
        null,
        null,
      );
    probe
      .prepare(
        `INSERT INTO registered_groups
           (jid, name, folder, channel_account_id, target_agent_id, target_main_jid)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'whatsapp:123456789012345@lid#account:bot-a',
        'Leftover LID DM',
        'cli-workspace-direct',
        'bot-a',
        null,
        'web:cli-workspace',
      );
  }
  probe.close();
  return dbPath;
}

function childEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.WEB_PORT;
  delete env.PORT;
  delete env[DATABASE_MAINTENANCE_TOKEN_ENV];
  return env;
}

function runCli(
  instance: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync(process.execPath, [tsxCli, scriptPath, ...args], {
    cwd: instance,
    env: childEnvironment(env),
    encoding: 'utf8',
    timeout: 20_000,
  });
}

function fakeLsofDirectory(instance: string, body: string): string {
  const bin = path.join(instance, 'fake-bin');
  fs.mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, 'lsof');
  fs.writeFileSync(executable, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

async function waitForPath(target: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(target)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${target}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForDatabaseOwner(
  dbPath: string,
  pid: number,
  timeoutMs = 5000,
): Promise<void> {
  const databaseFiles = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(
    (candidate) => fs.existsSync(candidate),
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = spawnSync('lsof', ['-t', '--', ...databaseFiles], {
      encoding: 'utf8',
    });
    if (
      result.status === 0 &&
      result.stdout.trim().split(/\s+/).includes(String(pid))
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for pid ${pid} to open ${dbPath}`);
}

function databaseFingerprint(dbPath: string) {
  const stat = fs.statSync(dbPath, { bigint: true });
  return {
    hash: createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex'),
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    wal: fs.existsSync(`${dbPath}-wal`),
    shm: fs.existsSync(`${dbPath}-shm`),
    journal: fs.existsSync(`${dbPath}-journal`),
  };
}

describe.sequential('leftover direct mount maintenance CLI', () => {
  test('no database exits cleanly without creating data or config', () => {
    const instance = instanceRoot('missing');
    const result = runCli(instance);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No database');
    expect(fs.existsSync(path.join(instance, 'data'))).toBe(false);
  });

  test('current-schema dry-run is byte-for-byte side-effect-free', () => {
    const instance = instanceRoot('current-clean');
    const dbPath = createDiagnosticDatabase(instance);
    const before = databaseFingerprint(dbPath);
    const dataEntriesBefore = fs.readdirSync(path.join(instance, 'data'));

    const result = runCli(instance);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('strictly read-only');
    expect(result.stdout).toContain('No leftover');
    expect(databaseFingerprint(dbPath)).toEqual(before);
    expect(fs.readdirSync(path.join(instance, 'data'))).toEqual(
      dataEntriesBefore,
    );
    expect(fs.existsSync(path.join(instance, 'data', 'config'))).toBe(false);
  });

  test('dry-run returns 2 for leftovers without changing DB, WAL or config', () => {
    const instance = instanceRoot('current-leftover');
    const dbPath = createDiagnosticDatabase(instance, { leftover: true });
    const before = databaseFingerprint(dbPath);

    const result = runCli(instance);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('Found 1 leftover direct mount');
    expect(databaseFingerprint(dbPath)).toEqual(before);
    expect(fs.existsSync(path.join(instance, 'data', 'config'))).toBe(false);
  });

  test.each([
    { mode: 'dry-run', args: [] as string[] },
    { mode: 'apply', args: ['--apply'] },
  ])('old schema refuses $mode without migration or backup', ({ args }) => {
    const instance = instanceRoot(
      args.length === 0 ? 'old-dry-run' : 'old-apply',
    );
    const dbPath = createDiagnosticDatabase(instance, {
      schemaVersion: CURRENT_SCHEMA_VERSION - 1,
      leftover: true,
    });
    const before = databaseFingerprint(dbPath);

    const result = runCli(instance, args);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `requires schema v${CURRENT_SCHEMA_VERSION}`,
    );
    expect(databaseFingerprint(dbPath)).toEqual(before);
    expect(
      fs.existsSync(path.join(path.dirname(dbPath), 'migration-backups')),
    ).toBe(false);
    expect(fs.existsSync(path.join(instance, 'data', 'config'))).toBe(false);
  });

  test('open database is detected with lsof and fails closed', () => {
    const instance = instanceRoot('open-database');
    const dbPath = createDiagnosticDatabase(instance, { leftover: true });
    const openHandle = new Database(dbPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const result = runCli(instance);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('open by process');
    } finally {
      openHandle.close();
    }
  });

  test('lsof exit 0 without PIDs fails closed', () => {
    const instance = instanceRoot('empty-success-lsof');
    const dbPath = createDiagnosticDatabase(instance, { leftover: true });
    const before = databaseFingerprint(dbPath);
    const fakeBin = fakeLsofDirectory(instance, 'exit 0');

    const result = runCli(instance, [], {
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unable to prove database quiescence');
    expect(databaseFingerprint(dbPath)).toEqual(before);
  });

  test.each([
    { signal: 'SIGINT' as const, exitCode: 130 },
    { signal: 'SIGTERM' as const, exitCode: 143 },
  ])(
    '$signal cleans the maintenance guard before exit',
    async ({ signal, exitCode }) => {
      const instance = instanceRoot(`signal-${signal.toLowerCase()}`);
      const dbPath = createDiagnosticDatabase(instance, { leftover: true });
      const before = databaseFingerprint(dbPath);
      const fakeBin = fakeLsofDirectory(instance, 'sleep 2\nexit 1');
      const lockPath = path.join(
        path.dirname(dbPath),
        '.happyclaw-database-maintenance.lock',
      );
      const child = spawn(process.execPath, [tsxCli, scriptPath, '--apply'], {
        cwd: instance,
        env: childEnvironment({
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await waitForPath(lockPath);
      child.kill(signal);
      const outcome = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, childSignal) =>
          resolve({ code, signal: childSignal }),
        );
      });

      expect(outcome).toEqual({ code: exitCode, signal: null });
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(databaseFingerprint(dbPath)).toEqual(before);
    },
  );

  test('custom .env port blocks apply while service is listening', async () => {
    const instance = instanceRoot('custom-port');
    const dbPath = createDiagnosticDatabase(instance, { leftover: true });
    const before = databaseFingerprint(dbPath);
    const server = net.createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server address');
    }
    fs.writeFileSync(
      path.join(instance, '.env'),
      `WEB_PORT=${address.port}\n`,
      'utf8',
    );
    try {
      const result = runCli(instance, ['--apply']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`listening on port ${address.port}`);
      expect(databaseFingerprint(dbPath)).toEqual(before);
      expect(
        fs.existsSync(
          path.join(
            path.dirname(dbPath),
            '.happyclaw-database-maintenance.lock',
          ),
        ),
      ).toBe(false);
      expect(fs.existsSync(path.join(instance, 'data', 'config'))).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test('maintenance guard blocks normal database bootstrap owners', () => {
    const instance = instanceRoot('maintenance-guard');
    const dbPath = createDiagnosticDatabase(instance);
    const guard = acquireDatabaseMaintenanceGuard(dbPath);
    try {
      expect(() => assertDatabaseMaintenanceAccess(dbPath)).toThrow(
        'maintenance is active',
      );
      process.env[DATABASE_MAINTENANCE_TOKEN_ENV] = guard.token;
      expect(() => assertDatabaseMaintenanceAccess(dbPath)).not.toThrow();
    } finally {
      delete process.env[DATABASE_MAINTENANCE_TOKEN_ENV];
      releaseDatabaseMaintenanceGuard(guard.lockPath, guard.token);
    }
  });

  test('apply repairs a current-schema DB without a migration backup', async () => {
    const instance = instanceRoot('current-apply');
    const dataDir = path.join(instance, 'data');
    const storeDir = path.join(dataDir, 'db');
    const groupsDir = path.join(dataDir, 'groups');
    fs.mkdirSync(storeDir, { recursive: true });
    fs.mkdirSync(groupsDir, { recursive: true });
    vi.doMock('../src/config.js', () => ({
      DATA_DIR: dataDir,
      STORE_DIR: storeDir,
      GROUPS_DIR: groupsDir,
    }));
    vi.doMock('../src/logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    const db = await import('../src/db.js');
    db.initDatabase();
    db.setRegisteredGroup('web:apply-workspace', {
      name: 'Apply workspace',
      folder: 'apply-workspace',
      added_at: '2026-08-20T00:00:00.000Z',
      created_by: 'owner-a',
    });
    db.setRegisteredGroup('whatsapp:123456789012345@lid#account:apply-bot', {
      name: 'Apply leftover LID',
      folder: 'apply-workspace-direct',
      added_at: '2026-08-20T00:00:00.000Z',
      created_by: 'owner-a',
      channel_account_id: 'apply-bot',
      target_main_jid: 'web:apply-workspace',
    });
    db.closeDatabase();

    const dbPath = databasePath(instance);
    const result = runCli(instance, ['--apply']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Repaired 1 leftover mount');
    expect(
      fs.existsSync(path.join(path.dirname(dbPath), 'migration-backups')),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(path.dirname(dbPath), '.happyclaw-database-maintenance.lock'),
      ),
    ).toBe(false);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);

    const after = runCli(instance);
    expect(after.status).toBe(0);
    expect(after.stdout).toContain('No leftover');

    const restartGuard = acquireDatabaseMaintenanceGuard(dbPath);
    try {
      expect(() => db.initDatabase()).toThrow('maintenance is active');
    } finally {
      releaseDatabaseMaintenanceGuard(
        restartGuard.lockPath,
        restartGuard.token,
      );
    }

    const racingGuard = acquireDatabaseMaintenanceGuard(dbPath);
    const originalExistsSync = fs.existsSync.bind(fs);
    let maintenanceLockChecks = 0;
    const existsSpy = vi
      .spyOn(fs, 'existsSync')
      .mockImplementation((target) => {
        if (
          path.resolve(String(target)) === path.resolve(racingGuard.lockPath)
        ) {
          maintenanceLockChecks += 1;
          if (maintenanceLockChecks === 1) return false;
        }
        return originalExistsSync(target);
      });
    try {
      expect(() => db.initDatabase()).toThrow('maintenance is active');
      expect(maintenanceLockChecks).toBeGreaterThanOrEqual(2);
      expect(db.isDatabaseInitialized()).toBe(false);
    } finally {
      existsSpy.mockRestore();
      releaseDatabaseMaintenanceGuard(racingGuard.lockPath, racingGuard.token);
    }

    db.initDatabase();
    db.setRegisteredGroup('whatsapp:223456789012345@lid#account:apply-bot', {
      name: 'Signal cleanup LID',
      folder: 'apply-workspace-direct-signal',
      added_at: '2026-08-20T00:00:00.000Z',
      created_by: 'owner-a',
      channel_account_id: 'apply-bot',
      target_main_jid: 'web:apply-workspace',
    });
    db.closeDatabase();
    const lockPath = path.join(
      path.dirname(dbPath),
      '.happyclaw-database-maintenance.lock',
    );
    const afterInitMarker = path.join(instance, 'after-db-init.marker');
    const signalChild = spawn(
      process.execPath,
      [tsxCli, scriptPath, '--apply'],
      {
        cwd: instance,
        env: childEnvironment({
          NODE_ENV: 'test',
          HAPPYCLAW_TEST_REPAIR_PAUSE_AFTER_DB_INIT_MS: '10000',
          HAPPYCLAW_TEST_REPAIR_AFTER_DB_INIT_MARKER: afterInitMarker,
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    await waitForPath(lockPath);
    await waitForPath(afterInitMarker);
    const repairPid = Number.parseInt(
      fs.readFileSync(afterInitMarker, 'utf8').trim(),
      10,
    );
    await waitForDatabaseOwner(dbPath, repairPid);
    process.kill(repairPid, 'SIGTERM');
    const signalOutcome = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      signalChild.once('error', reject);
      signalChild.once('exit', (code, signal) => resolve({ code, signal }));
    });
    expect(signalOutcome).toEqual({ code: 143, signal: null });
    expect(fs.existsSync(lockPath)).toBe(false);
    const ownersAfterSignal = spawnSync(
      'lsof',
      [
        '-t',
        '--',
        ...[dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter((candidate) =>
          fs.existsSync(candidate),
        ),
      ],
      { encoding: 'utf8' },
    );
    expect(ownersAfterSignal.status).toBe(1);
    expect(ownersAfterSignal.stdout).toBe('');

    db.initDatabase();
    const conflictCanonical =
      'whatsapp:17770001111@s.whatsapp.net#account:conflict-bot';
    const conflictAliases = [
      'whatsapp:17770001111:8@c.us#account:conflict-bot',
      'whatsapp:17770001111@c.us#account:conflict-bot',
    ];
    for (const [suffix, owner] of [
      ['a', 'owner-a'],
      ['b', 'owner-b'],
    ] as const) {
      db.setRegisteredGroup(`web:cli-conflict-${suffix}`, {
        name: `CLI conflict ${suffix}`,
        folder: `cli-conflict-${suffix}`,
        added_at: '2026-08-20T00:00:00.000Z',
        created_by: owner,
      });
      db.setRegisteredGroup(conflictAliases[suffix === 'a' ? 0 : 1]!, {
        name: `CLI conflict alias ${suffix}`,
        folder: `cli-conflict-${suffix}-direct`,
        added_at: '2026-08-20T00:00:00.000Z',
        created_by: owner,
        channel_account_id: 'conflict-bot',
        target_main_jid: `web:cli-conflict-${suffix}`,
      });
    }
    db.closeDatabase();

    const conflictDiagnosis = runCli(instance);
    expect(conflictDiagnosis.status).toBe(2);
    expect(conflictDiagnosis.stdout).toContain(conflictCanonical);
    expect(conflictDiagnosis.stdout).toContain(
      'require manual unbind; automatic repair will not guess',
    );
    const conflictApply = runCli(instance, ['--apply']);
    expect(conflictApply.status).toBe(1);
    expect(conflictApply.stderr).toContain(
      'Refusing automatic repair while WhatsApp alias routes conflict',
    );
  }, 30_000);

  test('Make resolves WEB_PORT from .env instead of masking it with 3000', () => {
    const instance = instanceRoot('make-port');
    fs.writeFileSync(path.join(instance, '.env'), 'WEB_PORT=43129\n', 'utf8');
    const result = spawnSync(
      'make',
      ['-f', path.join(repositoryRoot, 'Makefile'), '-pn', 'help'],
      {
        cwd: instance,
        env: childEnvironment(),
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^WEB_PORT := 43129$/m);
  });
});
