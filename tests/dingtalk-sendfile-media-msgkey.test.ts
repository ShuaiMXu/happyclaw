import { describe, expect, test } from 'vitest';

import {
  buildDingTalkFileSendPayload,
  getDingTalkMediaDurationSeconds,
} from '../src/dingtalk.js';

describe('DingTalk sendFile uses media-native robot msgKeys', () => {
  test('mp4 uses parsed seconds and a distinct uploaded cover', () => {
    const payload = buildDingTalkFileSendPayload(
      'video',
      'media-video-1',
      'clip.mp4',
      'mp4',
      { durationSeconds: 1.25, picMediaId: 'media-cover-1' },
    );
    expect(payload.msgKey).toBe('sampleVideo');
    expect(payload.msgParam).toEqual({
      duration: '2',
      videoMediaId: 'media-video-1',
      videoType: 'mp4',
      picMediaId: 'media-cover-1',
    });
  });

  test('video without valid metadata and a distinct cover degrades to a file', () => {
    for (const metadata of [
      {},
      { durationSeconds: 0, picMediaId: 'media-cover-1' },
      { durationSeconds: 2, picMediaId: 'media-video-1' },
    ]) {
      expect(
        buildDingTalkFileSendPayload(
          'video',
          'media-video-1',
          'clip.mp4',
          'mp4',
          metadata,
        ).msgKey,
      ).toBe('sampleFile');
    }
  });

  test('official amr/ogg formats use sampleAudio with milliseconds', () => {
    for (const ext of ['amr', 'ogg']) {
      const payload = buildDingTalkFileSendPayload(
        'voice',
        'media-voice-1',
        `voice.${ext}`,
        ext,
        { durationSeconds: 1.234 },
      );
      expect(payload.msgKey).toBe('sampleAudio');
      expect(payload.msgParam).toEqual({
        mediaId: 'media-voice-1',
        duration: '1234',
      });
    }
  });

  test('unsupported native formats and missing duration degrade to sampleFile', () => {
    for (const ext of ['mp3', 'wav']) {
      expect(
        buildDingTalkFileSendPayload(
          'voice',
          'media-voice-1',
          `voice.${ext}`,
          ext,
          { durationSeconds: 3 },
        ).msgKey,
      ).toBe('sampleFile');
    }
    expect(
      buildDingTalkFileSendPayload(
        'image',
        'media-image-1',
        'image.webp',
        'webp',
      ).msgKey,
    ).toBe('sampleFile');
  });

  test('documents still use sampleFile', () => {
    const payload = buildDingTalkFileSendPayload(
      'file',
      'media-doc-1',
      'notes.pdf',
      'pdf',
    );
    expect(payload.msgKey).toBe('sampleFile');
    expect(payload.msgParam).toEqual({
      mediaId: 'media-doc-1',
      fileName: 'notes.pdf',
      fileType: 'pdf',
    });
  });

  test('parses real AMR frame duration', async () => {
    const header = Buffer.from('#!AMR\n');
    // FT=0 narrow-band frames are 13 octets and represent 20ms each.
    const frame = Buffer.alloc(13);
    const buffer = Buffer.concat([header, frame, frame, frame]);

    await expect(getDingTalkMediaDurationSeconds(buffer, 'amr')).resolves.toBe(
      0.06,
    );
  });

  test('parses real OGG/Opus duration from granule metadata', async () => {
    const oneSecondOgg = Buffer.from(
      'T2dnUwACAAAAAAAAAAABAAAAAAAAAAAAAAABE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAAAEAAAABAAAAAAAAAAEQT3B1c1RhZ3MAAAAAAAAAAE9nZ1MABLi8AAAAAAAAAQAAAAIAAAAAAAAAAQP4//4=',
      'base64',
    );

    await expect(
      getDingTalkMediaDurationSeconds(oneSecondOgg, 'ogg'),
    ).resolves.toBe(1);
  });
});
