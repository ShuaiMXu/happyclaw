import crypto from 'node:crypto';

export type ExternalCapabilityStorageObjectKind =
  | 'input'
  | 'runtime'
  | 'output';

/** Stable identity shared by live reservations and startup occupancy backfill. */
export function externalCapabilityStorageReservationKey(input: {
  runId: string;
  kind: ExternalCapabilityStorageObjectKind;
  objectKey: string;
}): string {
  const digest = crypto
    .createHash('sha256')
    .update(input.runId)
    .update('\0')
    .update(input.kind)
    .update('\0')
    .update(input.objectKey)
    .digest('hex');
  return `ec-storage-v1:${input.kind}:${digest}`;
}
