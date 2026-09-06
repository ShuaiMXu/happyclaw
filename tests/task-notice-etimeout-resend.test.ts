import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  ImDeliveryPhaseError,
  physicalDeliveryProgressError,
  retryUnscopedImSend,
} from '../src/im-send-retry-policy.js';
import { settleTaskNotificationDeliveries } from '../src/task-notification.js';

function mediaPayload(kind: 'image' | 'file') {
  return kind === 'image'
    ? {
        kind: 'im_image' as const,
        targetJid: 'feishu:task-media',
        workspaceFolder: 'task-media',
        filePath: 'artifact.png',
        mimeType: 'image/png',
        fileName: 'artifact.png',
      }
    : {
        kind: 'im_file' as const,
        targetJid: 'feishu:task-media',
        workspaceFolder: 'task-media',
        filePath: 'artifact.bin',
        fileName: 'artifact.bin',
      };
}

function etimedoutAfterAccept(): NodeJS.ErrnoException {
  const error = new Error(
    'ETIMEDOUT after provider accepted the task notice',
  ) as NodeJS.ErrnoException;
  error.code = 'ETIMEDOUT';
  return error;
}

describe('unscoped task notice send without outbox', () => {
  test('ETIMEDOUT-after-accept on a task notice stays 1 copy (no extra physical resend)', async () => {
    let copies = 0;
    const result = await retryUnscopedImSend(
      async () => {
        // The provider accepted and delivered the notice. Only the ACK
        // timed out. Another attempt would be a second visible copy.
        copies += 1;
        throw etimedoutAfterAccept();
      },
      { sleep: async () => {} },
    );

    expect(copies).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('uncertain');
    expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe(
      'ETIMEDOUT',
    );
  });

  test('pre-accept transport failures may still retry', async () => {
    let attempts = 0;
    const refused = Object.assign(new Error('connect ETIMEDOUT'), {
      code: 'ETIMEDOUT',
      deliveryPhase: 'pre_accept',
    });
    const result = await retryUnscopedImSend(
      async () => {
        attempts += 1;
        throw refused;
      },
      { sleep: async () => {} },
    );

    expect(attempts).toBe(3);
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('pre_accept');
  });

  test('an acknowledged first chunk prevents whole-batch retry after tail failure', async () => {
    let batchAttempts = 0;
    const result = await retryUnscopedImSend(
      async () => {
        batchAttempts += 1;
        throw physicalDeliveryProgressError(
          Object.assign(new Error('tail connection refused'), {
            code: 'ECONNREFUSED',
          }),
          1,
        );
      },
      { sleep: async () => {} },
    );

    expect(batchAttempts).toBe(1);
    expect(result).toMatchObject({ ok: false, outcome: 'uncertain' });
    const settled = await settleTaskNotificationDeliveries([
      {
        channel: 'feishu',
        payload: mediaPayload('file'),
        failure: {
          error: result.error,
          outcome: result.outcome === 'delivered' ? undefined : result.outcome,
        },
        deliver: async () => result.ok,
      },
    ]);
    expect(settled.receipt.status).toBe('uncertain');
    expect(settled.retryPayload).toBeUndefined();
  });

  test.each(['image', 'file'] as const)(
    '%s accepted-timeout produces uncertain media receipt with no scheduler retry payload',
    async (kind) => {
      let sends = 0;
      const failure: {
        error?: unknown;
        outcome?: 'pre_accept' | 'rejected' | 'uncertain';
      } = {};
      const transport = await retryUnscopedImSend(
        async () => {
          sends += 1;
          throw etimedoutAfterAccept();
        },
        { sleep: async () => {} },
      );
      failure.error = transport.error;
      failure.outcome =
        transport.outcome === 'delivered' ? undefined : transport.outcome;

      const settled = await settleTaskNotificationDeliveries([
        {
          channel: 'feishu',
          payload: mediaPayload(kind),
          failure,
          deliver: async () => transport.ok,
        },
      ]);

      expect(sends).toBe(1);
      expect(settled.receipt).toMatchObject({
        status: 'uncertain',
        summary: { uncertain: 1, uncertain_channels: ['feishu'] },
      });
      expect(settled.retryPayload).toBeUndefined();
    },
  );

  test.each([
    ['pre_accept', 3],
    ['rejected', 1],
  ] as const)(
    '%s media failure remains safely retryable by the durable scheduler',
    async (phase, expectedAttempts) => {
      let attempts = 0;
      const error = new ImDeliveryPhaseError(
        phase,
        `${phase} media delivery outcome`,
      );
      const transport = await retryUnscopedImSend(
        async () => {
          attempts += 1;
          throw error;
        },
        { sleep: async () => {} },
      );
      const payload = mediaPayload('image');
      const settled = await settleTaskNotificationDeliveries([
        {
          channel: 'feishu',
          payload,
          failure: {
            error: transport.error,
            outcome:
              transport.outcome === 'delivered' ? undefined : transport.outcome,
          },
          deliver: async () => transport.ok,
        },
      ]);

      expect(attempts).toBe(expectedAttempts);
      expect(settled.receipt.status).toBe('failed');
      expect(settled.retryPayload).toEqual(payload);
    },
  );

  test('identical media in separate logical notifications remains independently deliverable', async () => {
    let sends = 0;
    const send = async () => {
      sends += 1;
    };

    await expect(retryUnscopedImSend(send)).resolves.toMatchObject({
      ok: true,
      outcome: 'delivered',
    });
    await expect(retryUnscopedImSend(send)).resolves.toMatchObject({
      ok: true,
      outcome: 'delivered',
    });
    expect(sends).toBe(2);
  });

  test('sendImWithRetry else-branch and retryTaskNotification use the unscoped helper', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const sendStart = source.indexOf('async function sendImWithRetry(');
    const sendEnd = source.indexOf(
      'const CHANNEL_MANUAL_RECONCILIATION_NOTICE',
      sendStart,
    );
    expect(sendStart).toBeGreaterThanOrEqual(0);
    expect(sendEnd).toBeGreaterThan(sendStart);
    const sendImWithRetry = source.slice(sendStart, sendEnd);
    const elseBranch = sendImWithRetry.slice(
      sendImWithRetry.indexOf('} else {'),
    );
    expect(elseBranch).toContain('retryUnscopedImSend(');
    expect(elseBranch).not.toContain('retryImOperation(');

    const retryStart = source.indexOf(
      'retryTaskNotification: async (payload) => {',
    );
    const retryEnd = source.indexOf(
      'assistantName: ASSISTANT_NAME',
      retryStart,
    );
    expect(retryStart).toBeGreaterThanOrEqual(0);
    expect(retryEnd).toBeGreaterThan(retryStart);
    const retryTaskNotification = source.slice(retryStart, retryEnd);
    expect(retryTaskNotification).toContain('success = await sendImWithRetry(');
    expect(retryTaskNotification).toContain('targetJid!,');
    expect(retryTaskNotification).toContain('failure,');
    expect(retryTaskNotification).toContain(
      "status: success ? 'success' : uncertain ? 'uncertain' : 'failed'",
    );

    // Scheduled-task IPC notices also go through the unscoped path.
    expect(source).toContain('const textFailure: ImSendFailureRef = {}');
    expect(source).toContain('failure: textFailure');

    const taskImageStart = source.indexOf(
      'async function sendTaskImageWithRetry(',
    );
    const taskFileStart = source.indexOf(
      'async function sendTaskFileWithRetry(',
    );
    const taskMediaEnd = source.indexOf(
      'const TASK_RUN_STATUSES_ACCEPTING_OUTPUT',
      taskFileStart,
    );
    const imageHelper = source.slice(taskImageStart, taskFileStart);
    const fileHelper = source.slice(taskFileStart, taskMediaEnd);
    expect(imageHelper).toContain('deliverScopedChannelOutput(');
    expect(imageHelper).toMatch(
      /retryImOperation\([\s\S]{0,200}send_task_image[\s\S]{0,300}failure/,
    );
    expect(fileHelper).toContain('deliverScopedChannelOutput(');
    expect(fileHelper).toMatch(
      /retryImOperation\([\s\S]{0,200}send_task_file[\s\S]{0,300}failure/,
    );
    expect(retryTaskNotification).toMatch(
      /sendTaskImageWithRetry\([\s\S]{0,500}undefined,\s+failure/,
    );
    expect(retryTaskNotification).toMatch(
      /sendTaskFileWithRetry\([\s\S]{0,300}undefined,\s+failure/,
    );
    // Idempotency belongs to the durable task-run notification row. A global
    // route+content hash would incorrectly suppress a future independent run
    // that intentionally sends the same artifact again.
    expect(source).not.toContain('stableTaskMediaExternalId');
    expect(source).not.toContain('unscoped-task-media-outbox');
  });
});
