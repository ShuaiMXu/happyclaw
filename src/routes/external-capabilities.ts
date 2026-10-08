import { Hono } from 'hono';

import type { Variables } from '../web-context.js';
import { authMiddleware, requirePermission } from '../middleware/auth.js';
import {
  createExternalCapabilityKey,
  getExternalCapabilityKeys,
  getRegisteredGroup,
  revokeExternalCapabilityKey,
  setExternalCapabilityStatus,
} from '../db.js';
import {
  getConfiguredExternalCapabilities,
  getConfiguredExternalCapability,
} from '../external-capabilities.js';
import { probeExternalCapabilityDockerNetwork } from '../external-capability-network.js';
import {
  getExternalCapabilityDockerNetwork,
  isExternalCapabilityReleaseEnabled,
} from '../external-capability-release-config.js';
import { canModifyGroup } from '../group-acl.js';
import {
  getExternalCapabilityVaultRoot,
  probeExternalCapabilityVault,
} from '../external-capability-storage.js';
import type { AuthUser, ExternalCapability } from '../types.js';

const externalCapabilitiesRoutes = new Hono<{ Variables: Variables }>();
const externalCapabilityManage = requirePermission(
  'manage_external_capabilities',
);

function capabilityView(capability: ExternalCapability, user: AuthUser) {
  const workspace = getRegisteredGroup(capability.workspace_jid);
  if (!workspace || !canModifyGroup(user, workspace)) return null;

  const workspaceMatchesTarget =
    workspace.folder === capability.workspace_folder &&
    workspace.executionMode === 'container';
  let vaultReady = true;
  try {
    getExternalCapabilityVaultRoot();
  } catch {
    vaultReady = false;
  }
  const releaseEnabled = isExternalCapabilityReleaseEnabled();
  const networkReady = getExternalCapabilityDockerNetwork() !== null;
  const available =
    capability.status === 'active' &&
    releaseEnabled &&
    networkReady &&
    workspaceMatchesTarget &&
    vaultReady &&
    capability.allowed_mime_types.length > 0;

  return {
    slug: capability.slug,
    name: capability.display_name,
    description: capability.description,
    lifecycleStatus: capability.status,
    availability: available ? 'available' : 'building',
    workspace: {
      name: workspace.name,
      folder: workspace.folder,
      executionMode: workspace.executionMode || 'container',
      targetReady: workspaceMatchesTarget,
      storageReady: vaultReady,
      releaseEnabled,
      networkReady,
    },
    inputs: {
      schemaVersion: capability.input_schema_version,
      acceptedMimeTypes: capability.allowed_mime_types,
      maxFileBytes: capability.max_file_bytes,
      maxFilesPerRun: capability.max_files_per_run,
      maxTotalBytes: capability.max_total_bytes,
    },
    createdAt: capability.created_at,
    updatedAt: capability.updated_at,
  };
}

// This is the authenticated control-plane API. The server-to-server invoke
// endpoint is deliberately mounted separately and never accepts browser cookies.
externalCapabilitiesRoutes.get(
  '/',
  authMiddleware,
  externalCapabilityManage,
  (c) => {
    const user = c.get('user') as AuthUser;
    const capabilities = getConfiguredExternalCapabilities()
      .map((capability) => capabilityView(capability, user))
      .filter((capability): capability is NonNullable<typeof capability> =>
        Boolean(capability),
      );
    return c.json({ capabilities });
  },
);

externalCapabilitiesRoutes.get(
  '/:slug',
  authMiddleware,
  externalCapabilityManage,
  (c) => {
    const user = c.get('user') as AuthUser;
    const capability = getConfiguredExternalCapability(c.req.param('slug'));
    if (!capability) return c.json({ error: 'Capability not found' }, 404);
    const view = capabilityView(capability, user);
    // Do not reveal a workspace binding to a platform operator who does not
    // own that workspace. This matches the owner-scoped workspace boundary.
    if (!view) return c.json({ error: 'Capability not found' }, 404);
    return c.json({ capability: view });
  },
);

