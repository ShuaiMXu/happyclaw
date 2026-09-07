import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const CLAIM_MARKER = '.happyclaw-claimed-';
const DEFAULT_CLAIM_LEASE_MS = 10_000;

function isInputJsonOrClaim(filename: string): boolean {
  return (
    filename.endsWith('.json') || filename.includes(`.json${CLAIM_MARKER}`)
  );
}

function claimCreatedAt(filename: string, fallbackMtimeMs: number): number {
  const markerIndex = filename.indexOf(`.json${CLAIM_MARKER}`);
  if (markerIndex < 0) return fallbackMtimeMs;
  const suffix = filename.slice(markerIndex + `.json${CLAIM_MARKER}`.length);
  const match = suffix.match(/^\d+-(\d+)-/);
  const encoded = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(encoded) ? encoded : fallbackMtimeMs;
}

/**
 * Crash-recoverable ownership for Runner IPC inputs.
 *
 * A normal input is atomically renamed to a claim before it is read. The claim
 * stays on disk until the input has been synchronously registered in the
 * in-memory delivery tracker. If the process dies in between, a new Runner
 * discovers and reclaims the durable file instead of losing the message.
 */
export class IpcInputClaimStore {
  private readonly activeClaims = new Set<string>();

  constructor(
    private readonly inputDir: string,
    private readonly claimLeaseMs: number = DEFAULT_CLAIM_LEASE_MS,
  ) {}

  claimAvailable(): string[] {
    fs.mkdirSync(this.inputDir, { recursive: true });
    const files = fs
      .readdirSync(this.inputDir)
      .filter(isInputJsonOrClaim)
      .sort();
    const claimed: string[] = [];

    for (const filename of files) {
      const existingPath = path.join(this.inputDir, filename);
      if (this.activeClaims.has(existingPath)) continue;

      const jsonEnd = filename.indexOf('.json') + '.json'.length;
      const alreadyClaimed = filename.includes(`.json${CLAIM_MARKER}`);
      if (alreadyClaimed) {
        // Another live Runner may be between claim and synchronous tracker
        // registration. Never read its claim in place. A crashed owner's lease
        // becomes recoverable after a short bounded delay and must still be
        // atomically renamed, so two replacement processes cannot both own it.
        let stat: fs.Stats;
        try {
          stat = fs.statSync(existingPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw err;
        }
        if (
          Date.now() - claimCreatedAt(filename, stat.mtimeMs) <
          this.claimLeaseMs
        )
          continue;
      }

      const originalName = filename.slice(0, jsonEnd);
      const claimPath = path.join(
        this.inputDir,
        `${originalName}${CLAIM_MARKER}${process.pid}-${Date.now()}-${randomUUID()}`,
      );
      try {
        fs.renameSync(existingPath, claimPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }

      this.activeClaims.add(claimPath);
      claimed.push(claimPath);
    }
    return claimed;
  }

  /** Delete claims only after their messages have a recovery owner. */
  acknowledge(claimPaths: readonly string[]): string[] {
    const failed: string[] = [];
    for (const claimPath of new Set(claimPaths)) {
      if (!claimPath) continue;
      try {
        fs.unlinkSync(claimPath);
        this.activeClaims.delete(claimPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          this.activeClaims.delete(claimPath);
          continue;
        }
        failed.push(claimPath);
      }
    }
    return failed;
  }

  /** Invalid/poison files cannot become a message; remove them explicitly. */
  discard(claimPath: string): boolean {
    return this.acknowledge([claimPath]).length === 0;
  }
}
