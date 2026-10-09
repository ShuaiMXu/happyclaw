import { execFile } from 'node:child_process';

import {
  EXTERNAL_RUNNER_PROTOCOL_VERSION,
  isExternalCapabilityContainerImagePinned,
} from './external-capability-release-config.js';

const EXTERNAL_RUNNER_PROTOCOL_LABEL = 'com.happyclaw.external-runner-protocol';

type DockerImageInspectResult = {
  ok: boolean;
  stdout: string;
};

type ExternalRunnerImageDependencies = {
  inspectImage: (image: string) => Promise<DockerImageInspectResult>;
};

const defaultDependencies: ExternalRunnerImageDependencies = {
  inspectImage: (image) =>
    new Promise((resolve) => {
      execFile(
        'docker',
        [
          'image',
          'inspect',
          '--format',
          `{{ index .Config.Labels "${EXTERNAL_RUNNER_PROTOCOL_LABEL}" }}`,
          image,
        ],
        { timeout: 10_000 },
        (error, stdout) => resolve({ ok: !error, stdout }),
      );
    }),
};

const verifiedImages = new Map<string, Promise<void>>();
const readyImages = new Set<string>();

async function verifyExternalCapabilityRunnerImage(
  image: string,
  dependencies: ExternalRunnerImageDependencies,
): Promise<void> {
  const normalized = image.trim();
  if (!isExternalCapabilityContainerImagePinned(normalized)) {
    throw new Error('External capability runner image is not immutable');
  }
  const inspected = await dependencies.inspectImage(normalized);
  if (
    !inspected.ok ||
    inspected.stdout.trim() !== String(EXTERNAL_RUNNER_PROTOCOL_VERSION)
  ) {
    throw new Error(
      'External capability runner image does not attest the required protocol',
    );
  }
}

/**
 * Verify image-owned protocol metadata before external input or credentials are
 * supplied to the container. Callers at admission and execution boundaries use
 * force=true so process-lifetime cache state cannot outlive the local image.
 */
function assertExternalCapabilityRunnerImageWithDependencies(
  image: string,
  options: { force?: boolean },
  dependencies: ExternalRunnerImageDependencies,
): Promise<void> {
  const normalized = image.trim();
  const existing = verifiedImages.get(normalized);
  if (existing && !options.force) return existing;
  if (options.force) readyImages.delete(normalized);

  let verification!: Promise<void>;
  verification = (async () => {
    try {
      await verifyExternalCapabilityRunnerImage(normalized, dependencies);
      if (verifiedImages.get(normalized) === verification) {
        readyImages.add(normalized);
      }
    } catch (error) {
      if (verifiedImages.get(normalized) === verification) {
        verifiedImages.delete(normalized);
        readyImages.delete(normalized);
      }
      throw error;
    }
  })();
  verifiedImages.set(normalized, verification);
  return verification;
}

export function assertExternalCapabilityRunnerImage(
  image: string,
  options: { force?: boolean } = {},
): Promise<void> {
  return assertExternalCapabilityRunnerImageWithDependencies(
    image,
    options,
    defaultDependencies,
  );
}

export function isExternalCapabilityRunnerImageReady(image: string): boolean {
  return readyImages.has(image.trim());
}

export function verifyExternalCapabilityRunnerImageForTest(
  image: string,
  dependencies: ExternalRunnerImageDependencies,
): Promise<void> {
  return verifyExternalCapabilityRunnerImage(image, dependencies);
}

export function assertExternalCapabilityRunnerImageForTest(
  image: string,
  dependencies: ExternalRunnerImageDependencies,
  options: { force?: boolean } = {},
): Promise<void> {
  return assertExternalCapabilityRunnerImageWithDependencies(
    image,
    options,
    dependencies,
  );
}

export function resetExternalCapabilityRunnerImageCacheForTest(): void {
  verifiedImages.clear();
  readyImages.clear();
}
