import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import { getInstallationId } from './instance-ownership.js';
import { ensureDirectoryTreeNoSymlinks } from './utils.js';

const MARKER_VERSION = 1;
const DEFAULT_CREATE_WINDOW_MS = 30_000;
const MAX_CREATE_WINDOW_MS = 5 * 60_000;

export type OrdinaryContainerCreateFence = {
  containerName: string;
  expiresAt: number;
  markerPath: string;
};

function markerDirectory(): string {
  return ensureDirectoryTreeNoSymlinks(
    DATA_DIR,
    path.join(DATA_DIR, 'container-create-pending'),
  );
}

function markerFileName(containerName: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(containerName)) {
    throw new Error('Invalid Docker container name');
  }
  return `${containerName}.json`;
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function createOrdinaryContainerCreateFence(
  containerName: string,
  createWindowMs = DEFAULT_CREATE_WINDOW_MS,
): OrdinaryContainerCreateFence {
  if (
    !Number.isSafeInteger(createWindowMs) ||
    createWindowMs <= 0 ||
    createWindowMs > MAX_CREATE_WINDOW_MS
  ) {
    throw new Error('Invalid ordinary container create window');
  }
  const directory = markerDirectory();
  const markerPath = path.join(directory, markerFileName(containerName));
  const expiresAt = Date.now() + createWindowMs;
  const payload = `${JSON.stringify({
    version: MARKER_VERSION,
    installationId: getInstallationId(),
    containerName,
    expiresAt,
  })}\n`;
  const fd = fs.openSync(
    markerPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  );
  try {
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectory(directory);
  return { containerName, expiresAt, markerPath };
}

export function clearOrdinaryContainerCreateFence(
  fence: OrdinaryContainerCreateFence,
): void {
  const directory = markerDirectory();
  const expectedPath = path.join(
    directory,
    markerFileName(fence.containerName),
  );
  if (path.resolve(expectedPath) !== path.resolve(fence.markerPath)) {
    throw new Error('Ordinary container create fence path changed');
  }
  try {
    fs.unlinkSync(expectedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  fsyncDirectory(directory);
}

export function listOrdinaryContainerCreateFences(): OrdinaryContainerCreateFence[] {
  const directory = markerDirectory();
  const installationId = getInstallationId();
  const fences: OrdinaryContainerCreateFence[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      throw new Error('Invalid ordinary container create fence entry');
    }
    const markerPath = path.join(directory, entry.name);
    const stat = fs.lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Invalid ordinary container create fence file');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    } catch {
      throw new Error('Invalid ordinary container create fence payload');
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error('Invalid ordinary container create fence payload');
    }
    const record = parsed as Record<string, unknown>;
    const containerName = record.containerName;
    const expiresAt = record.expiresAt;
    if (
      record.version !== MARKER_VERSION ||
      record.installationId !== installationId ||
      typeof containerName !== 'string' ||
      entry.name !== markerFileName(containerName) ||
      typeof expiresAt !== 'number' ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= 0
    ) {
      throw new Error('Invalid ordinary container create fence payload');
    }
    fences.push({ containerName, expiresAt, markerPath });
  }
  return fences.sort((left, right) => left.expiresAt - right.expiresAt);
}
