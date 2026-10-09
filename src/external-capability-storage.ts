import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REF_PREFIX = 'ecv1';
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const VAULT_ID_SENTINEL_NAME = '.happyclaw-external-vault-id';
const MAX_VAULT_ID_BYTES = 1024;
const DIRECTORY_OPEN_FLAGS =
  fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const FILE_OPEN_FLAGS =
  fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNTIME_DIRECTORY_PATTERN = new RegExp(
  `^(${RUN_ID_PATTERN.source.slice(1, -1)})-(?:a\\d+-l\\d+-)?[A-Za-z0-9]{6}$`,
  'i',
);

export interface ExternalCapabilityManagedDirectory {
  name: string;
  runId: string;
  mtimeMs: number;
}

export interface ExternalCapabilityVaultOccupancy {
  runId: string;
  kind: 'artifact' | 'runtime';
  objectKey: string;
  occupiedBytes: number;
}

export type ExternalCapabilityVaultCensusOccupancy =
  ExternalCapabilityVaultOccupancy;

export interface ExternalCapabilityLegacyVaultOccupancy {
  runId: string;
  kind: 'input' | 'runtime';
  objectKey: string;
  occupiedBytes: number;
}

export interface ExternalCapabilityVaultCensus {
  identity: string;
  occupancies: ExternalCapabilityVaultCensusOccupancy[];
}

export const EXTERNAL_CAPABILITY_VAULT_ID_SENTINEL = VAULT_ID_SENTINEL_NAME;
export const EXTERNAL_CAPABILITY_LEGACY_RUN_OBJECT_KEY = 'legacy-run-artifacts';

export interface StoreExternalCapabilityArtifactInput {
  runId: string;
  artifactId: string;
  bytes: Uint8Array;
}

export interface StoredExternalCapabilityArtifact {
  storageRef: string;
  byteLength: number;
  sha256: string;
}

export interface ReadExternalCapabilityArtifactInput {
  storageRef: string;
  byteLength: number;
  sha256: string;
}

export class ExternalCapabilityArtifactIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalCapabilityArtifactIntegrityError';
  }
}

