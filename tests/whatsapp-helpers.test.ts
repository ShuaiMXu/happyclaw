import { describe, expect, test } from 'vitest';
import type { proto } from 'baileys';

import {
  canonicalizeWhatsAppUserJid,
  collectWhatsAppSelfJids,
  extractMessageText,
  extFromMime,
  guessMimeType,
  buildWhatsAppSendFileContent,
  isMentioningBot,
  isWhatsAppSelfParticipant,
  normalizeTimestamp,
  stripChannelPrefix,
  stripLeadingWhatsAppBotMention,
} from '../src/whatsapp.js';
import {
  canonicalizeWhatsAppConversationJid,
  canonicalizeWhatsAppProviderConversationJid,
  findLegacyWhatsAppConversationAliases,
  isLegacyWhatsAppDirectConversationJid,
  resolveWhatsAppConversationAlias,
  resolveWhatsAppConversationAliasFromGroups,
} from '../src/whatsapp-jid.js';

describe('extractMessageText', () => {
  test('plain conversation', () => {
    expect(extractMessageText({ conversation: 'hi' } as proto.IMessage)).toBe(
      'hi',
    );
  });

  test('extendedTextMessage', () => {
    expect(
      extractMessageText({
        extendedTextMessage: { text: 'hello world' },
      } as proto.IMessage),
    ).toBe('hello world');
  });

  test('ephemeral wraps inner content', () => {
    expect(
      extractMessageText({
        ephemeralMessage: { message: { conversation: 'secret' } },
      } as proto.IMessage),
    ).toBe('secret');
  });

  test('viewOnceMessageV2 wraps inner content', () => {
    expect(
      extractMessageText({
        viewOnceMessageV2: {
          message: { extendedTextMessage: { text: 'inner' } },
        },
      } as proto.IMessage),
    ).toBe('inner');
  });

  test('image caption acts as text', () => {
    expect(
      extractMessageText({
        imageMessage: { caption: 'a photo' },
      } as proto.IMessage),
    ).toBe('a photo');
  });

  test('media without caption returns null', () => {
    expect(
      extractMessageText({
        imageMessage: { mimetype: 'image/jpeg' },
      } as proto.IMessage),
    ).toBeNull();
  });

  test('empty content returns null', () => {
    expect(extractMessageText({} as proto.IMessage)).toBeNull();
  });
});

describe('normalizeTimestamp', () => {
  test('number unix seconds → ms', () => {
    expect(normalizeTimestamp(1700000000)).toBe(1700000000_000);
  });

  test('null/undefined → 0', () => {
    expect(normalizeTimestamp(null)).toBe(0);
    expect(normalizeTimestamp(undefined)).toBe(0);
  });

  test('Long-like with toNumber', () => {
    const longLike = { toNumber: () => 1700000001 };
    expect(normalizeTimestamp(longLike as never)).toBe(1700000001_000);
  });
});

describe('guessMimeType', () => {
  test('common image types', () => {
    expect(guessMimeType('photo.jpg')).toBe('image/jpeg');
    expect(guessMimeType('photo.JPEG')).toBe('image/jpeg');
    expect(guessMimeType('icon.png')).toBe('image/png');
    expect(guessMimeType('a.webp')).toBe('image/webp');
  });

  test('document types', () => {
    expect(guessMimeType('report.pdf')).toBe('application/pdf');
    expect(guessMimeType('a.docx')).toMatch(/wordprocessing/);
    expect(guessMimeType('list.csv')).toBe('text/csv');
  });

  test('unknown extension returns null', () => {
    expect(guessMimeType('mystery.xyz')).toBeNull();
    expect(guessMimeType('noext')).toBeNull();
  });
});

describe('extFromMime', () => {
  test('image mimes', () => {
    expect(extFromMime('image/jpeg')).toBe('.jpg');
    expect(extFromMime('image/png')).toBe('.png');
  });

  test('audio is contextual: mpeg + audio prefix → mp3', () => {
    expect(extFromMime('audio/mpeg')).toBe('.mp3');
  });

  test('null/empty input', () => {
    expect(extFromMime(null)).toBeNull();
    expect(extFromMime(undefined)).toBeNull();
    expect(extFromMime('')).toBeNull();
  });
});

describe('stripChannelPrefix', () => {
  test('strips whatsapp: prefix', () => {
    expect(stripChannelPrefix('whatsapp:123@s.whatsapp.net')).toBe(
      '123@s.whatsapp.net',
    );
  });

  test('passes through when no prefix', () => {
    expect(stripChannelPrefix('123@g.us')).toBe('123@g.us');
  });
});

