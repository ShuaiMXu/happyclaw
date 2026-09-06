import fs from 'fs';

export type SessionTrimLogger = (message: string) => void;

const PENDING_LAUNCH_STATUSES = new Set(['async_launched', 'remote_launched']);
const TRIM_MIN_ENTRIES = 50;

type TranscriptEntry = Record<string, unknown>;

type ParsedLine = {
  index: number;
  line: string;
  parsed: TranscriptEntry | null;
};

function defaultLog(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function collectText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => {
      if (typeof item === 'string') return item;
      const rec = asRecord(item);
      if (!rec) return '';
      if (typeof rec.text === 'string') return rec.text;
      if ('content' in rec) return collectText(rec.content);
      return '';
    })
    .join('');
}

function transcriptText(parsed: TranscriptEntry): string {
  const message = asRecord(parsed.message);
  if (message && 'content' in message) {
    const fromMessage = collectText(message.content);
    if (fromMessage) return fromMessage;
  }
  return collectText(parsed.content);
}

function entryUuid(parsed: TranscriptEntry): string | undefined {
  return typeof parsed.uuid === 'string' && parsed.uuid
    ? parsed.uuid
    : undefined;
}

function entryParentUuid(parsed: TranscriptEntry): string | undefined {
  return typeof parsed.parentUuid === 'string' && parsed.parentUuid
    ? parsed.parentUuid
    : undefined;
}

function launchAgentId(parsed: TranscriptEntry): string | undefined {
  const result = asRecord(parsed.toolUseResult);
  if (!result) return undefined;
  const status = result.status;
  if (typeof status !== 'string' || !PENDING_LAUNCH_STATUSES.has(status)) {
    return undefined;
  }
  const agentId = result.agentId;
  const taskId = result.taskId;
  if (typeof agentId === 'string' && agentId) return agentId;
  if (typeof taskId === 'string' && taskId) return taskId;
  return undefined;
}

function toolUseIdFromLaunch(parsed: TranscriptEntry): string | undefined {
  const message = asRecord(parsed.message);
  const content = message?.content;
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    const rec = asRecord(item);
    if (
      rec &&
      rec.type === 'tool_result' &&
      typeof rec.tool_use_id === 'string' &&
      rec.tool_use_id
    ) {
      return rec.tool_use_id;
    }
  }
  return undefined;
}

function assistantHasToolUse(
  parsed: TranscriptEntry,
  toolUseId: string,
): boolean {
  if (parsed.type !== 'assistant') return false;
  const message = asRecord(parsed.message);
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((item) => {
    const rec = asRecord(item);
    return rec?.type === 'tool_use' && rec.id === toolUseId;
  });
}

function originKind(parsed: TranscriptEntry): string | undefined {
  const origin = asRecord(parsed.origin);
  if (typeof origin?.kind === 'string') return origin.kind;
  const message = asRecord(parsed.message);
  const messageOrigin = asRecord(message?.origin);
  if (typeof messageOrigin?.kind === 'string') return messageOrigin.kind;
  return undefined;
}

