import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REF_PREFIX = 'ecv1';
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNTIME_DIRECTORY_PATTERN = new RegExp(
  `^(${RUN_ID_PATTERN.source.slice(1, -1)})-[A-Za-z0-9]{6}$`,
  'i',
);

export interface ExternalCapabilityManagedDirectory {
  name: string;
  runId: string;
  mtimeMs: number;
}

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
export function probeExternalCapabilityVault(vaultRoot: string): void {
  const runId = crypto.randomUUID();
  const artifactId = `readiness-${crypto.randomUUID()}`;
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
    if (read <= 0)
      throw new Error('External capability artifact ended unexpectedly');
    offset += read;
  }
  return bytes;
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
    fs.closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    // The object name is server-generated and O_EXCL prevents overwrites. Only
    // remove an object this invocation created; a duplicate must keep its
    // already-committed bytes intact.
    if (created) {
      try {
        fs.unlinkSync(artifactPath);
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
  try {
    const runDirectory = getExistingRunDirectory(vaultRoot, safeRunId);
    fs.rmSync(runDirectory, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

export function listExternalCapabilityRunDirectories(
  vaultRoot: string,
): ExternalCapabilityManagedDirectory[] {
  return listManagedDirectories(vaultRoot, 'runs', RUN_ID_PATTERN);
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

export function deleteExternalCapabilityRuntimeDirectory(
  vaultRoot: string,
  directoryName: string,
): void {
  if (!RUNTIME_DIRECTORY_PATTERN.test(directoryName)) {
    throw new Error(
      'External capability runtime directory must be server-generated',
    );
  }
  try {
    const parent = getExistingManagedDirectory(vaultRoot, 'runtime');
    if (!parent) return;
    const directory = path.join(parent, directoryName);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        'External capability runtime path must be a real directory',
      );
    }
    fs.rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
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
    fs.unlinkSync(artifactPath);
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
  const { runId, artifactId } = parseStorageRef(input.storageRef);
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) {
    throw new Error('External capability artifact has an invalid byte length');
  }
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) {
    throw new Error(
      'External capability artifact has an invalid SHA-256 digest',
    );
  }
  const runDirectory = getExistingRunDirectory(vaultRoot, runId);
  const artifactPath = path.join(runDirectory, artifactId);
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      artifactPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error('External capability artifact is not a regular file');
    }
    if (stat.size !== input.byteLength) {
      throw new Error(
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
      throw new Error('External capability artifact digest no longer matches');
    }
    return bytes;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
