/**
 * Knowledge Base routes — content collection, categorization, and retrieval.
 *
 * Storage: SQLite tables (knowledge_categories, knowledge_clips) + FTS5 full-text search.
 * Auth: Bearer token (for Chrome Extension) or Cookie session.
 */

import { Hono } from 'hono';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Variables } from '../web-context.js';
import { cookieOrApiToken } from '../middleware/api-token.js';
import {
  createKnowledgeCategory,
  getKnowledgeCategories,
  updateKnowledgeCategory,
  deleteKnowledgeCategory,
  createKnowledgeClip,
  getKnowledgeClips,
  getKnowledgeClipById,
  updateKnowledgeClip,
  deleteKnowledgeClip,
  searchKnowledgeClips,
  getKnowledgeClipsByCategory,
  getKnowledgeStats,
  batchDeleteKnowledgeClips,
  setKnowledgeClipMirrorPath,
  getKnowledgeClipMirrorPath,
  getUserHomeGroup,
  createTask,
} from '../db.js';
import {
  mirrorClipToWorkspace,
  removeClipMirror,
} from '../knowledge-mirror.js';
import { GROUPS_DIR } from '../config.js';
import {
  KnowledgeCategoryCreateSchema,
  KnowledgeCategoryUpdateSchema,
  KnowledgeClipCreateSchema,
  KnowledgeClipUpdateSchema,
  KnowledgeSearchSchema,
} from '../schemas.js';
import { logger } from '../logger.js';

const knowledgeRoutes = new Hono<{ Variables: Variables }>();

// All routes accept either cookie session (web UI) or a `knowledge`-scoped
// Bearer token (Chrome Extension / external clients).
knowledgeRoutes.use('*', cookieOrApiToken('knowledge'));

// ─── Categories ──────────────────────────────────────────────────────────────

// List categories for current user
knowledgeRoutes.get('/categories', async (c) => {
  const user = c.get('user');
  const categories = getKnowledgeCategories(user.id);
  return c.json(categories);
});

// Create category
knowledgeRoutes.post('/categories', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = KnowledgeCategoryCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message }, 400);
  }
  const category = createKnowledgeCategory({
    ...parsed.data,
    user_id: user.id,
  });
  return c.json(category, 201);
});

// Update category
knowledgeRoutes.patch('/categories/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = KnowledgeCategoryUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message }, 400);
  }
  const updated = updateKnowledgeCategory(id, user.id, parsed.data);
  if (!updated) {
    return c.json({ error: 'Category not found' }, 404);
  }
  return c.json(updated);
});

// Delete category (clips in this category become uncategorized)
knowledgeRoutes.delete('/categories/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const deleted = deleteKnowledgeCategory(id, user.id);
  if (!deleted) {
    return c.json({ error: 'Category not found' }, 404);
  }
  return c.json({ ok: true });
});

// ─── Clips ───────────────────────────────────────────────────────────────────

// List clips (paginated, filterable by category)
knowledgeRoutes.get('/clips', async (c) => {
  const user = c.get('user');
  const categoryId = c.req.query('category_id') || undefined;
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  const clips = categoryId
    ? getKnowledgeClipsByCategory(user.id, categoryId, limit, offset)
    : getKnowledgeClips(user.id, limit, offset);

  return c.json(clips);
});

// Search clips (FTS5 full-text search)
knowledgeRoutes.get('/search', async (c) => {
  const user = c.get('user');
  const query = c.req.query('q') || '';
  const categoryId = c.req.query('category_id') || undefined;
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
  const level = (c.req.query('level') as 'l0' | 'l1' | 'l2') || 'l1';

  if (!query.trim()) {
    return c.json({ error: 'Query parameter "q" is required' }, 400);
  }

  const results = searchKnowledgeClips(user.id, query, {
    categoryId,
    limit,
    level,
  });
  return c.json(results);
});

// Get single clip
knowledgeRoutes.get('/clips/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const clip = getKnowledgeClipById(id, user.id);
  if (!clip) {
    return c.json({ error: 'Clip not found' }, 404);
  }
  return c.json(clip);
});

// Create clip
knowledgeRoutes.post('/clips', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = KnowledgeClipCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message }, 400);
  }
  const clip = createKnowledgeClip({
    ...parsed.data,
    user_id: user.id,
  });

  // Mirror to workspace markdown for llm-wiki-skill ingest pipeline.
  // Best-effort: SQLite insert is authoritative, mirror failure is non-fatal.
  const mirror = mirrorClipToWorkspace({
    clipId: clip.id,
    userId: user.id,
    title: clip.title,
    url: clip.url,
    content: clip.content,
    summary: clip.summary,
    sourceType: clip.source_type,
    tags: clip.tags,
    savedAt: clip.created_at,
  });
  if (mirror) {
    setKnowledgeClipMirrorPath(clip.id, mirror.relativePath);
  }

  return c.json({ ...clip, raw_md_path: mirror?.relativePath || null }, 201);
});

// Update clip
knowledgeRoutes.patch('/clips/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = KnowledgeClipUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message }, 400);
  }
  const updated = updateKnowledgeClip(id, user.id, parsed.data);
  if (!updated) {
    return c.json({ error: 'Clip not found' }, 404);
  }
  return c.json(updated);
});

// Delete clip
knowledgeRoutes.delete('/clips/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const mirrorPath = getKnowledgeClipMirrorPath(id);
  const deleted = deleteKnowledgeClip(id, user.id);
  if (!deleted) {
    return c.json({ error: 'Clip not found' }, 404);
  }
  if (mirrorPath) removeClipMirror(user.id, mirrorPath);
  return c.json({ ok: true });
});