function structuredTaskId(parsed: TranscriptEntry): string | undefined {
  const candidates = [
    parsed.task_id,
    parsed.taskId,
    parsed.agentId,
    asRecord(parsed.toolUseResult)?.task_id,
    asRecord(parsed.toolUseResult)?.taskId,
    asRecord(parsed.toolUseResult)?.agentId,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function xmlTaskId(text: string): string | undefined {
  const match = text.match(/<task-id>\s*([^<]+?)\s*<\/task-id>/i);
  const id = match?.[1]?.trim();
  return id || undefined;
}

/**
 * Completions are structured SDK records. XML is only accepted inside those
 * records so an assistant summary or pasted transcript cannot mark an
 * in-flight Task complete.
 */
function completedTaskId(parsed: TranscriptEntry): string | undefined {
  const kind = originKind(parsed);
  const isStructured =
    (parsed.type === 'system' && parsed.subtype === 'task_notification') ||
    (parsed.type === 'user' && kind === 'task-notification') ||
    parsed.type === 'queue-operation' ||
    kind === 'task-notification';
  if (!isStructured) return undefined;
  return structuredTaskId(parsed) ?? xmlTaskId(transcriptText(parsed));
}

function withParentUuid(
  parsed: TranscriptEntry,
  parentUuid: string | undefined,
): string {
  const next = { ...parsed };
  if (parentUuid) next.parentUuid = parentUuid;
  else delete next.parentUuid;
  return JSON.stringify(next);
}

/**
 * Keep unfinished Task launch records that would otherwise be deleted before
 * compact_boundary, together with their assistant tool_use partner so resume
 * does not see a dangling parentUuid / tool_use_id.
 */
function unfinishedLaunchLines(
  removedRegion: ParsedLine[],
  allLines: ParsedLine[],
  attachParentUuid: string | undefined,
): string[] {
  const pending: {
    agentId: string;
    line: ParsedLine;
  }[] = [];
  for (const entry of removedRegion) {
    if (!entry.parsed) continue;
    const agentId = launchAgentId(entry.parsed);
    if (agentId) pending.push({ agentId, line: entry });
  }
  if (pending.length === 0) return [];

  const completed = new Set<string>();
  for (const entry of allLines) {
    if (!entry.parsed) continue;
    const taskId = completedTaskId(entry.parsed);
    if (taskId) completed.add(taskId);
  }

  const keptUuids = new Set<string>();
  const preserved: string[] = [];

  for (const launch of pending) {
    if (completed.has(launch.agentId)) continue;
    const parsed = launch.line.parsed!;
    const toolUseId = toolUseIdFromLaunch(parsed);
    const parentUuid = entryParentUuid(parsed);

    const assistant = removedRegion.find((entry) => {
      if (!entry.parsed) return false;
      const uuid = entryUuid(entry.parsed);
      if (uuid && keptUuids.has(uuid)) return false;
      if (toolUseId && assistantHasToolUse(entry.parsed, toolUseId)) {
        return true;
      }
      return Boolean(parentUuid && uuid === parentUuid);
    });

    if (assistant?.parsed) {
      const assistantUuid = entryUuid(assistant.parsed);
      if (assistantUuid) keptUuids.add(assistantUuid);
      preserved.push(withParentUuid(assistant.parsed, attachParentUuid));
      preserved.push(withParentUuid(parsed, assistantUuid ?? attachParentUuid));
    } else {
      preserved.push(withParentUuid(parsed, attachParentUuid));
    }
    const launchUuid = entryUuid(parsed);
    if (launchUuid) keptUuids.add(launchUuid);
  }

  return preserved;
}

/**
 * Trim session JSONL file by removing all entries before the last compact_boundary.
 * After compaction, entries before the boundary are already summarized and no longer
 * needed for session reconstruction. This prevents unbounded file growth.
 *
 * Safety: uses atomic write (tmp + rename) to avoid data loss on crash.
 */
export function trimSessionJsonl(
  jsonlPath: string,
  log: SessionTrimLogger = defaultLog,
): void {
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = content.split('\n');
    const nonEmptyLines: ParsedLine[] = [];
    let parseSkipped = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        nonEmptyLines.push({
          index: i,
          line: lines[i],
          parsed: JSON.parse(lines[i]) as TranscriptEntry,
        });
      } catch {
        parseSkipped++;
        nonEmptyLines.push({ index: i, line: lines[i], parsed: null });
      }
    }

    let lastBoundaryPos = -1;
    let preservedHeadUuid: string | undefined;
    for (let i = nonEmptyLines.length - 1; i >= 0; i--) {
      const entry = nonEmptyLines[i].parsed;
      if (!entry) continue;
      if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
        lastBoundaryPos = i;
        const metadata = asRecord(entry.compact_metadata);
        const preserved = asRecord(metadata?.preserved_segment);
        preservedHeadUuid =
          typeof preserved?.head_uuid === 'string'
            ? preserved.head_uuid
            : undefined;
        break;
      }
    }
    if (parseSkipped > 0) {
      log(`Session trim: skipped ${parseSkipped} unparseable JSONL lines`);
    }

    if (lastBoundaryPos <= 0) {
      log('Session trim: no compact_boundary found or already minimal');
      return;
    }

    // partial compaction 时 boundary 带 preserved_segment{head_uuid, anchor_uuid, tail_uuid}：
    // 保留段内容是 head_uuid..tail_uuid，SDK 的 resume loader 会在 anchor_uuid 处把它拼回。
    // 若裁切越过 head_uuid，会连同这些消息及其 uuid 一起删掉，导致 loader 找不到锚点、resume
    // 丢上下文。因此把裁切起点回退到 head_uuid 所在行，保住整段保留消息。
    let trimStartPos = lastBoundaryPos;
    if (preservedHeadUuid) {
      const preservedPos = nonEmptyLines.findIndex(
        (e) => e.parsed && entryUuid(e.parsed) === preservedHeadUuid,
      );
      if (preservedPos >= 0 && preservedPos < trimStartPos) {
        trimStartPos = preservedPos;
        log(
          `Session trim: preserving segment from head_uuid=${preservedHeadUuid.slice(0, 8)} (pos ${preservedPos} < boundary ${lastBoundaryPos})`,
        );
      }
    }

    const removedRegion = nonEmptyLines.slice(0, trimStartPos);
    const preservedSegment = nonEmptyLines.slice(trimStartPos, lastBoundaryPos);
    const boundaryAndAfter = nonEmptyLines.slice(lastBoundaryPos);
    const attachParentUuid = boundaryAndAfter[0]?.parsed
      ? entryUuid(boundaryAndAfter[0].parsed)
      : undefined;
    const preservedLaunchLines = unfinishedLaunchLines(
      removedRegion,
      nonEmptyLines,
      attachParentUuid,
    );
    if (preservedLaunchLines.length > 0) {
      log(
        `Session trim: preserving ${preservedLaunchLines.length} pending async_launched entries to prevent orphan detection`,
      );
    }

    // Insert unfinished launches immediately before compact_boundary so a
    // preserved_segment.head_uuid stays the first kept history line.
    const trimmedLines = [
      ...preservedSegment.map((e) => e.line),
      ...preservedLaunchLines,
      ...boundaryAndAfter.map((e) => e.line),
    ];
    const historyBeforeBoundary = trimStartPos;
    const removedCount = historyBeforeBoundary - preservedLaunchLines.length;

    if (historyBeforeBoundary < TRIM_MIN_ENTRIES) {
      log(
        `Session trim: only ${historyBeforeBoundary} entries before boundary, skipping`,
      );
      return;
    }

    const tmpPath = jsonlPath + '.trim-tmp';
    fs.writeFileSync(tmpPath, trimmedLines.join('\n') + '\n');
    fs.renameSync(tmpPath, jsonlPath);

    const sizeBefore = Buffer.byteLength(content, 'utf-8');
    const sizeAfter = fs.statSync(jsonlPath).size;
    log(
      `Session trim: ${nonEmptyLines.length} → ${trimmedLines.length} entries (removed ${removedCount}), ` +
        `${(sizeBefore / 1024 / 1024).toFixed(1)}MB → ${(sizeAfter / 1024 / 1024).toFixed(1)}MB`,
    );
  } catch (err) {
    log(
      `Session trim failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