describe('WhatsApp durable conversation JID canonicalization', () => {
  test('folds legacy and device PN forms without changing groups', () => {
    expect(
      canonicalizeWhatsAppProviderConversationJid('15551234567@c.us'),
    ).toBe('15551234567@s.whatsapp.net');
    expect(
      canonicalizeWhatsAppProviderConversationJid('15551234567:14@c.us'),
    ).toBe('15551234567@s.whatsapp.net');
    expect(
      canonicalizeWhatsAppProviderConversationJid(
        '15551234567:14@s.whatsapp.net',
      ),
    ).toBe('15551234567@s.whatsapp.net');
    expect(
      canonicalizeWhatsAppProviderConversationJid('120363012345678901@g.us'),
    ).toBe('120363012345678901@g.us');
  });

  test('preserves account scope and finds only aliases from the same bot', () => {
    const canonical = 'whatsapp:15551234567@s.whatsapp.net#account:bot-a';
    const legacy = 'whatsapp:15551234567:14@c.us#account:bot-a';
    expect(canonicalizeWhatsAppConversationJid(legacy)).toBe(canonical);
    expect(isLegacyWhatsAppDirectConversationJid(legacy)).toBe(true);
    expect(isLegacyWhatsAppDirectConversationJid(canonical)).toBe(false);
    expect(
      findLegacyWhatsAppConversationAliases(canonical, [
        legacy,
        'whatsapp:15551234567@c.us#account:bot-b',
        'whatsapp:19990001111@c.us#account:bot-a',
        canonical,
      ]),
    ).toEqual([legacy]);
  });

  test('keeps one legacy route stable, prefers canonical, and fails closed on ambiguity', () => {
    const canonical = 'whatsapp:15551234567@s.whatsapp.net#account:bot-a';
    const legacy = 'whatsapp:15551234567:14@c.us#account:bot-a';
    expect(resolveWhatsAppConversationAlias(canonical, [legacy])).toEqual({
      status: 'legacy',
      jid: legacy,
      aliases: [legacy],
    });
    expect(
      resolveWhatsAppConversationAlias(canonical, [legacy, canonical]),
    ).toEqual({ status: 'canonical', jid: canonical, aliases: [] });
    expect(
      resolveWhatsAppConversationAlias(canonical, [
        'whatsapp:15551234567@c.us#account:bot-b',
      ]),
    ).toEqual({ status: 'new', jid: canonical, aliases: [] });
    expect(
      resolveWhatsAppConversationAlias(canonical, [
        legacy,
        'whatsapp:15551234567@c.us#account:bot-a',
      ]),
    ).toEqual({
      status: 'conflict',
      jid: null,
      aliases: [legacy, 'whatsapp:15551234567@c.us#account:bot-a'],
    });
  });

  test('accepts deterministically only when repaired legacy aliases have equivalent routing and permissions', () => {
    const canonical = 'whatsapp:15551234567@s.whatsapp.net#account:bot-a';
    const first = 'whatsapp:15551234567:14@c.us#account:bot-a';
    const second = 'whatsapp:15551234567@c.us#account:bot-a';
    const equivalent = {
      folder: 'home-owner',
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_agent_id: 'same-repaired-session',
      owner_im_id: '15551234567@s.whatsapp.net',
      owner_claim_source: 'trusted_direct',
      activation_mode: 'auto',
      audience_mode: 'everyone',
    };
    expect(
      resolveWhatsAppConversationAliasFromGroups(canonical, {
        [second]: { ...equivalent },
        [first]: { ...equivalent },
      }),
    ).toEqual({
      status: 'legacy_equivalent',
      jid: first,
      aliases: [first, second],
    });

    for (const groups of [
      {
        [first]: { ...equivalent, target_agent_id: 'session-a' },
        [second]: { ...equivalent, target_agent_id: 'session-b' },
      },
      {
        [first]: {
          ...equivalent,
          target_agent_id: undefined,
          target_main_jid: 'web:workspace-a',
        },
        [second]: {
          ...equivalent,
          target_agent_id: undefined,
          target_main_jid: 'web:workspace-b',
        },
      },
      {
        [first]: { ...equivalent, owner_im_id: 'owner-a@s.whatsapp.net' },
        [second]: { ...equivalent, owner_im_id: 'owner-b@s.whatsapp.net' },
      },
    ]) {
      expect(
        resolveWhatsAppConversationAliasFromGroups(canonical, groups),
      ).toMatchObject({ status: 'conflict', jid: null });
    }
  });
});

