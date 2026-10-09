import { afterEach, describe, expect, test, vi } from 'vitest';

const settings = vi.hoisted(() => ({ maxConcurrentContainers: 1 }));

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/container-runner.js', () => ({ killProcessTree: () => {} }));

vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({
    maxConcurrentContainers: settings.maxConcurrentContainers,
    maxConcurrentHostProcesses: 1,
  }),
}));

vi.mock('../src/db.js', () => ({ getTaskById: () => undefined }));

const { GroupQueue } = await import('../src/group-queue.js');

type Queue = InstanceType<typeof GroupQueue>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const queues: Queue[] = [];
const gates: Array<() => void> = [];

function createQueue(): Queue {
  const queue = new GroupQueue();
  queue.setHostModeChecker(() => false);
  queues.push(queue);
  return queue;
}

afterEach(async () => {
  for (const release of gates.splice(0)) release();
  await tick();
  await tick();
  settings.maxConcurrentContainers = 1;
  queues.splice(0);
});

describe('GroupQueue detached container capacity', () => {
  test('fences queued Docker launches until survivor accounting is ready', async () => {
    const queue = createQueue();
    queue.setContainerAdmissionReady(false);
    const gate = deferred();
    gates.push(gate.resolve);
    const started: string[] = [];

    queue.enqueueTask('web:normal', 'normal-task', async () => {
      started.push('normal');
      await gate.promise;
    });
    await tick();
    expect(started).toEqual([]);

    const releaseSurvivor = queue.adoptDetachedContainerSlot('web:external');
    queue.setContainerAdmissionReady(true);
    await tick();
    expect(started).toEqual([]);
    expect(queue.getStatus()).toMatchObject({
      activeContainerCount: 1,
      waitingCount: 1,
    });

    releaseSurvivor();
    await tick();
    expect(started).toEqual(['normal']);
  });

  test('holds the shared global slot and wakes queued container work on release', async () => {
    const queue = createQueue();
    const releaseDetached =
      queue.tryAcquireDetachedContainerSlot('web:external');
    expect(releaseDetached).not.toBeNull();

    const gate = deferred();
    gates.push(gate.resolve);
    const started: string[] = [];
    queue.enqueueTask('web:normal', 'normal-task', async () => {
      started.push('normal');
      await gate.promise;
    });

    await tick();
    expect(started).toEqual([]);
    expect(queue.getStatus()).toMatchObject({
      activeContainerCount: 1,
      waitingCount: 1,
    });

    releaseDetached?.();
    await tick();
    expect(started).toEqual(['normal']);
    expect(queue.getStatus()).toMatchObject({
      activeContainerCount: 1,
      waitingCount: 0,
    });
  });

  test('denies detached work while a normal container owns the final slot', async () => {
    const queue = createQueue();
    const gate = deferred();
    gates.push(gate.resolve);

    queue.enqueueTask('web:normal', 'normal-task', async () => {
      await gate.promise;
    });
    expect(queue.getStatus().activeContainerCount).toBe(1);
    expect(queue.tryAcquireDetachedContainerSlot('web:external')).toBeNull();

    gate.resolve();
    await tick();
    await tick();
    const releaseDetached =
      queue.tryAcquireDetachedContainerSlot('web:external');
    expect(releaseDetached).not.toBeNull();
    releaseDetached?.();
  });

  test('includes detached reservations in per-user billing admission', () => {
    settings.maxConcurrentContainers = 4;
    const queue = createQueue();
    const ownerByJid: Record<string, string> = {
      'web:a-1': 'owner-a',
      'web:a-2': 'owner-a',
      'web:b-1': 'owner-b',
    };
    queue.setUserConcurrentLimitChecker((candidateJid) => {
      const owner = ownerByJid[candidateJid];
      let active = 0;
      for (const [jid, jidOwner] of Object.entries(ownerByJid)) {
        if (jidOwner !== owner) continue;
        if (queue.hasDirectActiveRunner(jid)) active += 1;
        active += queue.countActiveTaskRunners(jid);
        active += queue.countDetachedContainerSlots(jid);
      }
      return { allowed: active < 1 };
    });

    const releaseA = queue.tryAcquireDetachedContainerSlot('web:a-1');
    expect(releaseA).not.toBeNull();
    expect(queue.tryAcquireDetachedContainerSlot('web:a-2')).toBeNull();

    const releaseB = queue.tryAcquireDetachedContainerSlot('web:b-1');
    expect(releaseB).not.toBeNull();
    expect(queue.getStatus().activeContainerCount).toBe(2);

    releaseA?.();
    releaseB?.();
  });

  test('counts adopted containers against per-user billing admission', () => {
    settings.maxConcurrentContainers = 4;
    const queue = createQueue();
    const ownerByJid: Record<string, string> = {
      'web:a-1': 'owner-a',
      'web:a-2': 'owner-a',
    };
    queue.setUserConcurrentLimitChecker((candidateJid) => {
      const owner = ownerByJid[candidateJid];
      let active = 0;
      for (const [jid, jidOwner] of Object.entries(ownerByJid)) {
        if (jidOwner === owner) {
          active += queue.countDetachedContainerSlots(jid);
        }
      }
      return { allowed: active < 1 };
    });

    const releaseAdopted = queue.adoptDetachedContainerSlot('web:a-1');
    expect(queue.tryAcquireDetachedContainerSlot('web:a-2')).toBeNull();
    releaseAdopted();
    const releaseNew = queue.tryAcquireDetachedContainerSlot('web:a-2');
    expect(releaseNew).not.toBeNull();
    releaseNew?.();
  });

  test('adopts existing containers even above the admission limit', async () => {
    const queue = createQueue();
    const releaseFirst = queue.adoptDetachedContainerSlot('web:external-a');
    const releaseSecond = queue.adoptDetachedContainerSlot('web:external-b');

    expect(queue.getStatus().activeContainerCount).toBe(2);
    expect(queue.countDetachedContainerSlots('web:external-a')).toBe(1);
    expect(queue.countDetachedContainerSlots('web:external-b')).toBe(1);
    expect(queue.tryAcquireDetachedContainerSlot('web:new')).toBeNull();

    const gate = deferred();
    gates.push(gate.resolve);
    const started: string[] = [];
    queue.enqueueTask('web:normal', 'normal-task', async () => {
      started.push('normal');
      await gate.promise;
    });
    await tick();
    expect(started).toEqual([]);

    releaseFirst();
    await tick();
    expect(started).toEqual([]);

    releaseSecond();
    await tick();
    expect(started).toEqual(['normal']);
  });

  test('release is idempotent and shutdown rejects new detached work', async () => {
    const queue = createQueue();
    const releaseDetached =
      queue.tryAcquireDetachedContainerSlot('web:external');
    expect(releaseDetached).not.toBeNull();

    releaseDetached?.();
    releaseDetached?.();
    expect(queue.getStatus().activeContainerCount).toBe(0);
    expect(queue.countDetachedContainerSlots('web:external')).toBe(0);

    await queue.shutdown(0);
    expect(queue.tryAcquireDetachedContainerSlot('web:external')).toBeNull();
  });
});
