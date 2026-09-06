import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'message-ingest-sequence-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');

vi.mock('../src/config.js', () => ({
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function store(jid: string, id: string, timestamp: string, content = id): void {
  db.ensureChatExists(jid);
  db.storeMessageDirect(id, jid, 'user', 'User', content, timestamp, false);
}

describe('host message ingest sequence', () => {
  test('paginates 52 same-timestamp rows without gaps or duplicates', () => {
    db.initDatabase();
    const jid = 'telegram:same-second#account:test';
    const timestamp = '2026-08-31T00:00:00.000Z';
    const inserted = Array.from(
      { length: 52 },
      (_, index) => `id-${String(51 - index).padStart(2, '0')}`,
    );
    for (const id of inserted) store(jid, id, timestamp);

    const seen: string[] = [];
    let beforeSequence: number | undefined;
    do {
      const page = db.getMessagesPage(jid, undefined, 10, beforeSequence);
      seen.push(...page.map((message) => message.id));
      beforeSequence = page.at(-1)?.ingest_sequence;
      if (page.length < 10) break;
    } while (beforeSequence !== undefined);

    expect(seen).toEqual([...inserted].reverse());
    expect(new Set(seen).size).toBe(52);
    expect(db.getMessagesPage(jid, undefined, 10, 0)).toEqual([]);
    expect(db.getMessagesPageMulti([jid], undefined, 10, 0)).toEqual([]);
  });

  test('consumes same-second random IDs and late old timestamps by arrival order', () => {
    const jid = 'whatsapp:late-clock#account:test';
    const timestamp = '2026-08-31T01:00:00.000Z';
    store(jid, 'z-random-id', timestamp);
    const first = db.getMessageCursor(jid, 'z-random-id')!;

    store(jid, 'a-random-id', timestamp);
    store(jid, 'late-old-clock', '2020-01-01T00:00:00.000Z');

    expect(
      db.getMessagesSince(jid, first).map((message) => message.id),
    ).toEqual(['a-random-id', 'late-old-clock']);
  });

  test('keeps sequence stable across replace and database restart', () => {
    const jid = 'web:restart-sequence';
    const firstTimestamp = '2026-08-31T02:00:00.000Z';
    store(jid, 'replace-me', firstTimestamp, 'first');
    const beforeReplace = db.getMessageCursor(jid, 'replace-me')!;

    store(jid, 'replace-me', '2026-08-31T03:00:00.000Z', 'updated');
    expect(db.getMessageCursor(jid, 'replace-me')?.sequence).toBe(
      beforeReplace.sequence,
    );

    db.closeDatabase();
    db.initDatabase();
    const restored = db.resolveMessageCursorSequence(
      { timestamp: firstTimestamp, id: 'replace-me' },
      jid,
    );
    expect(restored.sequence).toBe(beforeReplace.sequence);

    store(jid, 'after-restart', '2019-01-01T00:00:00.000Z');
    expect(
      db.getMessagesSince(jid, restored).map((message) => message.id),
    ).toEqual(['after-restart']);
  });

  test('uses one stable sequence across multi-JID history and incremental polling', () => {
    const left = 'web:multi-left';
    const right = 'feishu:multi-right#account:test';
    const timestamp = '2026-08-31T04:00:00.000Z';
    const ids = Array.from({ length: 52 }, (_, index) => `multi-${index}`);
    ids.forEach((id, index) =>
      store(index % 2 === 0 ? left : right, id, timestamp),
    );

    const firstPage = db.getMessagesPageMulti([left, right], undefined, 17);
    const secondPage = db.getMessagesPageMulti(
      [left, right],
      undefined,
      17,
      firstPage.at(-1)!.ingest_sequence,
    );
    expect([...firstPage, ...secondPage].map((message) => message.id)).toEqual(
      [...ids].reverse().slice(0, 34),
    );

    const after = firstPage.at(-1)!.ingest_sequence!;
    expect(
      db
        .getMessagesAfterMulti([left, right], '', 100, after)
        .map((message) => message.id),
    ).toEqual(
      firstPage
        .slice(0, -1)
        .reverse()
        .map((message) => message.id),
    );
  });

  test('unknown deleted legacy anchor fails safe by replaying instead of skipping', () => {
    const jid = 'web:missing-legacy-anchor';
    store(jid, 'still-present', '2026-08-31T05:00:00.000Z');
    const legacy = db.resolveMessageCursorSequence(
      {
        timestamp: '2026-08-31T04:59:59.000Z',
        id: 'already-deleted-before-v74',
      },
      jid,
    );
    expect(legacy.sequence).toBe(0);
    expect(
      db.getMessagesSince(jid, legacy).map((message) => message.id),
    ).toEqual(['still-present']);
  });

  test('replays fresh-session history by host arrival rather than provider clock', () => {
    const jid = 'telegram:history-order#account:test';
    store(jid, 'first-arrival', '2026-08-31T06:00:00.000Z');
    store(jid, 'late-old-clock', '2020-01-01T00:00:00.000Z');

    // The API is newest-first; buildRecentConversationHistoryContext reverses
    // this page and therefore presents first-arrival before late-old-clock.
    expect(
      db
        .getConversationHistoryMessagesPage(jid, new Set(), 30)
        .map((message) => message.id),
    ).toEqual(['late-old-clock', 'first-arrival']);
  });
});