describe('WhatsApp LID/hosted self identity', () => {
  const PN = '15551234567:42@s.whatsapp.net';
  const LID = '123456789012345:12@lid';
  const SELF = { id: PN, lid: LID };

  test('canonicalizes hosted aliases without equating LID to PN', () => {
    expect(canonicalizeWhatsAppUserJid('15551234567@hosted')).toBe(
      '15551234567@s.whatsapp.net',
    );
    expect(canonicalizeWhatsAppUserJid('123456789012345@hosted.lid')).toBe(
      '123456789012345@lid',
    );
    expect(canonicalizeWhatsAppUserJid(LID)).toBe('123456789012345@lid');
    expect(canonicalizeWhatsAppUserJid(PN)).toBe('15551234567@s.whatsapp.net');
    expect(canonicalizeWhatsAppUserJid(PN)).not.toBe(
      canonicalizeWhatsAppUserJid(LID),
    );
  });

  test('collects both sock.user.id and sock.user.lid', () => {
    expect(collectWhatsAppSelfJids(SELF).sort()).toEqual([
      '123456789012345@lid',
      '15551234567@s.whatsapp.net',
    ]);
    expect(collectWhatsAppSelfJids(PN)).toEqual(['15551234567@s.whatsapp.net']);
  });

  test('membership matches when only the other identity is on the event row', () => {
    // Old code compared `phoneNumber ?? id` to sock.user.id only, so a LID
    // self missed PN-bearing rows and a PN self missed LID-only rows.
    expect(
      isWhatsAppSelfParticipant(
        {
          id: '123456789012345@lid',
          phoneNumber: '15551234567@s.whatsapp.net',
        },
        { lid: LID },
      ),
    ).toBe(true);
    expect(
      isWhatsAppSelfParticipant(
        { id: '123456789012345@lid' },
        { id: PN, lid: LID },
      ),
    ).toBe(true);
    expect(
      isWhatsAppSelfParticipant({ id: '123456789012345@lid' }, { id: PN }),
    ).toBe(false);
    expect(
      isWhatsAppSelfParticipant(
        { id: '999@lid', phoneNumber: '15550001111@s.whatsapp.net' },
        SELF,
      ),
    ).toBe(false);
  });
});

describe('isMentioningBot', () => {
  const SELF = '15551234567:42@s.whatsapp.net';
  const LID = '123456789012345:12@lid';
  const BOTH = { id: SELF, lid: LID };

  test('returns false when mentions empty', () => {
    expect(
      isMentioningBot(
        { extendedTextMessage: { text: 'hi' } } as proto.IMessage,
        SELF,
      ),
    ).toBe(false);
  });

  test('returns true when bot jid mentioned (with device suffix variants)', () => {
    expect(
      isMentioningBot(
        {
          extendedTextMessage: {
            text: '@bot hi',
            contextInfo: {
              mentionedJid: ['15551234567@s.whatsapp.net'],
            },
          },
        } as proto.IMessage,
        SELF,
      ),
    ).toBe(true);
  });

  test('returns false when other user mentioned', () => {
    expect(
      isMentioningBot(
        {
          extendedTextMessage: {
            text: '@friend hi',
            contextInfo: {
              mentionedJid: ['9999999999@s.whatsapp.net'],
            },
          },
        } as proto.IMessage,
        SELF,
      ),
    ).toBe(false);
  });

  test('mention also detected on imageMessage contextInfo', () => {
    expect(
      isMentioningBot(
        {
          imageMessage: {
            caption: '@bot look',
            contextInfo: {
              mentionedJid: ['15551234567@s.whatsapp.net'],
            },
          },
        } as proto.IMessage,
        SELF,
      ),
    ).toBe(true);
  });

  test('fail-closed: no selfJid → returns false (drop instead of letting through)', () => {
    // 过去这里 fail-open（returns true），让 require_mention 模式下在 socket
    // reconnect / 启动毫秒级窗口被绕过。改为 fail-closed：selfJid 未知时
    // 回 false，主消息处理流走 shouldProcessGroupMessage 丢弃逻辑。
    expect(
      isMentioningBot(
        {
          extendedTextMessage: {
            contextInfo: { mentionedJid: ['anyone@s.whatsapp.net'] },
          },
        } as proto.IMessage,
        null,
      ),
    ).toBe(false);
  });

  test('PN-only self does not guess a LID mention as the same person', () => {
    // Old exact jidNormalizedUser compare also failed here. We still must not
    // equate the two ID spaces when sock.user.lid is missing.
    expect(
      isMentioningBot(
        {
          extendedTextMessage: {
            contextInfo: { mentionedJid: ['123456789012345@lid'] },
          },
        } as proto.IMessage,
        SELF,
      ),
    ).toBe(false);
  });

  test('matches a LID mention when sock.user also exposes lid', () => {
    expect(
      isMentioningBot(
        {
          extendedTextMessage: {
            contextInfo: { mentionedJid: ['123456789012345@lid'] },
          },
        } as proto.IMessage,
        BOTH,
      ),
    ).toBe(true);
    expect(
      isMentioningBot(
        {
          extendedTextMessage: {
            contextInfo: { mentionedJid: ['15551234567@s.whatsapp.net'] },
          },
        } as proto.IMessage,
        BOTH,
      ),
    ).toBe(true);
  });

  test('matches hosted aliases of the same PN or LID', () => {
    expect(
      isMentioningBot(
        {
          extendedTextMessage: {
            contextInfo: { mentionedJid: ['15551234567@hosted'] },
          },
        } as proto.IMessage,
        SELF,
      ),
    ).toBe(true);
    expect(
      isMentioningBot(
        {
          extendedTextMessage: {
            contextInfo: { mentionedJid: ['123456789012345@hosted.lid'] },
          },
        } as proto.IMessage,
        BOTH,
      ),
    ).toBe(true);
  });
});

