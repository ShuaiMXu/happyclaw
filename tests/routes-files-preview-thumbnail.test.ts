/**
 * Covers the `?thumb=1` low-resolution preview variant added to
 * GET /api/groups/:jid/files/preview/:path:
 *
 *   - Raster images (png/jpeg/webp) get a downscaled webp thumbnail on first
 *     request, cached on disk, and reused (not regenerated) on repeat hits.
 *   - The thumbnail is strictly smaller than the original in byte size.
 *   - Non-raster / unsupported files fall back to serving the original
 *     bytes untouched rather than erroring.
 *   - Requesting without `?thumb=1` still returns the original, unresized
 *     file (no behavior change for existing callers).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import sharp from 'sharp';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-routes-files-thumbnail-'),
    );
    process.env.HAPPYCLAW_TEST_DATA_DIR = d;
    return d;
  })();

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const dataDir = process.env.HAPPYCLAW_TEST_DATA_DIR!;
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: process.env.HAPPYCLAW_TEST_USER_ID ?? 'alice',
      username: 'alice',
      role: 'member',
      status: 'active',
      permissions: [],
    });
    return next();
  },
}));

const fileRoutesModule = await import('../src/routes/files.js');
const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');

const fileRoutes = fileRoutesModule.default;

const OWNER_ID = 'alice';
const JID = 'web:thumb-group';
const FOLDER = 'thumb-group';

beforeAll(() => {
  fs.mkdirSync(path.join(SHARED_TMP, 'db'), { recursive: true });
  fs.mkdirSync(path.join(SHARED_TMP, 'groups'), { recursive: true });
  db.initDatabase();
  webContext.setWebDeps({
    getRegisteredGroups: () => ({}),
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

  db.setRegisteredGroup(JID, {
    name: 'Thumb Group',
    folder: FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: OWNER_ID,
    conversation_source: 'web',
  } as Parameters<typeof db.setRegisteredGroup>[1]);
});

afterEach(() => {
  delete process.env.HAPPYCLAW_TEST_USER_ID;
});

function toBase64Url(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url');
}

async function writeLargePng(relativePath: string): Promise<string> {
  const absolute = path.join(SHARED_TMP, 'groups', FOLDER, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  // Large enough that a 1024px-bounded resize meaningfully shrinks it.
  const buffer = await sharp({
    create: {
      width: 2000,
      height: 1500,
      channels: 3,
      background: { r: 120, g: 180, b: 220 },
    },
  })
    .png()
    .toBuffer();
  fs.writeFileSync(absolute, buffer);
  return absolute;
}

describe('GET /:jid/files/preview/:path?thumb=1', () => {
  test('generates a smaller cached webp thumbnail for a raster image', async () => {
    const relativePath = 'generated-images/big.png';
    await writeLargePng(relativePath);
    const encoded = toBase64Url(relativePath);

    const originalRes = await fileRoutes.request(
      `/${JID}/files/preview/${encoded}`,
    );
    expect(originalRes.status).toBe(200);
    const originalBytes = Buffer.from(await originalRes.arrayBuffer());

    const thumbRes = await fileRoutes.request(
      `/${JID}/files/preview/${encoded}?thumb=1`,
    );
    expect(thumbRes.status).toBe(200);
    expect(thumbRes.headers.get('content-type')).toBe('image/webp');
    const thumbBytes = Buffer.from(await thumbRes.arrayBuffer());
    expect(thumbBytes.length).toBeGreaterThan(0);
    expect(thumbBytes.length).toBeLessThan(originalBytes.length);

    const meta = await sharp(thumbBytes).metadata();
    expect(meta.width).toBeLessThanOrEqual(1024);
    expect(meta.height).toBeLessThanOrEqual(1024);

    // Cached: a second request must not regenerate the file (same bytes,
    // same mtime — verified via ETag reuse).
    const cachedRes = await fileRoutes.request(
      `/${JID}/files/preview/${encoded}?thumb=1`,
    );
    expect(cachedRes.status).toBe(200);
    expect(cachedRes.headers.get('etag')).toBe(thumbRes.headers.get('etag'));
  });

  test('without ?thumb=1 still serves the original, unresized file', async () => {
    const relativePath = 'generated-images/untouched.png';
    await writeLargePng(relativePath);
    const encoded = toBase64Url(relativePath);

    const res = await fileRoutes.request(`/${JID}/files/preview/${encoded}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(bytes).metadata();
    expect(meta.width).toBe(2000);
    expect(meta.height).toBe(1500);
  });

  test('falls back to the original for a non-raster file instead of erroring', async () => {
    const relativePath = 'generated-images/notes.txt';
    const absolute = path.join(SHARED_TMP, 'groups', FOLDER, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, 'plain text content');
    const encoded = toBase64Url(relativePath);

    const res = await fileRoutes.request(
      `/${JID}/files/preview/${encoded}?thumb=1`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(await res.text()).toBe('plain text content');
  });
});
