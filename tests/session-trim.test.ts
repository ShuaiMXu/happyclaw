import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { trimSessionJsonl } from '../container/agent-runner/src/session-trim.js';

const TASK_ID = 'agent-bg-research-1';
const TASK_ID_2 = 'agent-bg-review-2';
const LAUNCH_UUID = 'async-launch-uuid';
const ASSISTANT_UUID = 'assistant-tool-use-uuid';
const TOOL_USE_ID = 'toolu-task-1';

function assistantToolUse(taskId = TASK_ID, uuid = ASSISTANT_UUID) {
  return {
    type: 'assistant',
    uuid,
    parentUuid: 'older-deleted',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: TOOL_USE_ID,
          name: 'Task',
          input: { description: taskId },
        },
      ],
    },
  };
}

function launchEntry(
  taskId = TASK_ID,
  status: 'async_launched' | 'remote_launched' = 'async_launched',
  uuid = LAUNCH_UUID,
) {
  return {
    type: 'user',
    uuid,
    parentUuid: ASSISTANT_UUID,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: TOOL_USE_ID,
          content: `Background agent launched: ${taskId}`,
        },
      ],
    },
    toolUseResult: {
      status,
      agentId: taskId,
      taskId,
    },
  };
}

function dummyEntry(i: number) {
  return {
    type: 'user',
    uuid: `dummy-${i}`,
    parentUuid: i === 0 ? LAUNCH_UUID : `dummy-${i - 1}`,
    message: { role: 'user', content: `dummy ${i}` },
  };
}

function compactBoundary(headUuid?: string) {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 'compact-boundary-1',
    compact_metadata: headUuid
      ? {
          trigger: 'auto',
          preserved_segment: {
            head_uuid: headUuid,
            anchor_uuid: 'anchor-1',
            tail_uuid: headUuid,
          },
        }
      : { trigger: 'auto' },
  };
}

function structuredTaskNotification(taskId: string) {
  return {
    type: 'user',
    uuid: `task-notification-${taskId}`,
    origin: { kind: 'task-notification' },
    message: {
      role: 'user',
      origin: { kind: 'task-notification' },
      content: `<task-notification><task-id>${taskId}</task-id><status>completed</status></task-notification>`,
    },
    task_id: taskId,
  };
}

function assistantMentioningTask(taskId: string) {
  return {
    type: 'assistant',
    uuid: 'assistant-mentions-task',
    message: {
      role: 'assistant',
      content: `summary <task-notification><task-id>${taskId}</task-id></task-notification>`,
    },
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-trim-test-'));
});

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function writeJsonl(name: string, entries: object[]): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(
    filePath,
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );
  return filePath;
}

