import fs from 'node:fs';
import path from 'node:path';

import { MAX_FILE_SIZE } from './config.js';
import { detectImageMimeTypeStrict } from './image-detector.js';
import { PhysicalDeliveryTracker } from './im-delivery-progress.js';
import { preAcceptImDeliveryError } from './im-send-retry-policy.js';

export interface PreparedLocalImage {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  sourcePath: string;
}

/** Resolve every local image before the first visible provider mutation. */
export function prepareLocalImages(
  localImagePaths: readonly string[],
  maxBytes = MAX_FILE_SIZE,
): PreparedLocalImage[] {
  return localImagePaths.map((imagePath) => {
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(imagePath);
    } catch (error) {
      throw preAcceptImDeliveryError(
        `Local image attachment is unavailable: ${imagePath}`,
        error,
      );
    }
    if (buffer.length === 0 || buffer.length > maxBytes) {
      throw preAcceptImDeliveryError(
        `Local image attachment has invalid size ${buffer.length}: ${imagePath}`,
      );
    }
    const mimeType = detectImageMimeTypeStrict(buffer);
    if (!mimeType) {
      throw preAcceptImDeliveryError(
        `Local attachment is not a supported image: ${imagePath}`,
      );
    }
    return {
      buffer,
      mimeType,
      fileName: path.basename(imagePath),
      sourcePath: imagePath,
    };
  });
}

/**
 * Deliver one logical body plus its physical images without replaying an ACKed
 * prefix. The caller owns retry policy; any tail failure after an ACK becomes
 * CHANNEL_DELIVERY_PARTIAL and therefore classifies as uncertain.
 */
export async function deliverTextAndLocalImages(input: {
  text: string;
  images: readonly PreparedLocalImage[];
  sendText: () => Promise<void>;
  sendImage: (image: PreparedLocalImage, index: number) => Promise<void>;
}): Promise<void> {
  const sendsText = input.text.length > 0 || input.images.length === 0;
  const tracker = new PhysicalDeliveryTracker(
    (sendsText ? 1 : 0) + input.images.length,
  );
  if (sendsText) await tracker.send(input.sendText);
  for (let index = 0; index < input.images.length; index += 1) {
    const image = input.images[index]!;
    await tracker.send(() => input.sendImage(image, index));
  }
}
