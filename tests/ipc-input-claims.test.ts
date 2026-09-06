import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { IpcInputClaimStore } from '../container/agent-runner/src/ipc-input-claims.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-ipc-claim-'));
  tempDirs.push(dir);
  return dir;
}

describe('IpcInputClaimStore', () => {
  test('keeps a claimed input durable until registration acknowledges it', () => {
    const dir = tempDir();
    const original = path.join(dir, '001.json');
    fs.writeFileSync(original, JSON.stringify({ type: 'message', text: 'hi' }));

    const firstRunner = new IpcInputClaimStore(dir);
    const [claim] = firstRunner.claimAvailable();
    expect(claim).toBeTruthy();
    expect(fs.existsSync(original)).toBe(false);
    expect(fs.existsSync(claim)).toBe(true);
    expect(firstRunner.claimAvailable()).toEqual([]);

    // A concurrently overlapping Runner must not steal a live claim.
    const replacementRunner = new IpcInputClaimStore(dir);
    expect(replacementRunner.claimAvailable()).toEqual([]);

    // Once the short ownership lease expires, a replacement Runner atomically
    // reclaims the crash residue under its own claim path.
    const crashedRunnerRecovery = new IpcInputClaimStore(dir, 0);
    const [recoveredClaim] = crashedRunnerRecovery.claimAvailable();
    expect(recoveredClaim).toBeTruthy();
    expect(recoveredClaim).not.toBe(claim);
    expect(fs.existsSync(claim)).toBe(false);
    expect(crashedRunnerRecovery.acknowledge([recoveredClaim])).toEqual([]);
    expect(fs.existsSync(recoveredClaim)).toBe(false);
  });

  test('acknowledges an entire registered batch without duplicate claims', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, '001.json'), '{}');
    fs.writeFileSync(path.join(dir, '002.json'), '{}');
    const store = new IpcInputClaimStore(dir);
    const claims = store.claimAvailable();
    expect(claims).toHaveLength(2);
    expect(store.acknowledge(claims)).toEqual([]);
    expect(store.claimAvailable()).toEqual([]);
  });

  test('only one replacement Runner wins an expired claim', () => {
    const dir = tempDir();
    const original = path.join(dir, '001.json');
    fs.writeFileSync(original, '{}');
    const owner = new IpcInputClaimStore(dir);
    const [claim] = owner.claimAvailable();
    const expiredClaim = `${original}.happyclaw-claimed-999-legacy`;
    fs.renameSync(claim, expiredClaim);
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(expiredClaim, stale, stale);

    const replacementA = new IpcInputClaimStore(dir);
    const replacementB = new IpcInputClaimStore(dir);
    const claimedA = replacementA.claimAvailable();
    const claimedB = replacementB.claimAvailable();
    expect(claimedA).toHaveLength(1);
    expect(claimedB).toEqual([]);
    replacementA.acknowledge(claimedA);
  });
});
