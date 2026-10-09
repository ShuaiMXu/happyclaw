import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import { getExternalCapabilityVaultRoot } from './external-capability-storage.js';

const EXCLUSIVE_OWNER_PREFIX = 'exclusive-owner-';
const EXCLUSIVE_OWNER_SUFFIX = '.json';
const EXCLUSIVE_FILE = 'exclusive.json';
const SHARED_DIRECTORY = 'shared';
const TEMP_DIRECTORY = 'tmp';
const LOCK_OWNER_VERSION = 2;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECIMAL_PATTERN = /^\d+$/;

interface LegacyLockOwner {
  pid: number;
  token: string;
}

interface LockOwner extends LegacyLockOwner {
  version: typeof LOCK_OWNER_VERSION;
  bootId: string;
  processStartTicks: string;
}

type ParsedLockOwner = LegacyLockOwner | LockOwner;

export interface ExternalCapabilityVaultLock {
  release: () => void;
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || (uid as number) < 0) {
    throw new Error(
      'External capability Vault locking requires POSIX ownership checks',
    );
  }
  return uid as number;
}

function expectedVaultId(env: NodeJS.ProcessEnv): string {
  const value = env.EXTERNAL_CAPABILITY_VAULT_ID?.trim();
  if (!value) {
    throw new Error(
      'EXTERNAL_CAPABILITY_VAULT_ID is required for external capability Vault locking',
    );
  }
  return value;
}

function lockRoot(env: NodeJS.ProcessEnv, dataDir: string): string {
  const vaultRoot = getExternalCapabilityVaultRoot(env);
  expectedVaultId(env);
  const identity = crypto
    .createHash('sha256')
    .update(path.resolve(vaultRoot))
    .digest('hex');
  return path.join(dataDir, 'external-capability-vault-locks', identity);
}

function directoryOpenFlags(): number {
  return (
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
  );
}

function assertPrivateDirectoryStat(stat: fs.Stats): void {
  if (
    !stat.isDirectory() ||
    stat.uid !== currentUid() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error('External capability Vault lock directory is unsafe');
  }
}

function openPrivateDirectory(directory: string): number {
  const descriptor = fs.openSync(directory, directoryOpenFlags());
  try {
    assertPrivateDirectoryStat(fs.fstatSync(descriptor));
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function assertPrivateDirectory(directory: string): void {
  const descriptor = openPrivateDirectory(directory);
  fs.closeSync(descriptor);
}

function ensurePrivateDirectory(directory: string): void {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  const descriptor = fs.openSync(directory, directoryOpenFlags());
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isDirectory() || stat.uid !== currentUid()) {
      throw new Error('External capability Vault lock directory is unsafe');
    }
    if ((stat.mode & 0o777) !== 0o700) fs.fchmodSync(descriptor, 0o700);
    assertPrivateDirectoryStat(fs.fstatSync(descriptor));
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = openPrivateDirectory(directory);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function prepareLockDirectories(
  env: NodeJS.ProcessEnv,
  dataDir: string,
): {
  root: string;
  shared: string;
  temporary: string;
  exclusive: string;
} {
  const parent = path.join(dataDir, 'external-capability-vault-locks');
  ensurePrivateDirectory(parent);
  const root = lockRoot(env, dataDir);
  ensurePrivateDirectory(root);
  const shared = path.join(root, SHARED_DIRECTORY);
  ensurePrivateDirectory(shared);
  const temporary = path.join(root, TEMP_DIRECTORY);
  ensurePrivateDirectory(temporary);
  return {
    root,
    shared,
    temporary,
    exclusive: path.join(root, EXCLUSIVE_FILE),
  };
}

function readBootId(): string {
  const bootId = fs
    .readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')
    .trim();
  if (!UUID_PATTERN.test(bootId)) {
    throw new Error(
      'External capability Vault process boot identity is invalid',
    );
  }
  return bootId;
}

function readProcessStartTicks(pid: number): string | null {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 0) {
    throw new Error('External capability Vault process identity is invalid');
  }
  const fields = stat
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/);
  const processStartTicks = fields[19];
  if (!processStartTicks || !DECIMAL_PATTERN.test(processStartTicks)) {
    throw new Error('External capability Vault process identity is invalid');
  }
  return processStartTicks;
}

function createLockOwner(): LockOwner {
  const processStartTicks = readProcessStartTicks(process.pid);
  if (!processStartTicks) {
    throw new Error('External capability Vault process identity disappeared');
  }
  return {
    version: LOCK_OWNER_VERSION,
    pid: process.pid,
    token: crypto.randomUUID(),
    bootId: readBootId(),
    processStartTicks,
  };
}