// Batch delete clips
knowledgeRoutes.post('/clips/batch-delete', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return c.json({ error: '"ids" must be a non-empty array' }, 400);
  }
  const count = batchDeleteKnowledgeClips(ids, user.id);
  return c.json({ deleted: count });
});

// ─── Stats ───────────────────────────────────────────────────────────────────

knowledgeRoutes.get('/stats', async (c) => {
  const user = c.get('user');
  const stats = getKnowledgeStats(user.id);

  // Augment with wiki/ + raw/ counts if the user has a home group with
  // llm-wiki-skill pipeline set up.
  const home = getUserHomeGroup(user.id);
  let wikiStats: {
    raw_articles: number;
    wiki_sources: number;
    wiki_entities: number;
    wiki_topics: number;
    wiki_initialized: boolean;
  } | null = null;
  if (home) {
    const folderDir = path.join(GROUPS_DIR, home.folder);
    wikiStats = {
      raw_articles: countFilesRecursive(path.join(folderDir, 'raw', 'articles'), '.md'),
      wiki_sources: countFilesRecursive(path.join(folderDir, 'wiki', 'sources'), '.md'),
      wiki_entities: countFilesRecursive(path.join(folderDir, 'wiki', 'entities'), '.md'),
      wiki_topics: countFilesRecursive(path.join(folderDir, 'wiki', 'topics'), '.md'),
      wiki_initialized: fs.existsSync(path.join(folderDir, '.wiki-schema.md')),
    };
  }

  return c.json({ ...stats, wiki: wikiStats });
});

function countFilesRecursive(dir: string, ext: string): number {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        count += countFilesRecursive(path.join(dir, e.name), ext);
      } else if (e.isFile() && e.name.endsWith(ext)) {
        count += 1;
      }
    }
  } catch {
    /* ignore unreadable */
  }
  return count;
}

// ─── Ingest Trigger ──────────────────────────────────────────────────────────

// Trigger a one-time agent task to compile raw/articles/ into wiki/ via
// the llm-wiki-skill. Uses the existing scheduler (picks up within ~60s).
knowledgeRoutes.post('/ingest', async (c) => {
  const user = c.get('user');
  const home = getUserHomeGroup(user.id);
  if (!home) {
    return c.json({ error: 'No home workspace for this user' }, 400);
  }

  const now = new Date();
  const runAt = new Date(now.getTime() + 30_000).toISOString();
  const taskId = crypto.randomUUID();

  const prompt = [
    '你是知识库编译助手。请使用 llm-wiki-skill（user-skills 下的 `llm-wiki-skill`）执行以下流程：',
    '',
    '1. 如果当前工作目录还没有 `.wiki-schema.md`，先用 skill 的 `init` 动作初始化知识库：',
    '   - topic: 个人知识库（涵盖 AI 产品体验、AI 视频创作、DeFi 等方向）',
    '   - language: 中文',
    '   - wiki_root: 当前工作目录',
    '',
    '2. 扫描 `raw/articles/` 下所有 markdown 文件，对每个 frontmatter 里 `ingested_at: null` 的文件调用 skill 的 `ingest` 动作（或一次性 `batch-ingest` 整个目录）。',
    '',
    '3. ingest 完成后，把对应 raw markdown 文件 frontmatter 的 `ingested_at` 更新为当前 ISO 时间（用 Edit 工具替换 `ingested_at: null` → `ingested_at: <ISO>`），这样下次运行不会重复编译。',
    '',
    '4. 完成后输出一份简短汇总：本次编译了多少篇、新增/更新了多少个 entity 和 topic、是否有 skill 报告的冲突或待处理项。',
    '',
    '注意：raw/ 只读，所有产物都写到 wiki/。',
  ].join('\n');

  createTask({
    id: taskId,
    group_folder: home.folder,
    chat_jid: home.jid,
    prompt,
    schedule_type: 'once',
    schedule_value: runAt,
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: home.executionMode ?? null,
    script_command: null,
    next_run: runAt,
    status: 'active',
    created_at: now.toISOString(),
    created_by: user.id,
    notify_channels: null,
  });

  return c.json({ taskId, scheduledAt: runAt });
});

// ─── Export for chat (package clips for content creation) ────────────────────

// Package clips by category or date range for use in chat
knowledgeRoutes.post('/package', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const { category_id, date_from, date_to, format } = body || {};

  const limit = 100;
  let clips;
  if (category_id) {
    clips = getKnowledgeClipsByCategory(user.id, category_id, limit, 0);
  } else {
    clips = getKnowledgeClips(user.id, limit, 0);
  }

  // Filter by date range if specified
  if (date_from || date_to) {
    clips = clips.filter((clip: any) => {
      if (date_from && clip.created_at < date_from) return false;
      if (date_to && clip.created_at > date_to) return false;
      return true;
    });
  }

  // Format for different use cases
  if (format === 'markdown') {
    const md = clips
      .map(
        (clip: any) =>
          `## ${clip.title}\n\n> 来源: ${clip.url || '手动添加'}\n> 标签: ${(clip.tags || []).join(', ')}\n\n${clip.content}\n`,
      )
      .join('\n---\n\n');
    return c.json({ format: 'markdown', content: md, clip_count: clips.length });
  }

  // Default: structured JSON
  return c.json({
    format: 'json',
    clips: clips.map((clip: any) => ({
      title: clip.title,
      url: clip.url,
      summary: clip.summary,
      content: clip.content,
      tags: clip.tags,
      created_at: clip.created_at,
    })),
    clip_count: clips.length,
  });
});

export default knowledgeRoutes;
