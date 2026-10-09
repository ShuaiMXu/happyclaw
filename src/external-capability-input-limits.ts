export const EXTERNAL_CAPABILITY_MAX_BASE64_IMAGE_BYTES = 10 * 1024 * 1024;

export const EXTERNAL_CAPABILITY_MAX_RAW_IMAGE_BYTES =
  Math.floor(EXTERNAL_CAPABILITY_MAX_BASE64_IMAGE_BYTES / 4) * 3;

export function externalCapabilityBase64ByteLength(rawBytes: number): number {
  return 4 * Math.ceil(rawBytes / 3);
}