externalCapabilitiesRoutes.get(
  '/:slug/keys',
  authMiddleware,
  externalCapabilityManage,
  (c) => {
    const capability = getConfiguredExternalCapability(c.req.param('slug'));
    const user = c.get('user') as AuthUser;
    if (!capability || !capabilityView(capability, user)) {
      return c.json({ error: 'Capability not found' }, 404);
    }
    return c.json({ keys: getExternalCapabilityKeys(capability.slug) });
  },
);

// A secret is returned exactly once at creation time. Only its salted-equivalent
// hash is persisted, and all later list responses expose metadata only.
externalCapabilitiesRoutes.post(
  '/:slug/keys',
  authMiddleware,
  externalCapabilityManage,
  async (c) => {
    const capability = getConfiguredExternalCapability(c.req.param('slug'));
    const user = c.get('user') as AuthUser;
    if (!capability || !capabilityView(capability, user)) {
      return c.json({ error: 'Capability not found' }, 404);
    }
    if (capability.status === 'paused' || capability.status === 'retired') {
      return c.json({ error: 'Capability is not accepting new keys' }, 409);
    }
    const body = await c.req.json().catch(() => null);
    const label = body && typeof body.label === 'string' ? body.label : '';
    try {
      const created = createExternalCapabilityKey({
        capabilitySlug: capability.slug,
        label,
      });
      return c.json({ key: created.key, secret: created.secret }, 201);
    } catch {
      return c.json({ error: 'Could not create capability key' }, 400);
    }
  },
);

externalCapabilitiesRoutes.delete(
  '/:slug/keys/:keyId',
  authMiddleware,
  externalCapabilityManage,
  (c) => {
    const capability = getConfiguredExternalCapability(c.req.param('slug'));
    const user = c.get('user') as AuthUser;
    if (!capability || !capabilityView(capability, user)) {
      return c.json({ error: 'Capability not found' }, 404);
    }
    if (!revokeExternalCapabilityKey(capability.slug, c.req.param('keyId'))) {
      return c.json({ error: 'Active key not found' }, 404);
    }
    return c.body(null, 204);
  },
);

externalCapabilitiesRoutes.patch(
  '/:slug',
  authMiddleware,
  externalCapabilityManage,
  async (c) => {
    const capability = getConfiguredExternalCapability(c.req.param('slug'));
    const user = c.get('user') as AuthUser;
    const view = capability ? capabilityView(capability, user) : null;
    if (!capability || !view)
      return c.json({ error: 'Capability not found' }, 404);
    const body = await c.req.json().catch(() => null);
    const status = body?.status;
    if (!['active', 'paused', 'retired'].includes(status)) {
      return c.json({ error: 'A valid lifecycle status is required' }, 400);
    }
    if (capability.status === 'retired' && status !== 'retired') {
      return c.json({ error: 'A retired capability cannot be restored' }, 409);
    }
    if (status === 'active' && !isExternalCapabilityReleaseEnabled()) {
      return c.json(
        { error: 'External capability release gate is not enabled' },
        409,
      );
    }
    const networkName = getExternalCapabilityDockerNetwork();
    if (status === 'active' && !networkName) {
      return c.json(
        { error: 'External capability egress network is not ready' },
        409,
      );
    }
    if (status === 'active' && !view.workspace.targetReady) {
      return c.json({ error: 'Target workspace is not ready' }, 409);
    }
    if (status === 'active') {
      try {
        await probeExternalCapabilityDockerNetwork(networkName!);
      } catch {
        return c.json(
          { error: 'External capability egress network is not ready' },
          409,
        );
      }
      try {
        probeExternalCapabilityVault(getExternalCapabilityVaultRoot());
      } catch {
        return c.json(
          { error: 'External capability storage is not ready' },
          409,
        );
      }
    }
    if (!setExternalCapabilityStatus(capability.slug, status)) {
      return c.json({ error: 'Capability lifecycle transition rejected' }, 409);
    }
    return c.json({
      capability: capabilityView(
        getConfiguredExternalCapability(capability.slug)!,
        user,
      ),
    });
  },
);

export default externalCapabilitiesRoutes;
