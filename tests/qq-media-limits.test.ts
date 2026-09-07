import { describe, expect, test } from 'vitest';

import {
  getQQMediaFileType,
  QQMediaFileType,
  QQ_MEDIA_MAX_SIZE,
  QQ_ONESHOT_UPLOAD_MAX_SIZE,
} from '../src/qq.js';

const MB = 1024 * 1024;

describe('getQQMediaFileType', () => {
  test.each([
    ['photo.jpg', QQMediaFileType.IMAGE],
    ['photo.JPEG', QQMediaFileType.IMAGE],
    ['sticker.gif', QQMediaFileType.IMAGE],
    ['clip.mp4', QQMediaFileType.VIDEO],
    ['clip.MKV', QQMediaFileType.VIDEO],
    ['note.silk', QQMediaFileType.VOICE],
    ['note.mp3', QQMediaFileType.VOICE],
    ['report.pdf', QQMediaFileType.FILE],
    ['archive.tar.gz', QQMediaFileType.FILE],
  ])('maps %s', (fileName, expected) => {
    expect(getQQMediaFileType(fileName)).toBe(expected);
  });

  test('falls back to FILE for an unknown or missing extension', () => {
    expect(getQQMediaFileType('LICENSE')).toBe(QQMediaFileType.FILE);
    expect(getQQMediaFileType('data.unknownext')).toBe(QQMediaFileType.FILE);
  });
});

describe('QQ upload ceilings', () => {
  test('every media type has a ceiling', () => {
    for (const fileType of [
      QQMediaFileType.IMAGE,
      QQMediaFileType.VIDEO,
      QQMediaFileType.VOICE,
      QQMediaFileType.FILE,
    ]) {
      expect(QQ_MEDIA_MAX_SIZE[fileType]).toBeGreaterThan(0);
    }
  });

  test('matches the limits published for the platform', () => {
    expect(QQ_MEDIA_MAX_SIZE[QQMediaFileType.IMAGE]).toBe(30 * MB);
    expect(QQ_MEDIA_MAX_SIZE[QQMediaFileType.VIDEO]).toBe(100 * MB);
    expect(QQ_MEDIA_MAX_SIZE[QQMediaFileType.VOICE]).toBe(20 * MB);
    expect(QQ_MEDIA_MAX_SIZE[QQMediaFileType.FILE]).toBe(100 * MB);
  });

  test('the one-shot base64 path stays under the chunked image ceiling', () => {
    // send_image posts the whole payload in one request, so it cannot reach
    // the ceiling that the chunked upload path allows for the same file type.
    expect(QQ_ONESHOT_UPLOAD_MAX_SIZE).toBe(20 * MB);
    expect(QQ_ONESHOT_UPLOAD_MAX_SIZE).toBeLessThan(
      QQ_MEDIA_MAX_SIZE[QQMediaFileType.IMAGE],
    );
  });

  test('no ceiling exceeds the platform-wide chunked upload maximum', () => {
    for (const limit of Object.values(QQ_MEDIA_MAX_SIZE)) {
      expect(limit).toBeLessThanOrEqual(100 * MB);
    }
  });
});
