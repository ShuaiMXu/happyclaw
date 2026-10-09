import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import type { ExternalCapability } from '../src/types.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-external-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
  CONTAINER_IMAGE: `registry.example/happyclaw-agent@sha256:${'a'.repeat(64)}`,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const executionMocks = vi.hoisted(() => ({
  stop: vi.fn(async () => 'no_active' as const),
}));
const censusMocks = vi.hoisted(() => ({ ready: true }));
const vaultLockMocks = vi.hoisted(() => ({
  available: true,
  release: vi.fn(),
}));
vi.mock('../src/external-capability-execution-control.js', () => ({
  stopExternalCapabilityExecution: executionMocks.stop,
}));
vi.mock('../src/external-capability-storage-backfill.js', () => ({
  isExternalCapabilityVaultCensusReady: vi.fn(
    () =>
      censusMocks.ready &&
      Boolean(process.env.EXTERNAL_CAPABILITY_VAULT_DIR?.trim()) &&
      Boolean(process.env.EXTERNAL_CAPABILITY_VAULT_ID?.trim()),
  ),
}));
vi.mock('../src/external-capability-vault-lock.js', () => ({
  acquireExternalCapabilityVaultSharedLock: vi.fn(() =>
    vaultLockMocks.available ? { release: vaultLockMocks.release } : null,
  ),
}));
vi.mock('../src/external-capability-provider-route.js', () => ({
  assertExternalCapabilityProviderRoutesReady: vi.fn(() => {
    if (process.env.EXTERNAL_TEST_PROVIDER_ROUTE_FAIL === 'true') {
      throw new Error('provider route not ready');
    }
  }),
}));
vi.mock('../src/external-capability-network.js', () => ({
  probeExternalCapabilityDockerNetwork: vi.fn(() => {
    if (process.env.EXTERNAL_TEST_NETWORK_PROBE_FAIL === 'true') {
      throw new Error('network not ready');
    }
  }),
}));
vi.mock('../src/external-capability-runner-image.js', () => ({
  assertExternalCapabilityRunnerImage: vi.fn(async () => {
    if (process.env.EXTERNAL_TEST_IMAGE_PROTOCOL_FAIL === 'true') {
      throw new Error('runner protocol mismatch');
    }
  }),
  isExternalCapabilityRunnerImageReady: vi.fn(
    () => process.env.EXTERNAL_TEST_IMAGE_PROTOCOL_FAIL !== 'true',
  ),
}));
vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    const userId = process.env.EXTERNAL_TEST_USER ?? 'owner';
    c.set('user', {
      id: userId,
      username: userId,
      role: 'member',
      permissions:
        process.env.EXTERNAL_TEST_NO_PERMISSION === 'true'
          ? []
          : ['manage_external_capabilities'],
    });
    return next();
  },
  requirePermission: (permission: string) => async (c: any, next: any) => {
    if (!c.get('user').permissions.includes(permission)) {
      return c.json({ error: `Forbidden: ${permission} required` }, 403);
    }
    return next();
  },
}));

const db = await import('../src/db.js');
const { EXTERNAL_CAPABILITY_DEFINITIONS } =
  await import('../src/external-capability-definitions.js');
const { default: externalCapabilitiesRoutes } =
  await import('../src/routes/external-capabilities.js');

beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'owner',
    username: 'external-capability-owner',
    password_hash: 'hash',
    display_name: 'External capability owner',
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
  db.setRegisteredGroup('web:6241df8f-b015-472e-9083-6c4ec31eedc1', {
    name: '全屋报价数据加工',
    folder: 'flow-munrwfg2-u6u8',
    added_at: now,
    executionMode: 'container',
    created_by: 'owner',
  });
  db.createUser({
    id: 'owner-b',
    username: 'external-capability-owner-b',
    password_hash: 'hash',
    display_name: 'External capability owner B',
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
  db.setRegisteredGroup('web:11111111-2222-4333-8444-555555555555', {
    name: 'Future external target',
    folder: 'future-external-target',
    added_at: now,
    executionMode: 'container',
    created_by: 'owner-b',
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.EXTERNAL_TEST_USER;
  delete process.env.EXTERNAL_TEST_NO_PERMISSION;
  delete process.env.EXTERNAL_CAPABILITY_RELEASE_ENABLED;
  delete process.env.EXTERNAL_CAPABILITY_DOCKER_NETWORK;
  delete process.env.EXTERNAL_CAPABILITY_VAULT_DIR;
  delete process.env.EXTERNAL_CAPABILITY_VAULT_ID;
  delete process.env.EXTERNAL_TEST_NETWORK_PROBE_FAIL;
  delete process.env.EXTERNAL_TEST_IMAGE_PROTOCOL_FAIL;
});

describe('/api/external-capabilities control plane', () => {
  test('shows the fixed quote capability only to the target workspace owner', async () => {
    process.env.EXTERNAL_TEST_USER = 'owner';
    const response = await externalCapabilitiesRoutes.request('/');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.capabilities).toEqual([
      expect.objectContaining({
        slug: 'quote-document-process',
        lifecycleStatus: 'draft',
        availability: 'building',
        workspace: expect.objectContaining({
          name: '全屋报价数据加工',
          executionMode: 'container',
          targetReady: true,
        }),
        inputs: expect.objectContaining({
          maxFileBytes: 10 * 1024 * 1024,
          maxFileBytesByMimeType: {
            'image/jpeg': 7.5 * 1024 * 1024,
            'image/png': 7.5 * 1024 * 1024,
            'image/webp': 7.5 * 1024 * 1024,
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
              10 * 1024 * 1024,
          },
          maxFilesPerRun: 10,
          maxTotalBytes: 10 * 1024 * 1024,
        }),
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain('secret_hash');
    expect(JSON.stringify(body)).not.toContain('external_capability_keys');
  });

  test('does not issue bearer keys while the capability is still draft', async () => {
    process.env.EXTERNAL_TEST_USER = 'owner';
    const response = await externalCapabilitiesRoutes.request(
      '/quote-document-process/keys',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'premature key' }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Capability is not accepting new keys',
    });
    expect(() =>
      db.createExternalCapabilityKey({
        capabilitySlug: 'quote-document-process',
        label: 'direct premature key',
      }),
    ).toThrow('External capability is not accepting new keys');
  });

  test('does not leak a bound workspace to another capability manager', async () => {
    process.env.EXTERNAL_TEST_USER = 'stranger';
    const response = await externalCapabilitiesRoutes.request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ capabilities: [] });

    const detail = await externalCapabilitiesRoutes.request(
      '/quote-document-process',
    );
    expect(detail.status).toBe(404);
  });

  test('keeps management ACLs on the durable target during compiled target drift', async () => {
    process.env.EXTERNAL_TEST_USER = 'owner';
    expect(
      db.setExternalCapabilityStatus('quote-document-process', 'active'),
    ).toBe(true);
    const key = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'durable target ACL',
    }).key;
    const run = db.createExternalCapabilityRun({
      capabilitySlug: 'quote-document-process',
      keyId: key.id,
      externalTaskId: 'durable-target-run',
      idempotencyKey: 'durable-target-key',
      inputManifest: { version: 1 },
    }).run;
    const claim = db.claimNextExternalCapabilityRun(
      'durable-target-worker',
      60_000,
    )!;
    expect(claim.id).toBe(run.id);
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);

    const definition = EXTERNAL_CAPABILITY_DEFINITIONS.find(
      (candidate) => candidate.slug === 'quote-document-process',
    ) as ExternalCapability;
    const originalTarget = {
      workspaceJid: definition.workspace_jid,
      workspaceFolder: definition.workspace_folder,
    };
    definition.workspace_jid = 'web:11111111-2222-4333-8444-555555555555';
    definition.workspace_folder = 'future-external-target';

    try {
      process.env.EXTERNAL_TEST_USER = 'owner-b';
      const listed = await externalCapabilitiesRoutes.request(
        '/quote-document-process/keys',
      );
      expect(listed.status).toBe(404);

      const revoked = await externalCapabilitiesRoutes.request(
        `/quote-document-process/keys/${key.id}`,
        { method: 'DELETE' },
      );
      expect(revoked.status).toBe(404);

      const cancelled = await externalCapabilitiesRoutes.request(
        `/quote-document-process/runs/${run.id}/cancel`,
        { method: 'POST' },
      );
      expect(cancelled.status).toBe(404);
      expect(
        db
          .getExternalCapabilityKeys('quote-document-process')
          .find((candidate) => candidate.id === key.id)?.status,
      ).toBe('active');
      expect(db.getExternalCapabilityRunById(run.id)?.status).toBe('running');

      process.env.EXTERNAL_TEST_USER = 'owner';
      const ownerView = await externalCapabilitiesRoutes.request(
        '/quote-document-process/keys',
      );
      expect(ownerView.status).toBe(200);
      expect(await ownerView.json()).toEqual({
        keys: expect.arrayContaining([expect.objectContaining({ id: key.id })]),
      });
    } finally {
      definition.workspace_jid = originalTarget.workspaceJid;
      definition.workspace_folder = originalTarget.workspaceFolder;
      db.cancelExternalCapabilityRunByOperator(
        'quote-document-process',
        run.id,
      );
      db.revokeExternalCapabilityKey('quote-document-process', key.id);
    }
  });

  test('requires the dedicated capability-management permission', async () => {
    process.env.EXTERNAL_TEST_USER = 'owner';
    process.env.EXTERNAL_TEST_NO_PERMISSION = 'true';
    const response = await externalCapabilitiesRoutes.request('/');
    expect(response.status).toBe(403);
    delete process.env.EXTERNAL_TEST_NO_PERMISSION;
  });

  test('requires an explicit host release gate before activation', async () => {
    process.env.EXTERNAL_TEST_USER = 'owner';
    delete process.env.EXTERNAL_CAPABILITY_RELEASE_ENABLED;
    const blocked = await externalCapabilitiesRoutes.request(
      '/quote-document-process',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      },
    );
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({
      error: 'External capability release gate is not enabled',
    });

    process.env.EXTERNAL_CAPABILITY_RELEASE_ENABLED = 'true';
    process.env.EXTERNAL_CAPABILITY_VAULT_DIR = path.join(root, 'vault');
    process.env.EXTERNAL_CAPABILITY_VAULT_ID = 'routes-external-vault';
    process.env.EXTERNAL_TEST_PROVIDER_ROUTE_FAIL = 'true';
    const routeBlocked = await externalCapabilitiesRoutes.request(
      '/quote-document-process',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      },
    );
    expect(routeBlocked.status).toBe(409);
    expect(await routeBlocked.json()).toEqual({
      error: 'External capability provider route is not ready',
    });
    delete process.env.EXTERNAL_TEST_PROVIDER_ROUTE_FAIL;

    const networkBlocked = await externalCapabilitiesRoutes.request(
      '/quote-document-process',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      },
    );
    expect(networkBlocked.status).toBe(409);
    expect(await networkBlocked.json()).toEqual({
      error: 'External capability egress network is not ready',
    });

    process.env.EXTERNAL_CAPABILITY_DOCKER_NETWORK =
      'happyclaw-external-egress';
    process.env.EXTERNAL_TEST_IMAGE_PROTOCOL_FAIL = 'true';
    const imageBlocked = await externalCapabilitiesRoutes.request(
      '/quote-document-process',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      },
    );
    expect(imageBlocked.status).toBe(409);
    expect(await imageBlocked.json()).toEqual({
      error: 'External capability runner image is not compatible',
    });
    delete process.env.EXTERNAL_TEST_IMAGE_PROTOCOL_FAIL;

    process.env.EXTERNAL_TEST_NETWORK_PROBE_FAIL = 'true';
    const inspectBlocked = await externalCapabilitiesRoutes.request(
      '/quote-document-process',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      },
    );
    expect(inspectBlocked.status).toBe(409);
    expect(await inspectBlocked.json()).toEqual({
      error: 'External capability egress network is not ready',
    });
    delete process.env.EXTERNAL_TEST_NETWORK_PROBE_FAIL;

    censusMocks.ready = false;
    vaultLockMocks.release.mockClear();
    const censusBlocked = await externalCapabilitiesRoutes.request(
      '/quote-document-process',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      },
    );
    expect(censusBlocked.status).toBe(409);
    expect(await censusBlocked.json()).toEqual({
      error: 'External capability storage is not ready',
    });
    expect(vaultLockMocks.release).toHaveBeenCalledOnce();
    censusMocks.ready = true;

    const activated = await externalCapabilitiesRoutes.request(
      '/quote-document-process',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      },
    );
    expect(activated.status).toBe(200);
    expect(await activated.json()).toMatchObject({
      capability: {
        lifecycleStatus: 'active',
        availability: 'available',
        workspace: { releaseEnabled: true, networkReady: true },
      },
    });
  });

  test('pauses persisted active capabilities when startup sees a closed release gate', () => {
    const key = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'release gate closure',
    }).key;
    const run = db.createExternalCapabilityRun({
      capabilitySlug: 'quote-document-process',
      keyId: key.id,
      externalTaskId: 'release-gate-closure-run',
      idempotencyKey: 'release-gate-closure-key',
      inputManifest: { version: 1 },
    }).run;
    const claim = db.claimNextExternalCapabilityRun(
      'release-gate-closure-worker',
      60_000,
    )!;
    expect(claim.id).toBe(run.id);

    expect(db.pauseActiveExternalCapabilitiesForClosedReleaseGate()).toEqual([
      'quote-document-process',
    ]);
    expect(
      db.getExternalCapabilityBySlug('quote-document-process')?.status,
    ).toBe('paused');
    expect(db.getExternalCapabilityRunById(run.id)).toMatchObject({
      status: 'retry_wait',
      attempt: 0,
      started_at: null,
      error_code: 'CAPABILITY_UNAVAILABLE',
      lease_owner: null,
      lease_token: claim.lease_token + 1,
    });

    expect(
      db.setExternalCapabilityStatus('quote-document-process', 'active'),
    ).toBe(true);
    db.cancelExternalCapabilityRunByOperator('quote-document-process', run.id);
    db.revokeExternalCapabilityKey('quote-document-process', key.id);
  });

  test('retries local cleanup when a cancelled run still has Docker create debt', async () => {
    process.env.EXTERNAL_TEST_USER = 'owner';
    db.setExternalCapabilityStatus('quote-document-process', 'active');
    const key = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'repeated cleanup cancellation',
    }).key;
    const run = db.createExternalCapabilityRun({
      capabilitySlug: 'quote-document-process',
      keyId: key.id,
      externalTaskId: 'repeated-cleanup-cancel-run',
      idempotencyKey: 'repeated-cleanup-cancel-key',
      inputManifest: { version: 1 },
    }).run;
    const claim = db.claimNextExternalCapabilityRun(
      'repeated-cleanup-worker',
      60_000,
    )!;
    expect(claim.id).toBe(run.id);
    expect(
      db.markExternalCapabilityRunContainerCleanupRequired(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        claim.attempt,
      ),
    ).toBe(true);
    const pendingUntil = db.reserveExternalCapabilityRunContainerCreation(
      claim.id,
      claim.lease_owner,
      claim.lease_token,
      claim.attempt,
      60_000,
      45_000,
    );
    expect(pendingUntil).not.toBeNull();
    executionMocks.stop.mockClear();

    const first = await externalCapabilitiesRoutes.request(
      `/quote-document-process/runs/${run.id}/cancel`,
      { method: 'POST' },
    );
    const repeated = await externalCapabilitiesRoutes.request(
      `/quote-document-process/runs/${run.id}/cancel`,
      { method: 'POST' },
    );

    expect(first.status).toBe(200);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({
      runId: run.id,
      status: 'cancelled',
      cancelled: false,
    });
    expect(executionMocks.stop).toHaveBeenCalledTimes(2);
    expect(executionMocks.stop).toHaveBeenNthCalledWith(1, run.id);
    expect(executionMocks.stop).toHaveBeenNthCalledWith(2, run.id);

    expect(
      db.finishExternalCapabilityRunContainerCreation(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        claim.attempt,
        pendingUntil!,
        60_000,
      ),
    ).toBe(false);
    expect(
      db.clearExternalCapabilityRunContainerCleanupAfterVerifiedAbsence(
        run.id,
        claim.attempt,
        claim.lease_token,
      ),
    ).toBe(true);
  });

  test('lets an authorized operator fence a started run after key revocation', async () => {
    process.env.EXTERNAL_TEST_USER = 'owner';
    db.setExternalCapabilityStatus('quote-document-process', 'active');
    const key = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'incident response test',
    }).key;
    const run = db.createExternalCapabilityRun({
      capabilitySlug: 'quote-document-process',
      keyId: key.id,
      externalTaskId: 'incident-response-run',
      idempotencyKey: 'incident-response-key',
      inputManifest: { version: 1 },
    }).run;
    const claim = db.claimNextExternalCapabilityRun(
      'incident-response-worker',
      60_000,
    )!;
    expect(claim.id).toBe(run.id);
    expect(
      db.markExternalCapabilityRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);
    expect(
      db.revokeExternalCapabilityKey('quote-document-process', key.id),
    ).toBe(true);
    expect(db.getExternalCapabilityRunById(run.id)?.status).toBe('running');

    const response = await externalCapabilitiesRoutes.request(
      `/quote-document-process/runs/${run.id}/cancel`,
      { method: 'POST' },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runId: run.id,
      status: 'cancelled',
      cancelled: true,
      errorCode: 'CANCELLED_BY_OPERATOR',
    });
    expect(
      db.completeExternalCapabilityRun(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        {
          status: 'failed',
          error: { code: 'STALE', message: 'stale worker' },
        },
      ),
    ).toBe(false);
  });
});
