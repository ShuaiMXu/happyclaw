import { getExternalCapabilities } from './db.js';
import {
  EXTERNAL_CAPABILITY_DEFINITIONS,
  QUOTE_DOCUMENT_CAPABILITY_POLICY,
  QUOTE_DOCUMENT_CAPABILITY_SLUG,
  QUOTE_DOCUMENT_CAPABILITY_TARGET,
} from './external-capability-definitions.js';
import type { ExternalCapability } from './types.js';

export {
  EXTERNAL_CAPABILITY_DEFINITIONS,
  QUOTE_DOCUMENT_CAPABILITY_POLICY,
  QUOTE_DOCUMENT_CAPABILITY_SLUG,
  QUOTE_DOCUMENT_CAPABILITY_TARGET,
};

/**
 * The database owns the effective contract after initialization. A compiled
 * definition can move ahead of the durable row while a started execution still
 * targets the old workspace, so management ACLs and execution must keep using
 * the durable contract until initialization can safely synchronize it.
 */
export function getConfiguredExternalCapabilities(): ExternalCapability[] {
  const rowsBySlug = new Map(
    getExternalCapabilities().map((capability) => [
      capability.slug,
      capability,
    ]),
  );
  return EXTERNAL_CAPABILITY_DEFINITIONS.map((definition) => {
    const row = rowsBySlug.get(definition.slug);
    if (!row) return { ...definition };
    return { ...row };
  });
}

export function getConfiguredExternalCapability(
  slug: string,
): ExternalCapability | undefined {
  return getConfiguredExternalCapabilities().find(
    (capability) => capability.slug === slug,
  );
}
