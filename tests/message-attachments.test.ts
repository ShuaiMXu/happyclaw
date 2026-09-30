import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';
import {
  getStagedChatAttachmentStoragePath,
  normalizeImageAttachment,
  toAgentImages,
  writeStagedChatAttachment,
} from '../src/message-attachments.js';

const workspaceRoots: string[] = [];
const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const STAGED_PATH =
  'chat-attachments/staged/11111111-1111-4111-8111-111111111111.png';

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-attachments-'));
  workspaceRoots.push(root);
  fs.mkdirSync(path.join(root, 'ignored'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'ignored', path.basename(STAGED_PATH)),
    PNG_HEADER,
  );
  return root;
}

afterEach(() => {
  while (workspaceRoots.length > 0) {
    fs.rmSync(workspaceRoots.pop()!, { recursive: true, force: true });
  }
});

describe('path-backed message attachments', () => {
  test('hydrates a server-issued staged reference using detected bytes', () => {
    const root = makeWorkspace();
    const attachment = normalizeImageAttachment({
      type: 'image',
      path: STAGED_PATH,
      mimeType: 'image/jpeg',
      name: 'photo.png',
    });

    expect(attachment).toEqual({
      type: 'image',
      path: STAGED_PATH,
      mimeType: 'image/jpeg',
      name: 'photo.png',
    });
    const mismatches: Array<{ declaredMime: string; detectedMime: string }> =
      [];
    expect(
      toAgentImages(
        [attachment!],
        { folder: 'ignored', attachmentRootOverride: root },
        {
          onMimeMismatch: (mismatch) => mismatches.push(mismatch),
        },
      ),
    ).toEqual([{ data: PNG_HEADER.toString('base64'), mimeType: 'image/png' }]);
    expect(mismatches).toEqual([
      { declaredMime: 'image/jpeg', detectedMime: 'image/png' },
    ]);
  });

  test('stores staged bytes outside the runner workspace root', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-attachment-store-'),
    );
    workspaceRoots.push(root);
    writeStagedChatAttachment('workspace-a', STAGED_PATH, PNG_HEADER, root);

    const storagePath = getStagedChatAttachmentStoragePath(
      'workspace-a',
      STAGED_PATH,
      root,
    );
    expect(storagePath).toBe(
      path.join(root, 'workspace-a', path.basename(STAGED_PATH)),
    );
    expect(fs.readFileSync(storagePath)).toEqual(PNG_HEADER);
  });

  test('keeps legacy inline base64 attachments compatible', () => {
    const attachment = normalizeImageAttachment({
      type: 'image',
      data: PNG_HEADER.toString('base64'),
      mimeType: 'image/png',
    });

    expect(toAgentImages([attachment!])).toEqual([
      { data: PNG_HEADER.toString('base64'), mimeType: 'image/png' },
    ]);
  });

  test('rejects arbitrary workspace paths and requires a storage context', () => {
    expect(
      normalizeImageAttachment({
        type: 'image',
        path: 'generated-images/secret.png',
        mimeType: 'image/png',
      }),
    ).toBeNull();

    const attachment = normalizeImageAttachment({
      type: 'image',
      path: STAGED_PATH,
      mimeType: 'image/png',
    });
    expect(() => toAgentImages([attachment!])).toThrow(
      'Missing workspace context',
    );
  });

  test('rejects missing, symbolic-link, and unsupported staged files', () => {
    const root = makeWorkspace();
    const attachment = normalizeImageAttachment({
      type: 'image',
      path: STAGED_PATH,
      mimeType: 'image/png',
    })!;
    fs.unlinkSync(path.join(root, 'ignored', path.basename(STAGED_PATH)));
    expect(() =>
      toAgentImages([attachment], {
        folder: 'ignored',
        attachmentRootOverride: root,
      }),
    ).toThrow();

    fs.writeFileSync(path.join(root, 'outside.bin'), PNG_HEADER);
    fs.symlinkSync(
      path.join(root, 'outside.bin'),
      path.join(root, 'ignored', path.basename(STAGED_PATH)),
    );
    expect(() =>
      toAgentImages([attachment], {
        folder: 'ignored',
        attachmentRootOverride: root,
      }),
    ).toThrow('Invalid staged image attachment');

    fs.unlinkSync(path.join(root, 'ignored', path.basename(STAGED_PATH)));
    fs.writeFileSync(
      path.join(root, 'ignored', path.basename(STAGED_PATH)),
      'not an image',
    );
    expect(() =>
      toAgentImages([attachment], {
        folder: 'ignored',
        attachmentRootOverride: root,
      }),
    ).toThrow('not a supported image');
  });
});
