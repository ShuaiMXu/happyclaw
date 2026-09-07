import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-inbound-order-'));
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

describe('WeCom inbound cursor ordering', () => {
  test('keeps every same-second event visible across successive DB cursors', () => {
    db.initDatabase();
    const jid = 'wecom:c2c:user-1#account:account-1';
    db.ensureChatExists(jid);
    const proposed = '2026-08-15T00:00:00.000Z';
    const timestamps: string[] = [];

    for (const id of ['wecom-a', 'wecom-b', 'wecom-c']) {
      const timestamp = db.sequenceInboundTimestampAfterChatTail(jid, proposed);
      timestamps.push(timestamp);
      db.storeMessageDirect(
        id,
        jid,
        'wecom:user-1',
        'User 1',
        id,
        timestamp,
        false,
      );
    }

    expect(timestamps).toEqual([
      '2026-08-15T00:00:00.000Z',
      '2026-08-15T00:00:00.001Z',
      '2026-08-15T00:00:00.002Z',
    ]);
    expect(
      db
        .getMessagesSince(jid, { timestamp: timestamps[0], id: 'wecom-a' })
        .map((message) => message.id),
    ).toEqual(['wecom-b', 'wecom-c']);
    expect(
      db
        .getMessagesSince(jid, { timestamp: timestamps[1], id: 'wecom-b' })
        .map((message) => message.id),
    ).toEqual(['wecom-c']);
  });
});
