import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import {
  deliverTextAndLocalImages,
  prepareLocalImages,
} from '../src/im-local-attachments.js';
import {
  classifyImSendFailure,
  imSendFailurePolicy,
  preAcceptImDeliveryError,
  retryUnscopedImSend,
} from '../src/im-send-retry-policy.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'im-local-images-'));
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const firstPath = path.join(root, 'first.png');
const secondPath = path.join(root, 'second.png');
fs.writeFileSync(firstPath, png);
fs.writeFileSync(secondPath, png);

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('unscoped IM body + local image delivery', () => {
  test('sends the body and every image as real ordered physical operations', async () => {
    const order: string[] = [];
    const images = prepareLocalImages([firstPath, secondPath]);
    await deliverTextAndLocalImages({
      text: 'body',
      images,
      sendText: async () => {
        order.push('text');
      },
      sendImage: async (image) => {
        order.push(image.fileName);
      },
    });
    expect(order).toEqual(['text', 'first.png', 'second.png']);
  });

  test('an ACKed prefix dominates a safe-looking tail error and forbids replay', async () => {
    const images = prepareLocalImages([firstPath, secondPath]);
    let attempts = 0;
    let textSends = 0;
    let imageSends = 0;
    const result = await retryUnscopedImSend(
      async () => {
        attempts += 1;
        await deliverTextAndLocalImages({
          text: 'body',
          images,
          sendText: async () => {
            textSends += 1;
          },
          sendImage: async (_image, index) => {
            imageSends += 1;
            if (index === 1) {
              throw preAcceptImDeliveryError('second image upload rejected');
            }
          },
        });
      },
      { sleep: async () => undefined },
    );

    expect(result).toMatchObject({ ok: false, outcome: 'uncertain' });
    expect(classifyImSendFailure(result.error)).toBe('uncertain');
    expect(imSendFailurePolicy(result.error)).toMatchObject({
      outcome: 'uncertain',
      retryable: false,
      countsTowardChannelRemoval: false,
    });
    expect(attempts).toBe(1);
    expect(textSends).toBe(1);
    expect(imageSends).toBe(2);
  });

  test('missing files fail before any provider operation', async () => {
    expect(() => prepareLocalImages([path.join(root, 'missing.png')])).toThrow(
      expect.objectContaining({ deliveryPhase: 'pre_accept' }),
    );
  });
});
