import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

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
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/external-capability-network.js', () => ({
  probeExternalCapabilityDockerNetwork: vi.fn(() => {
    if (process.env.EXTERNAL_TEST_NETWORK_PROBE_FAIL === 'true') {
      throw new Error('network not ready');
    }
  }),
}));
vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    const isOwner = process.env.EXTERNAL_TEST_USER !== 'stranger';
    c.set('user', {
      id: isOwner ? 'owner' : 'stranger',
      username: isOwner ? 'owner' : 'stranger',
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
const { default: externalCapabilitiesRoutes } =
  await import('../src/routes/external-capabilities.js');

beforeAll(() => {
  db.initDatabase();
  db.setRegisteredGroup('web:6241df8f-b015-472e-9083-6c4ec31eedc1', {
    name: '全屋报价数据加工',
    folder: 'flow-munrwfg2-u6u8',
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: 'owner',
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
  delete process.env.EXTERNAL_TEST_NETWORK_PROBE_FAIL;
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
          maxFileBytes: 20 * 1024 * 1024,
          maxFilesPerRun: 10,
          maxTotalBytes: 50 * 1024 * 1024,
        }),
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain('secret_hash');
    expect(JSON.stringify(body)).not.toContain('external_capability_keys');
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
});
