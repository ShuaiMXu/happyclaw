import { describe, expect, test, vi } from 'vitest';

import {
  resolveBroadcastFolder,
  resolveTaskNotificationTargets,
  resolveTaskRoutingDecision,
  type BroadcastToOwnerIMChannelsDeps,
  type ResolveTaskRoutingDeps,
  type TaskRunForRouting,
} from '../src/task-routing.js';

function makeBroadcastDeps(
  groups: Array<{ jid: string; folder: string }>,
): BroadcastToOwnerIMChannelsDeps {
  return {
    getConnectedChannelTypes: () => ['feishu', 'wechat'],
    getGroupsByOwner: () => groups,
    getChannelType: (jid) => jid.split(':', 1)[0] || null,
    resolveJidFolder: () => null,
  };
}

function makeDeps(imJids: ReadonlySet<string>): ResolveTaskRoutingDeps {
  return {
    getChannelType: vi.fn((jid: string) => (imJids.has(jid) ? 'feishu' : null)),
  };
}

function makeRun(
  overrides: Partial<TaskRunForRouting['definition_snapshot']> = {},
): TaskRunForRouting {
  return {
    task_id: 'task-frozen',
    definition_snapshot: {
      group_folder: 'workspace-a',
      notify_channels: ['telegram'],
      chat_jid: null,
      delivery_route_jid: null,
      ...overrides,
    },
  };
}

describe('resolveTaskRoutingDecision — direct vs broadcast', () => {
  test('verified run with an IM-valid frozen route → mode direct', () => {
    const run = makeRun({
      chat_jid: 'feishu:old',
      delivery_route_jid: 'feishu:frozen',
    });
    const decision = resolveTaskRoutingDecision(
      run,
      'workspace-a',
      true,
      makeDeps(new Set(['feishu:frozen'])),
    );
    expect(decision.mode).toBe('direct');
    if (decision.mode === 'direct') {
      expect(decision.taskChatJid).toBe('feishu:frozen');
      expect(decision.effectiveTaskId).toBe('task-frozen');
      expect(decision.notifyChannels).toEqual(['telegram']);
    }
  });

  test('verified run with non-IM frozen route → mode broadcast', () => {
    const decision = resolveTaskRoutingDecision(
      makeRun({ delivery_route_jid: 'web:main' }),
      'workspace-a',
      true,
      makeDeps(new Set()),
    );
    expect(decision.mode).toBe('broadcast');
  });

  test('missing verified run is never upgraded by an IPC task claim', () => {
    expect(
      resolveTaskRoutingDecision(null, 'workspace-a', true, makeDeps(new Set()))
        .mode,
    ).toBe('none');
  });

  test('run from another workspace is rejected', () => {
    expect(
      resolveTaskRoutingDecision(
        makeRun(),
        'workspace-b',
        true,
        makeDeps(new Set()),
      ).mode,
    ).toBe('none');
  });

  test('run without owner attribution is rejected', () => {
    expect(
      resolveTaskRoutingDecision(
        makeRun(),
        'workspace-a',
        false,
        makeDeps(new Set()),
      ).mode,
    ).toBe('none');
  });

  test('routing remains frozen after the live task definition changes', () => {
    const frozen = makeRun({
      delivery_route_jid: 'feishu:recipient-a',
      notify_channels: ['telegram'],
    });
    const decision = resolveTaskRoutingDecision(
      frozen,
      'workspace-a',
      true,
      makeDeps(new Set(['feishu:recipient-a', 'feishu:recipient-b'])),
    );
    expect(decision.mode).toBe('direct');
    if (decision.mode === 'direct') {
      expect(decision.taskChatJid).toBe('feishu:recipient-a');
      expect(decision.notifyChannels).toEqual(['telegram']);
    }
  });
});

describe('resolveTaskNotificationTargets — bound route plus explicit fan-out', () => {
  const directDecision = {
    mode: 'direct' as const,
    taskChatJid: 'feishu:bound',
    notifyChannels: ['wechat'],
    effectiveTaskId: 'task-frozen',
  };

  test('delivers both the frozen bound route and an explicitly selected channel', () => {
    expect(
      resolveTaskNotificationTargets(
        'owner-1',
        'workspace-a',
        directDecision,
        makeBroadcastDeps([
          { jid: 'feishu:bound', folder: 'workspace-a' },
          { jid: 'wechat:selected', folder: 'workspace-a' },
        ]),
      ),
    ).toEqual({
      targetJids: ['feishu:bound', 'wechat:selected'],
      unavailableChannels: [],
    });
  });

  test('reports an explicit channel with no workspace binding as unavailable', () => {
    expect(
      resolveTaskNotificationTargets(
        'owner-1',
        'workspace-a',
        directDecision,
        makeBroadcastDeps([{ jid: 'feishu:bound', folder: 'workspace-a' }]),
      ),
    ).toEqual({
      targetJids: ['feishu:bound'],
      unavailableChannels: ['wechat'],
    });
  });
});

/**
 * Regression tests for fix F: the broadcast folder must be the emitting
 * workspace's own folder (`sourceFolder`), NEVER the owner's home folder.
 *
 * Why this exists: `broadcastToOwnerIMChannels` itself is folder-agnostic —
 * it does whatever matching the caller asks for. The bug was in the caller
 * (src/index.ts processGroupIpc) passing the wrong folder. Before this
 * helper was extracted, a mutation flipping the call site back to owner
 * home would silently pass CI (QA confirmed: 0/99 red). These tests lock
 * the choice inside the helper so such a regression shows up as a
 * functional change to resolveBroadcastFolder, not an innocent-looking
 * one-line edit at the call site.
 */
describe('resolveBroadcastFolder', () => {
  test('returns sourceFolder when ownerHome differs — home MUST NOT win', () => {
    // Scenario: user has a non-home workspace `ws-x` bound to a Feishu group.
    // Before fix F, the code returned ownerHome.folder (='home-u1'), which
    // meant the Feishu group on `ws-x` never received task results.
    expect(resolveBroadcastFolder('ws-x', 'home-u1')).toBe('ws-x');
  });

  test('returns sourceFolder when ownerHome is null', () => {
    // Happens when sourceGroupEntry.created_by is unset (legacy rows).
    expect(resolveBroadcastFolder('ws-x', null)).toBe('ws-x');
  });

  test('returns sourceFolder when ownerHome is undefined', () => {
    // Happens when getUserHomeGroup returns undefined.
    expect(resolveBroadcastFolder('ws-x', undefined)).toBe('ws-x');
  });

  test('returns sourceFolder even when it coincidentally equals ownerHome', () => {
    // For admin on home workspace, both candidates are the same folder.
    // Behaviorally correct either way, but we still commit to sourceFolder.
    expect(resolveBroadcastFolder('main', 'main')).toBe('main');
  });
});
