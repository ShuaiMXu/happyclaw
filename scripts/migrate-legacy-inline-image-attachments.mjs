#!/usr/bin/env node
// One-off migration: convert legacy `__image_generation__` messages that
// still embed base64 image data inline in `messages.attachments` into
// file-backed attachments (generated-images/<file> + { type, path, mimeType }),
// matching the format POST /api/groups/:jid/generate-image has written since
// commit 67115a0. Inline rows bloat the gallery listing response and defeat
// the browser image cache. Safe to re-run: only rows with a `data` field and
// no `path` are touched.
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const DB_PATH = path.join(process.cwd(), 'data/db/messages.db');
const GROUPS_DIR = path.join(process.cwd(), 'data/groups');

const db = new Database(DB_PATH);

const rows = db
  .prepare(
    `SELECT id, chat_jid, attachments FROM messages
     WHERE sender = '__image_generation__' AND attachments LIKE '%"data"%'`,
  )
  .all();

console.log(`found ${rows.length} candidate row(s)`);

const groupFolderStmt = db.prepare(
  `SELECT folder FROM registered_groups WHERE jid = ?`,
);
const update = db.prepare(
  `UPDATE messages SET attachments = ? WHERE id = ? AND chat_jid = ?`,
);

let migrated = 0;
for (const row of rows) {
  const group = groupFolderStmt.get(row.chat_jid);
  if (!group) {
    console.warn(
      `skip ${row.id}: no registered_groups row for ${row.chat_jid}`,
    );
    continue;
  }
  let attachments;
  try {
    attachments = JSON.parse(row.attachments);
  } catch {
    console.warn(`skip ${row.id}: attachments not valid JSON`);
    continue;
  }
  if (!Array.isArray(attachments)) continue;

  let changed = false;
  const relativeDir = 'generated-images';
  const absoluteDir = path.join(GROUPS_DIR, group.folder, relativeDir);

  const nextAttachments = attachments.map((att, idx) => {
    if (
      !att ||
      typeof att !== 'object' ||
      att.type !== 'image' ||
      !att.data ||
      att.path
    ) {
      return att;
    }
    const mimeType = att.mimeType || 'image/png';
    const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1];
    const fileName = `legacy-${row.id}-${idx}-${crypto
      .randomUUID()
      .slice(0, 8)}.${ext}`;
    fs.mkdirSync(absoluteDir, { recursive: true });
    fs.writeFileSync(
      path.join(absoluteDir, fileName),
      Buffer.from(att.data, 'base64'),
    );
    changed = true;
    return { type: 'image', path: `${relativeDir}/${fileName}`, mimeType };
  });

  if (changed) {
    update.run(JSON.stringify(nextAttachments), row.id, row.chat_jid);
    migrated++;
    console.log(`migrated ${row.id} (chat ${row.chat_jid})`);
  }
}

console.log(`done: ${migrated} row(s) migrated`);
db.close();