function parseOwner(bytes: Buffer): ParsedLockOwner {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('External capability Vault lock owner is invalid');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Number.isSafeInteger((parsed as { pid?: unknown }).pid) ||
    ((parsed as { pid: number }).pid ?? 0) <= 0 ||
    typeof (parsed as { token?: unknown }).token !== 'string' ||
    !UUID_PATTERN.test((parsed as { token: string }).token)
  ) {
    throw new Error('External capability Vault lock owner is invalid');
  }
  const candidate = parsed as Partial<LockOwner> & LegacyLockOwner;
  if (candidate.version === undefined) return candidate;
  if (
    candidate.version !== LOCK_OWNER_VERSION ||
    typeof candidate.bootId !== 'string' ||
    !UUID_PATTERN.test(candidate.bootId) ||
    typeof candidate.processStartTicks !== 'string' ||
    !DECIMAL_PATTERN.test(candidate.processStartTicks)
  ) {
    throw new Error('External capability Vault lock owner is invalid');
  }
  return candidate as LockOwner;
}

function readOwnerFile(
  filePath: string,
  allowedLinkCounts: readonly number[] = [1],
): { owner: ParsedLockOwner; stat: fs.Stats } {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      !allowedLinkCounts.includes(stat.nlink) ||
      stat.uid !== currentUid() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size <= 0 ||
      stat.size > 512
    ) {
      throw new Error('External capability Vault lock owner is unsafe');
    }
    return { owner: parseOwner(fs.readFileSync(descriptor)), stat };
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeOwnerFile(
  filePath: string,
  owner: ParsedLockOwner,
  temporaryDirectory: string,
): void {
  const temporaryPath = path.join(
    temporaryDirectory,
    `${owner.token}-${crypto.randomUUID()}.tmp`,
  );
  let descriptor: number | null = fs.openSync(
    temporaryPath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  let published = false;
  try {
    fs.writeFileSync(descriptor, JSON.stringify(owner));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;

    // The authoritative path becomes visible only after the complete owner
    // record is durable. A hard link provides atomic no-replace publication.
    fs.linkSync(temporaryPath, filePath);
    published = true;
    fsyncDirectory(path.dirname(filePath));
    fs.unlinkSync(temporaryPath);
    fsyncDirectory(temporaryDirectory);
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original publication failure.
      }
    }
    if (published) {
      try {
        fs.unlinkSync(filePath);
        fsyncDirectory(path.dirname(filePath));
      } catch {
        // A complete owner record remains fail-closed if rollback fails.
      }
    }
    try {
      fs.unlinkSync(temporaryPath);
      fsyncDirectory(temporaryDirectory);
    } catch {
      // Temporary files are never treated as authoritative lock owners.
    }
    throw error;
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

function ownerIsAlive(owner: ParsedLockOwner): boolean {
  if (!pidIsAlive(owner.pid)) return false;
  if (!('version' in owner)) {
    // Legacy owner records cannot disambiguate PID reuse. Preserve their prior
    // fail-closed behavior until the original process exits.
    return true;
  }
  if (owner.bootId !== readBootId()) return false;
  return readProcessStartTicks(owner.pid) === owner.processStartTicks;
}

function sameOwner(left: ParsedLockOwner, right: ParsedLockOwner): boolean {
  if (left.pid !== right.pid || left.token !== right.token) return false;
  if (!('version' in left) || !('version' in right)) {
    return !('version' in left) && !('version' in right);
  }
  return (
    left.version === right.version &&
    left.bootId === right.bootId &&
    left.processStartTicks === right.processStartTicks
  );
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function unlinkOwnedFile(
  filePath: string,
  owner: ParsedLockOwner,
  allowedLinkCounts: readonly number[] = [1],
): void {
  const current = readOwnerFile(filePath, allowedLinkCounts);
  if (!sameOwner(current.owner, owner)) {
    throw new Error('External capability Vault lock ownership changed');
  }
  fs.unlinkSync(filePath);
  fsyncDirectory(path.dirname(filePath));
}

function exclusiveOwnerPath(root: string, owner: ParsedLockOwner): string {
  return path.join(
    root,
    `${EXCLUSIVE_OWNER_PREFIX}${owner.token}${EXCLUSIVE_OWNER_SUFFIX}`,
  );
}

function readExclusiveOwner(
  root: string,
  exclusivePath: string,
): { owner: ParsedLockOwner; stat: fs.Stats } {
  assertPrivateDirectory(root);
  const current = readOwnerFile(exclusivePath, [1, 2]);
  const companionPath = exclusiveOwnerPath(root, current.owner);
  try {
    const companion = readOwnerFile(companionPath, [2]);
    if (
      !sameOwner(current.owner, companion.owner) ||
      !sameFile(current.stat, companion.stat)
    ) {
      throw new Error('External capability Vault exclusive lock is malformed');
    }
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
      current.stat.nlink !== 1
    ) {
      throw error;
    }
  }
  return current;
}

function releaseExclusive(
  root: string,
  exclusivePath: string,
  owner: ParsedLockOwner,
): void {
  const current = readExclusiveOwner(root, exclusivePath);
  if (!sameOwner(current.owner, owner)) {
    throw new Error('External capability Vault lock ownership changed');
  }
  const companionPath = exclusiveOwnerPath(root, owner);
  try {
    const companion = readOwnerFile(companionPath, [2]);
    if (
      !sameOwner(companion.owner, owner) ||
      !sameFile(current.stat, companion.stat)
    ) {
      throw new Error('External capability Vault exclusive lock is malformed');
    }
    fs.unlinkSync(companionPath);
    fsyncDirectory(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  unlinkOwnedFile(exclusivePath, owner, [1]);
}

function exclusiveExists(root: string, exclusivePath: string): boolean {
  try {
    readExclusiveOwner(root, exclusivePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function acquireExternalCapabilityVaultSharedLock(
  env: NodeJS.ProcessEnv = process.env,
  dataDir = DATA_DIR,
): ExternalCapabilityVaultLock | null {
  const directories = prepareLockDirectories(env, dataDir);
  if (exclusiveExists(directories.root, directories.exclusive)) return null;

  const owner = createLockOwner();
  const ownerPath = path.join(directories.shared, `${owner.token}.json`);
  writeOwnerFile(ownerPath, owner, directories.temporary);
  try {
    if (exclusiveExists(directories.root, directories.exclusive)) {
      unlinkOwnedFile(ownerPath, owner);
      return null;
    }
  } catch (error) {
    try {
      unlinkOwnedFile(ownerPath, owner);
    } catch {
      // Keep an unverifiable owner file fail-closed for the next census.
    }
    throw error;
  }

  let released = false;
  return {
    release: () => {
      if (released) return;
      unlinkOwnedFile(ownerPath, owner);
      released = true;
    },
  };
}

export function acquireExternalCapabilityVaultExclusiveLock(
  env: NodeJS.ProcessEnv = process.env,
  dataDir = DATA_DIR,
): ExternalCapabilityVaultLock {
  const directories = prepareLockDirectories(env, dataDir);
  const owner = createLockOwner();
  const ownerPath = exclusiveOwnerPath(directories.root, owner);
  writeOwnerFile(ownerPath, owner, directories.temporary);

  let acquired = false;
  try {
    for (;;) {
      try {
        fs.linkSync(ownerPath, directories.exclusive);
        fsyncDirectory(directories.root);
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }

      const existing = readExclusiveOwner(
        directories.root,
        directories.exclusive,
      ).owner;
      if (ownerIsAlive(existing)) {
        throw new Error('External capability Vault census is already running');
      }
      try {
        releaseExclusive(directories.root, directories.exclusive, existing);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

    for (const entry of fs.readdirSync(directories.shared)) {
      if (
        !UUID_PATTERN.test(entry.replace(/\.json$/, '')) ||
        !entry.endsWith('.json')
      ) {
        throw new Error('External capability Vault shared lock is malformed');
      }
      const sharedOwnerPath = path.join(directories.shared, entry);
      const sharedOwner = readOwnerFile(sharedOwnerPath, [1, 2]).owner;
      if (ownerIsAlive(sharedOwner)) {
        throw new Error(
          'External capability Vault census is blocked by active producers',
        );
      }
      unlinkOwnedFile(sharedOwnerPath, sharedOwner, [1, 2]);
    }
  } catch (error) {
    try {
      if (acquired) {
        releaseExclusive(directories.root, directories.exclusive, owner);
      } else {
        unlinkOwnedFile(ownerPath, owner);
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'External capability Vault lock acquisition failed and cleanup was incomplete',
      );
    }
    throw error;
  }

  let released = false;
  return {
    release: () => {
      if (released) return;
      releaseExclusive(directories.root, directories.exclusive, owner);
      released = true;
    },
  };
}
