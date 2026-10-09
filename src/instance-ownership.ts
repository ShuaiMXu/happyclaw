import crypto from 'node:crypto';
import fs from 'node:fs';

import { DATA_DIR } from './config.js';

export const HAPPYCLAW_MANAGED_LABEL = 'com.happyclaw.managed';
export const HAPPYCLAW_INSTALLATION_LABEL = 'com.happyclaw.installation';

let cachedInstallation:
  | { canonicalDataDir: string; id: string; namespace: string }
  | undefined;

export function canonicalizeInstallationDataDir(dataDir = DATA_DIR): string {
  return fs.realpathSync.native(dataDir);
}

export function deriveInstallationId(canonicalDataDir: string): string {
  return crypto.createHash('sha256').update(canonicalDataDir).digest('hex');
}

function installationIdentity(): {
  canonicalDataDir: string;
  id: string;
  namespace: string;
} {
  if (cachedInstallation) return cachedInstallation;
  const canonicalDataDir = canonicalizeInstallationDataDir();
  const id = deriveInstallationId(canonicalDataDir);
  cachedInstallation = {
    canonicalDataDir,
    id,
    namespace: id.slice(0, 20),
  };
  return cachedInstallation;
}

export function getInstallationId(): string {
  return installationIdentity().id;
}

export function getInstallationNamespace(): string {
  return installationIdentity().namespace;
}

export function ownedDockerLabelFilters(): string[] {
  return [
    '--filter',
    `label=${HAPPYCLAW_MANAGED_LABEL}=true`,
    '--filter',
    `label=${HAPPYCLAW_INSTALLATION_LABEL}=${getInstallationId()}`,
  ];
}

export function ownedDockerLabelArgs(): string[] {
  return [
    '--label',
    `${HAPPYCLAW_MANAGED_LABEL}=true`,
    '--label',
    `${HAPPYCLAW_INSTALLATION_LABEL}=${getInstallationId()}`,
  ];
}

export function hostRunnerOwnershipArgument(): string {
  return `--happyclaw-installation=${getInstallationId()}`;
}