describe('stripLeadingWhatsAppBotMention', () => {
  const SELF = '15551234567:42@s.whatsapp.net';
  const trustedMention = {
    extendedTextMessage: {
      text: '@15551234567 确认发布 AGENT-A1B2C3D4',
      contextInfo: { mentionedJid: ['15551234567@s.whatsapp.net'] },
    },
  } as proto.IMessage;

  test('strips only the leading trusted bot mention', () => {
    expect(
      stripLeadingWhatsAppBotMention(
        '@15551234567 确认发布 AGENT-A1B2C3D4',
        trustedMention,
        SELF,
      ),
    ).toBe('确认发布 AGENT-A1B2C3D4');
  });

  test('strips a leading LID display token when the bot was mentioned as LID', () => {
    const lidMention = {
      extendedTextMessage: {
        text: '@123456789012345 确认发布',
        contextInfo: { mentionedJid: ['123456789012345@lid'] },
      },
    } as proto.IMessage;
    expect(
      stripLeadingWhatsAppBotMention('@123456789012345 确认发布', lidMention, {
        id: SELF,
        lid: '123456789012345:12@lid',
      }),
    ).toBe('确认发布');
  });

  test('keeps untrusted, non-leading, prefix-collision, and mention-only text', () => {
    const untrusted = {
      extendedTextMessage: {
        contextInfo: { mentionedJid: ['999999@s.whatsapp.net'] },
      },
    } as proto.IMessage;
    expect(
      stripLeadingWhatsAppBotMention('@15551234567 确认发布', untrusted, SELF),
    ).toBe('@15551234567 确认发布');
    expect(
      stripLeadingWhatsAppBotMention(
        '请 @15551234567 确认发布',
        trustedMention,
        SELF,
      ),
    ).toBe('请 @15551234567 确认发布');
    expect(
      stripLeadingWhatsAppBotMention(
        '@155512345678 确认发布',
        trustedMention,
        SELF,
      ),
    ).toBe('@155512345678 确认发布');
    expect(
      stripLeadingWhatsAppBotMention('@15551234567', trustedMention, SELF),
    ).toBe('@15551234567');
  });
});

describe('buildWhatsAppSendFileContent', () => {
  const buf = Buffer.from('x');

  test('only MP4 uses native video', () => {
    expect(buildWhatsAppSendFileContent(buf, 'clip.mp4')).toEqual({
      video: buf,
      mimetype: 'video/mp4',
    });
    expect(buildWhatsAppSendFileContent(buf, 'clip.MOV')).toEqual({
      document: buf,
      mimetype: 'video/quicktime',
      fileName: 'clip.MOV',
    });
    expect(buildWhatsAppSendFileContent(buf, 'clip.webm')).toEqual({
      document: buf,
      mimetype: 'video/webm',
      fileName: 'clip.webm',
    });
  });

  test('allowlisted OGG/MP3/M4A use native audio with correct M4A MIME', () => {
    expect(buildWhatsAppSendFileContent(buf, 'voice.ogg')).toEqual({
      audio: buf,
      mimetype: 'audio/ogg',
    });
    expect(buildWhatsAppSendFileContent(buf, 'track.mp3')).toEqual({
      audio: buf,
      mimetype: 'audio/mpeg',
    });
    expect(buildWhatsAppSendFileContent(buf, 'track.m4a')).toEqual({
      audio: buf,
      mimetype: 'audio/mp4',
    });
    expect(buildWhatsAppSendFileContent(buf, 'wave.wav')).toEqual({
      document: buf,
      mimetype: 'audio/wav',
      fileName: 'wave.wav',
    });
  });

  test('pdf and unknown stay document', () => {
    expect(buildWhatsAppSendFileContent(buf, 'notes.pdf')).toEqual({
      document: buf,
      mimetype: 'application/pdf',
      fileName: 'notes.pdf',
    });
    expect(buildWhatsAppSendFileContent(buf, 'blob.bin')).toEqual({
      document: buf,
      mimetype: 'application/octet-stream',
      fileName: 'blob.bin',
    });
  });
});