function ensureSafeId(value: string, label: string): string {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a server-generated identifier`);
  }
  return value;
}

function pathIsInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function assertNoSymlinkAncestors(target: string): void {
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const segment of target.slice(parsed.root.length).split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(
          'External capability vault must not contain symbolic-link ancestors',
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}

/**
 * External documents must be stored outside the HappyClaw project directory.
 * Admin-home containers may mount the project root, so a data/ subdirectory is
 * not a private vault for input that belongs to another integration tenant.
 */
export function validateExternalCapabilityVaultRoot(root: string): string {
  const resolvedRoot = path.resolve(root);
  const projectRoot = path.resolve(process.cwd());
  const homeRoot = path.resolve(os.homedir());
  const filesystemRoot = path.parse(resolvedRoot).root;
  if (
    resolvedRoot === filesystemRoot ||
    pathIsInside(homeRoot, resolvedRoot) ||
    pathIsInside(projectRoot, resolvedRoot) ||
    pathIsInside(resolvedRoot, projectRoot)
  ) {
    throw new Error(
      'External capability vault must be a dedicated path outside project and home roots',
    );
  }
  assertNoSymlinkAncestors(resolvedRoot);
  return resolvedRoot;
}

export function getExternalCapabilityVaultRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.EXTERNAL_CAPABILITY_VAULT_DIR?.trim();
  if (!configured) {
    throw new Error(
      'EXTERNAL_CAPABILITY_VAULT_DIR is required for external capability input storage',
    );
  }
  return validateExternalCapabilityVaultRoot(configured);
}

/** Verify create, fsync, read, digest, and delete before allowing activation. */
export function probeExternalCapabilityVault(
  vaultRoot: string,
  identity: { runId?: string; artifactId?: string } = {},
): void {
  const runId = identity.runId ?? crypto.randomUUID();
  const artifactId = identity.artifactId ?? `readiness-${crypto.randomUUID()}`;
  const bytes = crypto.randomBytes(32);
  try {
    const stored = storeExternalCapabilityArtifact(vaultRoot, {
      runId,
      artifactId,
      bytes,
    });
    const actual = readExternalCapabilityArtifact(vaultRoot, stored);
    if (!crypto.timingSafeEqual(bytes, actual)) {
      throw new Error(
        'External capability vault readiness bytes did not match',
      );
    }
    deleteExternalCapabilityRunArtifacts(vaultRoot, runId);
  } catch (error) {
    try {
      deleteExternalCapabilityRunArtifacts(vaultRoot, runId);
    } catch {
      // Preserve the readiness failure while cleanup remains best-effort.
    }
    throw error;
  }
}

function ensurePrivateDirectory(directory: string): void {
  const created = fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('External capability vault path must be a real directory');
  }
  if (created) {
    fs.chmodSync(directory, 0o700);
    return;
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new Error(
      'Existing external capability vault directory has an unexpected owner',
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      'Existing external capability vault directory must not be group or world accessible',
    );
  }
}

function getRunDirectory(root: string, runId: string): string {
  const resolvedRoot = validateExternalCapabilityVaultRoot(root);
  ensurePrivateDirectory(resolvedRoot);
  const runDirectory = path.join(resolvedRoot, 'runs', runId);
  if (!pathIsInside(resolvedRoot, runDirectory)) {
    throw new Error('External capability vault path escaped its root');
  }
  ensurePrivateDirectory(path.dirname(runDirectory));
  ensurePrivateDirectory(runDirectory);
  return runDirectory;
}

function assertExistingPrivateDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('External capability vault path must be a real directory');
  }
}

function assertSafeOwnerAndMode(stat: fs.Stats, description: string): void {
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new Error(`${description} has foreign ownership`);
  }
  if ((stat.mode & 0o7077) !== 0) {
    throw new Error(`${description} has unsafe permissions`);
  }
}

function assertStrictPrivateDirectoryStat(
  stat: fs.Stats,
  description: string,
): void {
  if (!stat.isDirectory()) {
    throw new Error(`${description} is not a directory`);
  }
  assertSafeOwnerAndMode(stat, description);
}

function assertStrictPrivateDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) {
    throw new Error(
      'External capability Vault inventory found a symbolic link',
    );
  }
  assertStrictPrivateDirectoryStat(
    stat,
    'External capability Vault inventory directory',
  );
}

function assertSingleLinkRegularFile(
  stat: fs.Stats,
  description: string,
): void {
  if (!stat.isFile()) {
    throw new Error(`${description} is not a regular file`);
  }
  if (stat.nlink !== 1) {
    throw new Error(`${description} is multiply linked`);
  }
}

function addExternalCapabilityOccupiedBytes(
  total: number,
  bytes: number,
): number {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    total > Number.MAX_SAFE_INTEGER - bytes
  ) {
    throw new Error('External capability Vault inventory size overflowed');
  }
  return total + bytes;
}

function descriptorPathForFd(fd: number): string {
  const expected = fs.fstatSync(fd);
  for (const descriptorRoot of ['/proc/self/fd', '/dev/fd']) {
    const descriptorPath = path.join(descriptorRoot, String(fd));
    try {
      const actual = fs.statSync(descriptorPath);
      if (actual.dev === expected.dev && actual.ino === expected.ino) {
        return descriptorPath;
      }
    } catch {
      // Try the other platform descriptor filesystem before failing closed.
    }
  }
  throw new Error(
    'External capability Vault requires /proc/self/fd or /dev/fd traversal',
  );
}

function openDescriptorEntry(
  parentFd: number,
  name: string,
  flags: number,
): number {
  return fs.openSync(path.join(descriptorPathForFd(parentFd), name), flags);
}

function sortedDescriptorEntries(directoryFd: number): string[] {
  return fs.readdirSync(descriptorPathForFd(directoryFd)).sort();
}

function readExactDescriptorFile(fd: number, byteLength: number): Buffer {
  const bytes = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const read = fs.readSync(fd, bytes, offset, byteLength - offset, offset);
    if (read <= 0) {
      throw new Error(
        'External capability Vault identity sentinel was truncated',
      );
    }
    offset += read;
  }
  return bytes;
}

function validateExpectedVaultId(expectedVaultId: string): Buffer {
  const bytes = Buffer.from(expectedVaultId, 'utf8');
  if (
    bytes.length === 0 ||
    bytes.length > MAX_VAULT_ID_BYTES ||
    expectedVaultId.includes('\0')
  ) {
    throw new Error('External capability Vault expected ID is invalid');
  }
  return bytes;
}

function openAndValidateVaultSentinel(
  rootFd: number,
  expectedVaultId: string,
): { fd: number; stat: fs.BigIntStats } {
  const expectedBytes = validateExpectedVaultId(expectedVaultId);
  const sentinelFd = openDescriptorEntry(
    rootFd,
    VAULT_ID_SENTINEL_NAME,
    FILE_OPEN_FLAGS,
  );
  try {
    const stat = fs.fstatSync(sentinelFd);
    assertSingleLinkRegularFile(
      stat,
      'External capability Vault identity sentinel',
    );
    assertSafeOwnerAndMode(stat, 'External capability Vault identity sentinel');
    if (stat.size > MAX_VAULT_ID_BYTES) {
      throw new Error(
        'External capability Vault identity sentinel exceeds its size limit',
      );
    }
    const actualBytes = readExactDescriptorFile(sentinelFd, stat.size);
    if (!actualBytes.equals(expectedBytes)) {
      throw new Error(
        'External capability Vault identity sentinel does not match',
      );
    }
    return {
      fd: sentinelFd,
      stat: fs.fstatSync(sentinelFd, { bigint: true }),
    };
  } catch (error) {
    fs.closeSync(sentinelFd);
    throw error;
  }
}

function measureExternalCapabilityRuntimeTree(directory: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      throw new Error(
        'External capability Vault inventory found a symbolic link',
      );
    }
    if (stat.isDirectory()) {
      assertStrictPrivateDirectoryStat(
        stat,
        'External capability Vault inventory directory',
      );
      total = addExternalCapabilityOccupiedBytes(
        total,
        measureExternalCapabilityRuntimeTree(entryPath),
      );
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(
        'External capability Vault inventory found a special file',
      );
    }
    if (stat.nlink !== 1) {
      throw new Error(
        'External capability Vault inventory found a multiply linked file',
      );
    }
    total = addExternalCapabilityOccupiedBytes(total, stat.size);
  }
  return total;
}

function measurePinnedRuntimeTree(directoryFd: number): number {
  let total = 0;
  for (const entryName of sortedDescriptorEntries(directoryFd)) {
    const entryFd = openDescriptorEntry(
      directoryFd,
      entryName,
      FILE_OPEN_FLAGS,
    );
    try {
      const stat = fs.fstatSync(entryFd);
      if (stat.isDirectory()) {
        assertStrictPrivateDirectoryStat(
          stat,
          'External capability Vault inventory directory',
        );
        total = addExternalCapabilityOccupiedBytes(
          total,
          measurePinnedRuntimeTree(entryFd),
        );
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(
          'External capability Vault inventory found a special file',
        );
      }
      if (stat.nlink !== 1) {
        throw new Error(
          'External capability Vault inventory found a multiply linked file',
        );
      }
      total = addExternalCapabilityOccupiedBytes(total, stat.size);
    } finally {
      fs.closeSync(entryFd);
    }
  }
  return total;
}

function inventoryPinnedManagedRoot(
  rootFd: number,
  managedRootName: 'runs' | 'runtime',
): ExternalCapabilityVaultCensusOccupancy[] {
  const managedRootFd = openDescriptorEntry(
    rootFd,
    managedRootName,
    DIRECTORY_OPEN_FLAGS,
  );
  try {
    assertStrictPrivateDirectoryStat(
      fs.fstatSync(managedRootFd),
      'External capability Vault inventory directory',
    );
    const occupancies: ExternalCapabilityVaultCensusOccupancy[] = [];
    for (const managedEntryName of sortedDescriptorEntries(managedRootFd)) {
      const managedEntryFd = openDescriptorEntry(
        managedRootFd,
        managedEntryName,
        DIRECTORY_OPEN_FLAGS,
      );
      try {
        assertStrictPrivateDirectoryStat(
          fs.fstatSync(managedEntryFd),
          'External capability Vault inventory directory',
        );
        if (managedRootName === 'runs') {
          if (!RUN_ID_PATTERN.test(managedEntryName)) {
            throw new Error(
              'External capability Vault inventory found an unknown run',
            );
          }
          for (const artifactName of sortedDescriptorEntries(managedEntryFd)) {
            if (!SAFE_ID_PATTERN.test(artifactName)) {
              throw new Error(
                'External capability Vault inventory found an unknown artifact',
              );
            }
            const artifactFd = openDescriptorEntry(
              managedEntryFd,
              artifactName,
              FILE_OPEN_FLAGS,
            );
            try {
              const artifactStat = fs.fstatSync(artifactFd);
              assertSingleLinkRegularFile(
                artifactStat,
                'External capability Vault artifact',
              );
              occupancies.push({
                runId: managedEntryName,
                kind: 'artifact',
                objectKey: artifactName,
                occupiedBytes: artifactStat.size,
              });
            } finally {
              fs.closeSync(artifactFd);
            }
          }
          continue;
        }

        const runtimeMatch = RUNTIME_DIRECTORY_PATTERN.exec(managedEntryName);
        if (!runtimeMatch?.[1]) {
          throw new Error(
            'External capability Vault inventory found an unknown runtime',
          );
        }
        occupancies.push({
          runId: runtimeMatch[1],
          kind: 'runtime',
          objectKey: managedEntryName,
          occupiedBytes: measurePinnedRuntimeTree(managedEntryFd),
        });
      } finally {
        fs.closeSync(managedEntryFd);
      }
    }
    return occupancies;
  } finally {
    fs.closeSync(managedRootFd);
  }
}

function sameFileIdentity(
  left: fs.BigIntStats,
  right: fs.BigIntStats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function makeExternalCapabilityVaultCensusIdentity(
  expectedVaultId: string,
  rootStat: fs.BigIntStats,
  sentinelStat: fs.BigIntStats,
): string {
  const identityInput = [
    expectedVaultId,
    rootStat.dev.toString(),
    rootStat.ino.toString(),
    sentinelStat.dev.toString(),
    sentinelStat.ino.toString(),
  ].join('\0');
  return `v2:${crypto.createHash('sha256').update(identityInput).digest('hex')}`;
}

function revalidatePinnedVaultIdentity(
  resolvedRoot: string,
  expectedVaultId: string,
  rootStat: fs.BigIntStats,
  sentinelStat: fs.BigIntStats,
): void {
  const currentRootFd = fs.openSync(resolvedRoot, DIRECTORY_OPEN_FLAGS);
  let currentSentinelFd: number | undefined;
  try {
    assertStrictPrivateDirectoryStat(
      fs.fstatSync(currentRootFd),
      'External capability Vault root',
    );
    const currentRootStat = fs.fstatSync(currentRootFd, { bigint: true });
    if (!sameFileIdentity(rootStat, currentRootStat)) {
      throw new Error(
        'External capability Vault root identity changed during census',
      );
    }
    const currentSentinel = openAndValidateVaultSentinel(
      currentRootFd,
      expectedVaultId,
    );
    currentSentinelFd = currentSentinel.fd;
    if (!sameFileIdentity(sentinelStat, currentSentinel.stat)) {
      throw new Error(
        'External capability Vault identity sentinel changed during census',
      );
    }
  } finally {
    if (currentSentinelFd !== undefined) fs.closeSync(currentSentinelFd);
    fs.closeSync(currentRootFd);
  }
}

/** Read and revalidate the physical identity represented by a completed census. */
export function getExternalCapabilityVaultCensusIdentity(
  vaultRoot: string,
  expectedVaultId: string,
): string {
  const resolvedRoot = validateExternalCapabilityVaultRoot(vaultRoot);
  const rootFd = fs.openSync(resolvedRoot, DIRECTORY_OPEN_FLAGS);
  let sentinelFd: number | undefined;
  try {
    assertStrictPrivateDirectoryStat(
      fs.fstatSync(rootFd),
      'External capability Vault root',
    );
    const rootStat = fs.fstatSync(rootFd, { bigint: true });
    const sentinel = openAndValidateVaultSentinel(rootFd, expectedVaultId);
    sentinelFd = sentinel.fd;
    const identity = makeExternalCapabilityVaultCensusIdentity(
      expectedVaultId,
      rootStat,
      sentinel.stat,
    );
    revalidatePinnedVaultIdentity(
      resolvedRoot,
      expectedVaultId,
      rootStat,
      sentinel.stat,
    );
    return identity;
  } finally {
    if (sentinelFd !== undefined) fs.closeSync(sentinelFd);
    fs.closeSync(rootFd);
  }
}

/**
 * Run a strict Vault census while the configured root remains pinned open.
 * The callback must be synchronous so the descriptor and identity fence cover
 * the operation that persists the census.
 */
export function withExternalCapabilityVaultCensus<T>(
  vaultRoot: string,
  expectedVaultId: string,
  callback: (census: ExternalCapabilityVaultCensus) => T,
): T {
  const resolvedRoot = validateExternalCapabilityVaultRoot(vaultRoot);
  const rootFd = fs.openSync(resolvedRoot, DIRECTORY_OPEN_FLAGS);
  let sentinelFd: number | undefined;
  try {
    const rootStatForValidation = fs.fstatSync(rootFd);
    assertStrictPrivateDirectoryStat(
      rootStatForValidation,
      'External capability Vault root',
    );
    const rootStat = fs.fstatSync(rootFd, { bigint: true });
    const sentinel = openAndValidateVaultSentinel(rootFd, expectedVaultId);
    sentinelFd = sentinel.fd;

    const occupancies: ExternalCapabilityVaultCensusOccupancy[] = [];
    for (const rootEntryName of sortedDescriptorEntries(rootFd)) {
      if (rootEntryName === VAULT_ID_SENTINEL_NAME) continue;
      if (rootEntryName !== 'runs' && rootEntryName !== 'runtime') {
        throw new Error(
          'External capability Vault inventory found an unknown root entry',
        );
      }
      occupancies.push(...inventoryPinnedManagedRoot(rootFd, rootEntryName));
    }
    occupancies.sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.runId.localeCompare(right.runId) ||
        left.objectKey.localeCompare(right.objectKey),
    );
    const census: ExternalCapabilityVaultCensus = {
      identity: makeExternalCapabilityVaultCensusIdentity(
        expectedVaultId,
        rootStat,
        sentinel.stat,
      ),
      occupancies,
    };
    const result = callback(census);
    if (
      typeof result === 'object' &&
      result !== null &&
      'then' in result &&
      typeof result.then === 'function'
    ) {
      throw new Error(
        'External capability Vault census callback must be synchronous',
      );
    }
    revalidatePinnedVaultIdentity(
      resolvedRoot,
      expectedVaultId,
      rootStat,
      sentinel.stat,
    );
    return result;
  } finally {
    if (sentinelFd !== undefined) fs.closeSync(sentinelFd);
    fs.closeSync(rootFd);
  }
}

export const withPinnedExternalCapabilityVaultCensus =
  withExternalCapabilityVaultCensus;

export function censusExternalCapabilityVault(
  vaultRoot: string,
  expectedVaultId: string,
  callback: (census: ExternalCapabilityVaultCensus) => void = () => undefined,
): ExternalCapabilityVaultCensus {
  return withExternalCapabilityVaultCensus(
    vaultRoot,
    expectedVaultId,
    (census) => {
      callback(census);
      return census;
    },
  );
}

/** Measure one exact server-generated runtime tree without following links. */
export function measureExternalCapabilityRuntimeStorageBytes(
  vaultRoot: string,
  runtimeName: string,
): number {
  if (!RUNTIME_DIRECTORY_PATTERN.test(runtimeName)) {
    throw new Error(
      'External capability runtime directory must be server-generated',
    );
  }
  const resolvedRoot = validateExternalCapabilityVaultRoot(vaultRoot);
  const runtimeRoot = path.join(resolvedRoot, 'runtime');
  const runtimeDirectory = path.join(runtimeRoot, runtimeName);
  assertStrictPrivateDirectory(resolvedRoot);
  assertStrictPrivateDirectory(runtimeRoot);
  assertStrictPrivateDirectory(runtimeDirectory);
  return measureExternalCapabilityRuntimeTree(runtimeDirectory);
}

function inventoryLegacyExternalCapabilityVault(
  resolvedRoot: string,
): ExternalCapabilityLegacyVaultOccupancy[] {
  assertStrictPrivateDirectory(resolvedRoot);
  const occupancies: ExternalCapabilityLegacyVaultOccupancy[] = [];
  for (const topLevelEntry of fs.readdirSync(resolvedRoot, {
    withFileTypes: true,
  })) {
    if (topLevelEntry.name === VAULT_ID_SENTINEL_NAME) {
      const sentinelStat = fs.lstatSync(
        path.join(resolvedRoot, VAULT_ID_SENTINEL_NAME),
      );
      if (sentinelStat.isSymbolicLink()) {
        throw new Error(
          'External capability Vault inventory found a symbolic link',
        );
      }
      assertSingleLinkRegularFile(
        sentinelStat,
        'External capability Vault identity sentinel',
      );
      assertSafeOwnerAndMode(
        sentinelStat,
        'External capability Vault identity sentinel',
      );
      if (sentinelStat.size > MAX_VAULT_ID_BYTES) {
        throw new Error(
          'External capability Vault identity sentinel exceeds its size limit',
        );
      }
      continue;
    }
    if (topLevelEntry.name !== 'runs' && topLevelEntry.name !== 'runtime') {
      throw new Error(
        'External capability Vault inventory found an unknown root entry',
      );
    }
    const managedRoot = path.join(resolvedRoot, topLevelEntry.name);
    assertStrictPrivateDirectory(managedRoot);

    for (const managedEntry of fs.readdirSync(managedRoot, {
      withFileTypes: true,
    })) {
      const managedPath = path.join(managedRoot, managedEntry.name);
      assertStrictPrivateDirectory(managedPath);

      if (topLevelEntry.name === 'runs') {
        if (!RUN_ID_PATTERN.test(managedEntry.name)) {
          throw new Error(
            'External capability Vault inventory found an unknown run',
          );
        }
        let occupiedBytes = 0;
        for (const artifact of fs.readdirSync(managedPath, {
          withFileTypes: true,
        })) {
          if (!SAFE_ID_PATTERN.test(artifact.name)) {
            throw new Error(
              'External capability Vault inventory found an unknown artifact',
            );
          }
          const artifactPath = path.join(managedPath, artifact.name);
          const stat = fs.lstatSync(artifactPath);
          if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error(
              'External capability Vault inventory found a non-file artifact',
            );
          }
          if (stat.nlink !== 1) {
            throw new Error(
              'External capability Vault inventory found a multiply linked file',
            );
          }
          occupiedBytes = addExternalCapabilityOccupiedBytes(
            occupiedBytes,
            stat.size,
          );
        }
        occupancies.push({
          runId: managedEntry.name,
          kind: 'input',
          objectKey: EXTERNAL_CAPABILITY_LEGACY_RUN_OBJECT_KEY,
          occupiedBytes,
        });
        continue;
      }

      const runtimeMatch = RUNTIME_DIRECTORY_PATTERN.exec(managedEntry.name);
      if (!runtimeMatch?.[1]) {
        throw new Error(
          'External capability Vault inventory found an unknown runtime',
        );
      }
      occupancies.push({
        runId: runtimeMatch[1],
        kind: 'runtime',
        objectKey: managedEntry.name,
        occupiedBytes: measureExternalCapabilityRuntimeTree(managedPath),
      });
    }
  }

  return occupancies.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.runId.localeCompare(right.runId) ||
      left.objectKey.localeCompare(right.objectKey),
  );
}

/**
 * Strict startup inventory for pre-ledger Vault bytes. Passing the expected
 * Vault ID selects the descriptor-pinned v2 census and individual artifacts;
 * the one-argument overload preserves the legacy aggregate for old callers.
 */
export function inventoryExternalCapabilityVault(
  vaultRoot: string,
): ExternalCapabilityLegacyVaultOccupancy[];
export function inventoryExternalCapabilityVault(
  vaultRoot: string,
  expectedVaultId: string,
): ExternalCapabilityVaultCensusOccupancy[];
export function inventoryExternalCapabilityVault(
  vaultRoot: string,
  expectedVaultId?: string,
):
  | ExternalCapabilityLegacyVaultOccupancy[]
  | ExternalCapabilityVaultCensusOccupancy[] {
  const resolvedRoot = validateExternalCapabilityVaultRoot(vaultRoot);
  if (expectedVaultId !== undefined) {
    return censusExternalCapabilityVault(resolvedRoot, expectedVaultId)
      .occupancies;
  }
  return inventoryLegacyExternalCapabilityVault(resolvedRoot);
}

function getExistingRunDirectory(root: string, runId: string): string {
  const resolvedRoot = validateExternalCapabilityVaultRoot(root);
  const runsDirectory = path.join(resolvedRoot, 'runs');
  const runDirectory = path.join(runsDirectory, runId);
  if (!pathIsInside(resolvedRoot, runDirectory)) {
    throw new Error('External capability vault path escaped its root');
  }
  assertExistingPrivateDirectory(resolvedRoot);
  assertExistingPrivateDirectory(runsDirectory);
  assertExistingPrivateDirectory(runDirectory);
  return runDirectory;
}

function getExistingManagedDirectory(
  root: string,
  name: 'runs' | 'runtime',
): string | null {
  const resolvedRoot = validateExternalCapabilityVaultRoot(root);
  const directory = path.join(resolvedRoot, name);
  if (!pathIsInside(resolvedRoot, directory)) {
    throw new Error('External capability vault path escaped its root');
  }
  try {
    assertExistingPrivateDirectory(resolvedRoot);
    assertExistingPrivateDirectory(directory);
    return directory;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function listManagedDirectories(
  vaultRoot: string,
  name: 'runs' | 'runtime',
  pattern: RegExp,
): ExternalCapabilityManagedDirectory[] {
  const parent = getExistingManagedDirectory(vaultRoot, name);
  if (!parent) return [];
  const directories: ExternalCapabilityManagedDirectory[] = [];
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    const match = pattern.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(parent, entry.name);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    directories.push({
      name: entry.name,
      runId: match[1] ?? entry.name,
      mtimeMs: stat.mtimeMs,
    });
  }
  return directories;
}

async function* iterateManagedDirectories(
  vaultRoot: string,
  name: 'runs' | 'runtime',
  pattern: RegExp,
): AsyncGenerator<ExternalCapabilityManagedDirectory> {
  const parent = getExistingManagedDirectory(vaultRoot, name);
  if (!parent) return;
  let directory: fs.Dir;
  try {
    directory = await fs.promises.opendir(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for await (const entry of directory) {
    const match = pattern.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const entryPath = path.join(parent, entry.name);
    try {
      const stat = await fs.promises.lstat(entryPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      yield {
        name: entry.name,
        runId: match[1] ?? entry.name,
        mtimeMs: stat.mtimeMs,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}

function makeStorageRef(runId: string, artifactId: string): string {
  return `${REF_PREFIX}:${runId}:${artifactId}`;
}

function parseStorageRef(storageRef: string): {
  runId: string;
  artifactId: string;
} {
  const parts = storageRef.split(':');
  if (parts.length !== 3 || parts[0] !== REF_PREFIX) {
    throw new Error('Invalid external capability storage reference');
  }
  return {
    runId: ensureSafeId(parts[1], 'storage reference run ID'),
    artifactId: ensureSafeId(parts[2], 'storage reference artifact ID'),
  };
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0)
      throw new Error('Could not write external capability artifact');
    offset += written;
  }
}

function readAll(fd: number, byteLength: number): Buffer {
  const bytes = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const read = fs.readSync(fd, bytes, offset, byteLength - offset, offset);
    if (read <= 0) {
      throw new ExternalCapabilityArtifactIntegrityError(
        'External capability artifact ended unexpectedly',
      );
    }
    offset += read;
  }
  return bytes;
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
  );
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncArtifactPathAncestors(
  vaultRoot: string,
  runDirectory: string,
): void {
  const resolvedRoot = path.resolve(vaultRoot);
  fsyncDirectory(runDirectory);
  fsyncDirectory(path.dirname(runDirectory));
  fsyncDirectory(resolvedRoot);
  fsyncDirectory(path.dirname(resolvedRoot));
}

function assertStrictDescriptorTreeBeforeDelete(
  directoryFd: number,
  artifactsOnly: boolean,
): void {
  assertStrictPrivateDirectoryStat(
    fs.fstatSync(directoryFd),
    'External capability Vault deletion directory',
  );
  for (const entryName of sortedDescriptorEntries(directoryFd)) {
    if (artifactsOnly && !SAFE_ID_PATTERN.test(entryName)) {
      throw new Error(
        'External capability Vault deletion found an unknown artifact',
      );
    }
    const entryFd = openDescriptorEntry(
      directoryFd,
      entryName,
      FILE_OPEN_FLAGS,
    );
    try {
      const stat = fs.fstatSync(entryFd);
      if (stat.isDirectory()) {
        if (artifactsOnly) {
          throw new Error(
            'External capability Vault deletion found a non-file artifact',
          );
        }
        assertStrictDescriptorTreeBeforeDelete(entryFd, false);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(
          'External capability Vault deletion found a special file',
        );
      }
      if (stat.nlink !== 1) {
        throw new Error(
          'External capability Vault deletion found a multiply linked file',
        );
      }
    } finally {
      fs.closeSync(entryFd);
    }
  }
}

function assertStrictTreeBeforeDelete(
  directory: string,
  artifactsOnly: boolean,
): void {
  const directoryFd = fs.openSync(directory, DIRECTORY_OPEN_FLAGS);
  try {
    assertStrictDescriptorTreeBeforeDelete(directoryFd, artifactsOnly);
  } finally {
    fs.closeSync(directoryFd);
  }
}

/**
 * Stores one immutable private document. The returned reference is opaque and
 * deliberately cannot be used as a filesystem path or public download URL.
 */
export function storeExternalCapabilityArtifact(
  vaultRoot: string,
  input: StoreExternalCapabilityArtifactInput,
): StoredExternalCapabilityArtifact {
  const runId = ensureSafeId(input.runId, 'runId');
  const artifactId = ensureSafeId(input.artifactId, 'artifactId');
  const bytes = Buffer.from(input.bytes);
  const runDirectory = getRunDirectory(vaultRoot, runId);
  const artifactPath = path.join(runDirectory, artifactId);
  const storageRef = makeStorageRef(runId, artifactId);
  let fd: number | undefined;
  let created = false;

  try {
    fd = fs.openSync(
      artifactPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    writeAll(fd, bytes);
    fs.fsyncSync(fd);
    const createdStat = fs.fstatSync(fd);
    assertSingleLinkRegularFile(
      createdStat,
      'External capability artifact created by the Vault',
    );
    fs.closeSync(fd);
    fd = undefined;
    fsyncArtifactPathAncestors(vaultRoot, runDirectory);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    // The object name is server-generated and O_EXCL prevents overwrites. Only
    // remove an object this invocation created; a duplicate must keep its
    // already-committed bytes intact.
    if (created) {
      try {
        fs.unlinkSync(artifactPath);
        fsyncDirectory(runDirectory);
      } catch {
        // The parent was concurrently removed after the failed write.
      }
    }
    throw error;
  }

  return {
    storageRef,
    byteLength: bytes.byteLength,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

/** Remove a run's private input and output artifacts without following links. */
export function deleteExternalCapabilityRunArtifacts(
  vaultRoot: string,
  runId: string,
): void {
  const safeRunId = ensureSafeId(runId, 'runId');
  let runDirectory: string;
  try {
    runDirectory = getExistingRunDirectory(vaultRoot, safeRunId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const runsDirectory = path.dirname(runDirectory);
  assertStrictTreeBeforeDelete(runDirectory, true);
  fs.rmSync(runDirectory, { recursive: true, force: true });
  fsyncDirectory(runsDirectory);
}

export async function deleteExternalCapabilityRunArtifactsAsync(
  vaultRoot: string,
  runId: string,
): Promise<void> {
  const safeRunId = ensureSafeId(runId, 'runId');
  let runDirectory: string;
  try {
    runDirectory = getExistingRunDirectory(vaultRoot, safeRunId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const runsDirectory = path.dirname(runDirectory);
  assertStrictTreeBeforeDelete(runDirectory, true);
  await fs.promises.rm(runDirectory, { recursive: true, force: true });
  fsyncDirectory(runsDirectory);
}

export function externalCapabilityRunArtifactsExist(
  vaultRoot: string,
  runId: string,
): boolean {
  const safeRunId = ensureSafeId(runId, 'runId');
  try {
    getExistingRunDirectory(vaultRoot, safeRunId);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function externalCapabilityRuntimeDirectoryExists(
  vaultRoot: string,
  directoryName: string,
): boolean {
  if (!RUNTIME_DIRECTORY_PATTERN.test(directoryName)) {
    throw new Error(
      'External capability runtime directory must be server-generated',
    );
  }
  try {
    const parent = getExistingManagedDirectory(vaultRoot, 'runtime');
    if (!parent) return false;
    const stat = fs.lstatSync(path.join(parent, directoryName));
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        'External capability runtime path must be a real directory',
      );
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function externalCapabilityArtifactExists(
  vaultRoot: string,
  runId: string,
  artifactId: string,
): boolean {
  const safeRunId = ensureSafeId(runId, 'runId');
  const safeArtifactId = ensureSafeId(artifactId, 'artifactId');
  try {
    const runDirectory = getExistingRunDirectory(vaultRoot, safeRunId);
    const stat = fs.lstatSync(path.join(runDirectory, safeArtifactId));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('External capability artifact must be a regular file');
    }
    if (stat.nlink !== 1) {
      throw new Error('External capability artifact must not be hard linked');
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function listExternalCapabilityRunDirectories(
  vaultRoot: string,
): ExternalCapabilityManagedDirectory[] {
  return listManagedDirectories(vaultRoot, 'runs', RUN_ID_PATTERN);
}

export function iterateExternalCapabilityRunDirectories(
  vaultRoot: string,
): AsyncGenerator<ExternalCapabilityManagedDirectory> {
  return iterateManagedDirectories(vaultRoot, 'runs', RUN_ID_PATTERN);
}

export function listExternalCapabilityRuntimeDirectories(
  vaultRoot: string,
): ExternalCapabilityManagedDirectory[] {
  return listManagedDirectories(
    vaultRoot,
    'runtime',
    RUNTIME_DIRECTORY_PATTERN,
  );
}

export function iterateExternalCapabilityRuntimeDirectories(
  vaultRoot: string,
): AsyncGenerator<ExternalCapabilityManagedDirectory> {
  return iterateManagedDirectories(
    vaultRoot,
    'runtime',
    RUNTIME_DIRECTORY_PATTERN,
  );
}

export function deleteExternalCapabilityRuntimeDirectory(
  vaultRoot: string,
  directoryName: string,
): void {
  if (!RUNTIME_DIRECTORY_PATTERN.test(directoryName)) {
    throw new Error(
      'External capability runtime directory must be server-generated',
    );
  }
  const parent = getExistingManagedDirectory(vaultRoot, 'runtime');
  if (!parent) return;
  const directory = path.join(parent, directoryName);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      'External capability runtime path must be a real directory',
    );
  }
  assertStrictTreeBeforeDelete(directory, false);
  fs.rmSync(directory, { recursive: true, force: true });
  fsyncDirectory(parent);
}

export async function deleteExternalCapabilityRuntimeDirectoryAsync(
  vaultRoot: string,
  directoryName: string,
): Promise<void> {
  if (!RUNTIME_DIRECTORY_PATTERN.test(directoryName)) {
    throw new Error(
      'External capability runtime directory must be server-generated',
    );
  }
  const parent = getExistingManagedDirectory(vaultRoot, 'runtime');
  if (!parent) return;
  const directory = path.join(parent, directoryName);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      'External capability runtime path must be a real directory',
    );
  }
  assertStrictTreeBeforeDelete(directory, false);
  await fs.promises.rm(directory, { recursive: true, force: true });
  fsyncDirectory(parent);
}

export function deleteExternalCapabilityArtifact(
  vaultRoot: string,
  storageRef: string,
): void {
  const { runId, artifactId } = parseStorageRef(storageRef);
  try {
    const runDirectory = getExistingRunDirectory(vaultRoot, runId);
    const artifactPath = path.join(runDirectory, artifactId);
    const stat = fs.lstatSync(artifactPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('External capability artifact is not a regular file');
    }
    if (stat.nlink !== 1) {
      throw new Error('External capability artifact must not be hard linked');
    }
    fs.unlinkSync(artifactPath);
    fsyncDirectory(runDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

/**
 * Opens a private object without following links, checks its regular-file
 * identity and verifies its immutable metadata before returning bytes to a
 * future isolated runner.
 */
export function readExternalCapabilityArtifact(
  vaultRoot: string,
  input: ReadExternalCapabilityArtifactInput,
): Buffer {
  let storageIdentity: { runId: string; artifactId: string };
  try {
    storageIdentity = parseStorageRef(input.storageRef);
  } catch {
    throw new ExternalCapabilityArtifactIntegrityError(
      'External capability artifact reference is invalid',
    );
  }
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) {
    throw new ExternalCapabilityArtifactIntegrityError(
      'External capability artifact has an invalid byte length',
    );
  }
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) {
    throw new ExternalCapabilityArtifactIntegrityError(
      'External capability artifact has an invalid SHA-256 digest',
    );
  }

  let fd: number | undefined;
  try {
    const runDirectory = getExistingRunDirectory(
      vaultRoot,
      storageIdentity.runId,
    );
    const artifactPath = path.join(runDirectory, storageIdentity.artifactId);
    fd = fs.openSync(artifactPath, FILE_OPEN_FLAGS);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new ExternalCapabilityArtifactIntegrityError(
        'External capability artifact is not a regular file',
      );
    }
    if (stat.nlink !== 1) {
      throw new ExternalCapabilityArtifactIntegrityError(
        'External capability artifact must not be hard linked',
      );
    }
    if (stat.size !== input.byteLength) {
      throw new ExternalCapabilityArtifactIntegrityError(
        'External capability artifact byte length no longer matches',
      );
    }
    const bytes = readAll(fd, input.byteLength);
    const actualDigest = crypto
      .createHash('sha256')
      .update(bytes)
      .digest('hex');
    if (
      !crypto.timingSafeEqual(
        Buffer.from(actualDigest),
        Buffer.from(input.sha256),
      )
    ) {
      throw new ExternalCapabilityArtifactIntegrityError(
        'External capability artifact digest no longer matches',
      );
    }
    return bytes;
  } catch (error) {
    if (error instanceof ExternalCapabilityArtifactIntegrityError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') {
      throw new ExternalCapabilityArtifactIntegrityError(
        'External capability artifact is unavailable',
      );
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
