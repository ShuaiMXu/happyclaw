import { Hono } from 'hono';

import type { Variables } from '../web-context.js';
import { CONTAINER_IMAGE } from '../config.js';
import { authMiddleware, requirePermission } from '../middleware/auth.js';
import {
  cancelExternalCapabilityRunByOperator,
  createExternalCapabilityKey,
  getExternalCapabilityKeys,
  getRegisteredGroup,
  revokeExternalCapabilityKey,
  setExternalCapabilityStatus,
} from '../db.js';
import { stopExternalCapabilityExecution } from '../external-capability-execution-control.js';
import {
  getConfiguredExternalCapabilities,
  getConfiguredExternalCapability,
} from '../external-capabilities.js';
import { probeExternalCapabilityDockerNetwork } from '../external-capability-network.js';
import { assertExternalCapabilityProviderRoutesReady } from '../external-capability-provider-route.js';
import { EXTERNAL_CAPABILITY_MAX_RAW_IMAGE_BYTES } from '../external-capability-input-limits.js';
import { getExternalCapabilityQuotaConfig } from '../external-capability-quota-config.js';
import { isExternalCapabilityVaultCensusReady } from '../external-capability-storage-backfill.js';
import {
  assertExternalCapabilityRunnerImage,
  isExternalCapabilityRunnerImageReady,
} from '../external-capability-runner-image.js';
import {
  getExternalCapabilityDockerNetwork,
  isExternalCapabilityContainerImagePinned,
  isExternalCapabilityReleaseEnabled,
} from '../external-capability-release-config.js';
import { canModifyGroup } from '../group-acl.js';
import { probeExternalCapabilityVaultWithCapacity } from '../external-capability-storage-capacity.js';
import { getExternalCapabilityVaultRoot } from '../external-capability-storage.js';
import {
  acquireExternalCapabilityVaultSharedLock,
  type ExternalCapabilityVaultLock,
} from '../external-capability-vault-lock.js';
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
  const vaultReady = isExternalCapabilityVaultCensusReady();
  const releaseEnabled = isExternalCapabilityReleaseEnabled();
  const networkReady = getExternalCapabilityDockerNetwork() !== null;
  const quotaConfig = getExternalCapabilityQuotaConfig();
  const effectiveTotalBytes = Math.min(
    capability.max_total_bytes,
    quotaConfig.maxInputBytesPerRun,
  );
  const effectiveFileBytes = Math.min(
    capability.max_file_bytes,
    effectiveTotalBytes,
  );
  const maxFileBytesByMimeType = Object.fromEntries(
    capability.allowed_mime_types.map((mimeType) => [
      mimeType,
      mimeType.startsWith('image/')
        ? Math.min(effectiveFileBytes, EXTERNAL_CAPABILITY_MAX_RAW_IMAGE_BYTES)
        : effectiveFileBytes,
    ]),
  );
  const imageReady =
    isExternalCapabilityContainerImagePinned(CONTAINER_IMAGE) &&
    isExternalCapabilityRunnerImageReady(CONTAINER_IMAGE);
  const available =
    capability.status === 'active' &&
    releaseEnabled &&
    networkReady &&
    imageReady &&
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
      imageReady,
    },
    inputs: {
      schemaVersion: capability.input_schema_version,
      acceptedMimeTypes: capability.allowed_mime_types,
      maxFileBytes: effectiveFileBytes,
      maxFileBytesByMimeType,
      maxFilesPerRun: capability.max_files_per_run,
      maxTotalBytes: effectiveTotalBytes,
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
    if (capability.status !== 'active') {
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

externalCapabilitiesRoutes.post(
  '/:slug/runs/:runId/cancel',
  authMiddleware,
  externalCapabilityManage,
  (c) => {
    const capability = getConfiguredExternalCapability(c.req.param('slug'));
    const user = c.get('user') as AuthUser;
    if (!capability || !capabilityView(capability, user)) {
      return c.json({ error: 'Capability not found' }, 404);
    }
    const cancelled = cancelExternalCapabilityRunByOperator(
      capability.slug,
      c.req.param('runId'),
    );
    if (!cancelled) return c.json({ error: 'Run not found' }, 404);
    if (
      cancelled.cancelled ||
      cancelled.run.container_cleanup_attempt !== null ||
      cancelled.run.container_cleanup_lease_token !== null ||
      cancelled.run.container_create_pending_until !== null
    ) {
      stopExternalCapabilityExecution(cancelled.run.id);
    }
    return c.json({
      runId: cancelled.run.id,
      status: cancelled.run.status,
      cancelled: cancelled.cancelled,
      errorCode: cancelled.run.error_code,
    });
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
    if (
      status === 'active' &&
      !isExternalCapabilityContainerImagePinned(CONTAINER_IMAGE)
    ) {
      return c.json(
        { error: 'External capability runner image is not immutable' },
        409,
      );
    }
    if (status === 'active') {
      try {
        assertExternalCapabilityProviderRoutesReady();
      } catch {
        return c.json(
          { error: 'External capability provider route is not ready' },
          409,
        );
      }
      try {
        await assertExternalCapabilityRunnerImage(CONTAINER_IMAGE, {
          force: true,
        });
      } catch {
        return c.json(
          { error: 'External capability runner image is not compatible' },
          409,
        );
      }
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
      let vaultLock: ExternalCapabilityVaultLock | null = null;
      try {
        vaultLock = acquireExternalCapabilityVaultSharedLock();
        if (!vaultLock || !isExternalCapabilityVaultCensusReady()) {
          throw new Error('External capability Vault is under maintenance');
        }
        probeExternalCapabilityVaultWithCapacity(
          getExternalCapabilityVaultRoot(),
        );
        vaultLock.release();
        vaultLock = null;
      } catch {
        try {
          vaultLock?.release();
        } catch {
          // A surviving owner record blocks census fail-closed.
        }
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
