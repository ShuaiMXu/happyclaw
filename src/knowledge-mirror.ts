// Mirror knowledge clips to the user's workspace as markdown files under
// `raw/articles/` — the input staging area for llm-wiki-skill's ingest pipeline.
//
// The SQLite `knowledge_clips` row remains the authoritative record for list /
// search / stats; the markdown mirror gives the Agent a deterministic, file-based
// view so it can use the llm-wiki `ingest` verb without hitting the API.

import fs from 'node:fs';
import path from 'node:path';
import { GROUPS_DIR } from './config.js';
import { getUserHomeGroup } from './db.js';
import { logger } from './logger.js';

const SLUG_FALLBACK = 'clip';
const MAX_SLUG_LEN = 60;
const MAX_BODY_BYTES = 500_000;

function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN);
  return cleaned || SLUG_FALLBACK;
}

function yamlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildMarkdown(params: {
  id: string;
  title: string;
  url: string | null;
  tags: string[];
  sourceType: string;
  savedAt: string;
  content: string;
  summary: string | null;
}): string {
  const tagsYaml =
    params.tags.length > 0
      ? params.tags.map((t) => `"${yamlEscape(t)}"`).join(', ')
      : '';
  const body = params.content.slice(0, MAX_BODY_BYTES);
  const summary = params.summary ? params.summary.trim() : '';

  return [
    '---',
    `clip_id: ${params.id}`,
    `title: "${yamlEscape(params.title)}"`,
    params.url ? `url: "${yamlEscape(params.url)}"` : 'url: null',
    `tags: [${tagsYaml}]`,
    `source_type: ${params.sourceType}`,
    `saved_at: ${params.savedAt}`,
    'ingested_at: null',
    '---',
    '',
    `# ${params.title}`,
    '',
    summary ? `> ${summary}` : '',
    summary ? '' : '',
    body,
    '',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

export interface MirrorResult {
  /** Workspace-relative path, e.g. `raw/articles/2026-04/2026-04-13-foo.md`. */
  relativePath: string;
  /** Absolute path on disk. */
  absolutePath: string;
}

/**
 * Write a clip to the user's workspace as `raw/articles/{YYYY-MM}/{date}-{slug}.md`.
 * Returns `null` if the user has no home group (should not happen after registration).
 * Silently swallows filesystem errors (SQLite insert remains authoritative).
 */
export function mirrorClipToWorkspace(params: {
  clipId: string;
  userId: string;
  title: string;
  url: string | null;
  content: string;
  summary: string | null;
  sourceType: string;
  tags: string[];
  savedAt: string;
}): MirrorResult | null {
  const home = getUserHomeGroup(params.userId);
  if (!home) {
    logger.warn({ userId: params.userId }, 'No home group; skipping clip mirror');
    return null;
  }

  const dateIso = params.savedAt.slice(0, 10); // YYYY-MM-DD
  const monthDir = params.savedAt.slice(0, 7); // YYYY-MM
  const slug = slugify(params.title);
  const fileName = `${dateIso}-${slug}-${params.clipId.slice(0, 8)}.md`;

  const relativePath = path.join('raw', 'articles', monthDir, fileName);
  const absolutePath = path.join(GROUPS_DIR, home.folder, relativePath);

  try {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    const md = buildMarkdown({
      id: params.clipId,
      title: params.title,
      url: params.url,
      tags: params.tags,
      sourceType: params.sourceType,
      savedAt: params.savedAt,
      content: params.content,
      summary: params.summary,
    });
    const tmp = `${absolutePath}.tmp`;
    fs.writeFileSync(tmp, md, 'utf-8');
    fs.renameSync(tmp, absolutePath);
    return { relativePath, absolutePath };
  } catch (err) {
    logger.error({ err, clipId: params.clipId }, 'Failed to mirror clip to workspace');
    return null;
  }
}

/** Remove the mirrored markdown file for a clip (best-effort). */
export function removeClipMirror(userId: string, relativePath: string): void {
  const home = getUserHomeGroup(userId);
  if (!home || !relativePath) return;
  const absolutePath = path.join(GROUPS_DIR, home.folder, relativePath);
  try {
    if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
  } catch (err) {
    logger.debug({ err, relativePath }, 'Failed to remove clip mirror');
  }
}
