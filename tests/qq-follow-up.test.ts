import { describe, expect, test } from 'vitest';

import { describeFollowUpOutcome } from '../src/qq.js';

const NOW = '2026-08-26T10:00:00.000Z';

describe('describeFollowUpOutcome', () => {
  test('started runs now and writes no delivery fields', () => {
    expect(describeFollowUpOutcome({ disposition: 'started' }, NOW)).toEqual({
      shouldStartTurn: true,
      disposition: 'started',
      deliveryFields: {},
    });
  });

  test('queued defers the turn and records the owning run', () => {
    const outcome = describeFollowUpOutcome(
      { disposition: 'queued', runId: 'run-1', position: 3 },
      NOW,
    );

    expect(outcome.shouldStartTurn).toBe(false);
    expect(outcome.position).toBe(3);
    expect(outcome.deliveryFields).toEqual({
      delivery_mode: 'queue',
      delivery_status: 'queued',
      delivery_run_id: 'run-1',
      delivery_updated_at: NOW,
    });
  });

  test('steered persists as queued, not as its own status', () => {
    // A steer is a durable hand-off: the row stays queued until the
    // interrupted query reports idle. Any other status would hide it from
    // listQueuedFollowUps and the message would never run.
    const outcome = describeFollowUpOutcome(
      { disposition: 'steered', runId: 'run-2' },
      NOW,
    );

    expect(outcome.shouldStartTurn).toBe(false);
    expect(outcome.deliveryFields).toEqual({
      delivery_mode: 'steer',
      delivery_status: 'queued',
      delivery_run_id: 'run-2',
      delivery_updated_at: NOW,
    });
  });

  test('a missing runId is stored as null rather than dropped', () => {
    // The column is nullable; omitting the key would leave a stale run id in
    // place on a row that is being re-queued.
    const outcome = describeFollowUpOutcome({ disposition: 'queued' }, NOW);
    expect(outcome.deliveryFields).toHaveProperty('delivery_run_id', null);
  });

  test('only the deferred dispositions block the turn', () => {
    expect(
      describeFollowUpOutcome({ disposition: 'started' }).shouldStartTurn,
    ).toBe(true);
    expect(
      describeFollowUpOutcome({ disposition: 'queued' }).shouldStartTurn,
    ).toBe(false);
    expect(
      describeFollowUpOutcome({ disposition: 'steered' }).shouldStartTurn,
    ).toBe(false);
  });
});