function readJsonl(filePath: string): Record<string, unknown>[] {
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('trimSessionJsonl', () => {
  test('keeps an unfinished async_launched Task and its assistant tool_use', () => {
    const transcriptPath = writeJsonl('session.jsonl', [
      assistantToolUse(),
      launchEntry(),
      ...Array.from({ length: 50 }, (_, i) => dummyEntry(i)),
      compactBoundary(),
    ]);

    trimSessionJsonl(transcriptPath, () => {});

    const kept = readJsonl(transcriptPath);
    expect(kept.some((entry) => entry.uuid === ASSISTANT_UUID)).toBe(true);
    expect(kept.some((entry) => entry.uuid === LAUNCH_UUID)).toBe(true);
    const launch = kept.find((entry) => entry.uuid === LAUNCH_UUID)!;
    expect(launch.parentUuid).toBe(ASSISTANT_UUID);
    const assistant = kept.find((entry) => entry.uuid === ASSISTANT_UUID)!;
    expect(assistant.parentUuid).toBe('compact-boundary-1');
    expect(
      kept.some((entry) => String(entry.uuid ?? '').startsWith('dummy-')),
    ).toBe(false);
    expect(
      kept.some(
        (entry) =>
          entry.type === 'system' && entry.subtype === 'compact_boundary',
      ),
    ).toBe(true);
  });

  test('does not keep an async_launched line with a structured task-notification', () => {
    const transcriptPath = writeJsonl('completed.jsonl', [
      assistantToolUse(),
      launchEntry(),
      ...Array.from({ length: 50 }, (_, i) => dummyEntry(i)),
      structuredTaskNotification(TASK_ID),
      compactBoundary(),
    ]);

    trimSessionJsonl(transcriptPath, () => {});

    const kept = readJsonl(transcriptPath);
    expect(
      kept.some(
        (entry) =>
          (entry.toolUseResult as { status?: string } | undefined)?.status ===
          'async_launched',
      ),
    ).toBe(false);
  });

  test('does not treat assistant-pasted XML as a completion', () => {
    const transcriptPath = writeJsonl('fake-xml.jsonl', [
      assistantToolUse(),
      launchEntry(),
      assistantMentioningTask(TASK_ID),
      ...Array.from({ length: 50 }, (_, i) => dummyEntry(i)),
      compactBoundary(),
    ]);

    trimSessionJsonl(transcriptPath, () => {});

    const kept = readJsonl(transcriptPath);
    expect(kept.some((entry) => entry.uuid === LAUNCH_UUID)).toBe(true);
  });

  test('keeps a remote_launched line and two in-flight tasks', () => {
    const secondAssistant = {
      ...assistantToolUse(TASK_ID_2, 'assistant-2'),
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu-task-2',
            name: 'Task',
            input: { description: TASK_ID_2 },
          },
        ],
      },
    };
    const secondLaunch = {
      ...launchEntry(TASK_ID_2, 'remote_launched', 'remote-launch-uuid'),
      parentUuid: 'assistant-2',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu-task-2',
            content: `Background agent launched: ${TASK_ID_2}`,
          },
        ],
      },
    };
    const transcriptPath = writeJsonl('two-tasks.jsonl', [
      assistantToolUse(),
      launchEntry(),
      secondAssistant,
      secondLaunch,
      ...Array.from({ length: 50 }, (_, i) => dummyEntry(i)),
      compactBoundary(),
    ]);

    trimSessionJsonl(transcriptPath, () => {});

    const kept = readJsonl(transcriptPath);
    expect(kept.some((entry) => entry.uuid === LAUNCH_UUID)).toBe(true);
    expect(kept.some((entry) => entry.uuid === 'remote-launch-uuid')).toBe(
      true,
    );
    expect(
      (
        kept.find((entry) => entry.uuid === 'remote-launch-uuid')
          ?.toolUseResult as { status?: string }
      )?.status,
    ).toBe('remote_launched');
  });

  test('task-notification after compact_boundary still drops the completed launch', () => {
    const transcriptPath = writeJsonl('notify-after.jsonl', [
      assistantToolUse(),
      launchEntry(),
      ...Array.from({ length: 50 }, (_, i) => dummyEntry(i)),
      compactBoundary(),
      structuredTaskNotification(TASK_ID),
    ]);

    trimSessionJsonl(transcriptPath, () => {});

    const kept = readJsonl(transcriptPath);
    expect(kept.some((entry) => entry.uuid === LAUNCH_UUID)).toBe(false);
    expect(
      kept.some(
        (entry) =>
          entry.type === 'system' && entry.subtype === 'compact_boundary',
      ),
    ).toBe(true);
  });

  test('does not insert unfinished launches before preserved_segment.head_uuid', () => {
    const head = {
      type: 'user',
      uuid: 'preserved-head',
      message: { role: 'user', content: 'keep me' },
    };
    const transcriptPath = writeJsonl('preserved.jsonl', [
      assistantToolUse(),
      launchEntry(),
      ...Array.from({ length: 50 }, (_, i) => dummyEntry(i)),
      head,
      compactBoundary('preserved-head'),
    ]);

    trimSessionJsonl(transcriptPath, () => {});

    const kept = readJsonl(transcriptPath);
    expect(kept[0]?.uuid).toBe('preserved-head');
    const launchIndex = kept.findIndex((entry) => entry.uuid === LAUNCH_UUID);
    const headIndex = kept.findIndex(
      (entry) => entry.uuid === 'preserved-head',
    );
    const boundaryIndex = kept.findIndex(
      (entry) => entry.subtype === 'compact_boundary',
    );
    expect(headIndex).toBe(0);
    expect(launchIndex).toBeGreaterThan(headIndex);
    expect(launchIndex).toBeLessThan(boundaryIndex);
    expect(kept.some((entry) => entry.uuid === ASSISTANT_UUID)).toBe(true);
  });
});
