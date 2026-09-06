import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import type { ChannelProvider, RegisteredGroup } from '../src/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-direct-mount-'));
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'HappyClaw Test',
  DATA_DIR: dataDir,
  STORE_DIR: store,
  GROUPS_DIR: groups,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { buildRecentConversationHistoryContext } =
  await import('../src/conversation-history.js');
const {
  attachDefaultChannelAccountMount,
  buildWorkspaceMountUpdate,
  ensureDirectChannelSessionMount,
  restoreDefaultChannelMount,
  resolveChannelMountTarget,
} = await import('../src/channel-mount-service.js');

const now = '2026-08-17T00:00:00.000Z';
const workspaceJid = 'web:wecom-ws';
const dmJid = 'wecom:c2c:user-1#account:bot-a';
const groupJid = 'wecom:group:chat-1#account:bot-a';

const CLASSIFIABLE_ISOLATION_CASES = [
  {
    name: 'QQ',
    provider: 'qq' as ChannelProvider,
    accountId: 'qq-bot-a',
    workspaceJid: 'web:qq-iso-ws',
    folder: 'qq-iso-ws',
    dms: ['qq:c2c:alice#account:qq-bot-a'],
    groupJid: 'qq:group:sales#account:qq-bot-a',
    restoreJid: 'qq:c2c:restore-user#account:qq-bot-a',
  },
  {
    name: 'Discord',
    provider: 'discord' as ChannelProvider,
    accountId: 'discord-bot-a',
    workspaceJid: 'web:discord-iso-ws',
    folder: 'discord-iso-ws',
    dms: ['discord:dm:alice#account:discord-bot-a'],
    groupJid: 'discord:guild-channel-1#account:discord-bot-a',
    restoreJid: 'discord:dm:restore-user#account:discord-bot-a',
  },
  {
    name: 'WhatsApp',
    provider: 'whatsapp' as ChannelProvider,
    accountId: 'wa-bot-a',
    workspaceJid: 'web:wa-iso-ws',
    folder: 'wa-iso-ws',
    dms: [
      'whatsapp:15551230000@s.whatsapp.net#account:wa-bot-a',
      'whatsapp:123456789012345@lid#account:wa-bot-a',
      'whatsapp:15551230001@hosted#account:wa-bot-a',
    ],
    groupJid: 'whatsapp:120363000000000000@g.us#account:wa-bot-a',
    restoreJid: 'whatsapp:15551239999@hosted.lid#account:wa-bot-a',
  },
] as const;

function workspaceGroup() {
  return {
    name: 'WeCom workspace',
    folder: 'wecom-ws',
    added_at: now,
    created_by: 'owner-a',
  };
}

function chatGroup(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    folder: 'wecom-chat',
    added_at: now,
    created_by: 'owner-a',
    ...overrides,
  };
}

// These tests of existing session isolation opt into a concrete binding.
// Discovery itself must never call the legacy session/repair helper.
function bindDirectSession(
  sourceJid: string,
  group: RegisteredGroup,
  targetWorkspaceJid = workspaceJid,
) {
  const bound = ensureDirectChannelSessionMount({
    sourceJid,
    group,
    workspaceJid: targetWorkspaceJid,
    userId: 'owner-a',
    mountOptions: { replyPolicy: 'source_only' },
  });
  db.setRegisteredGroup(sourceJid, bound);
  return bound;
}

beforeAll(() => {
  db.initDatabase();
  db.setRegisteredGroup(workspaceJid, workspaceGroup());
  db.createChannelAccount({
    id: 'bot-a',
    owner_user_id: 'owner-a',
    provider: 'wecom',
    name: 'WeCom bot',
    secret_ref: 'channel-account:bot-a',
    default_workspace_jid: workspaceJid,
  });
  for (const fixture of CLASSIFIABLE_ISOLATION_CASES) {
    db.setRegisteredGroup(fixture.workspaceJid, {
      name: `${fixture.name} workspace`,
      folder: fixture.folder,
      added_at: now,
      created_by: 'owner-a',
    });
    db.createChannelAccount({
      id: fixture.accountId,
      owner_user_id: 'owner-a',
      provider: fixture.provider,
      name: `${fixture.name} bot`,
      secret_ref: `channel-account:${fixture.accountId}`,
      default_workspace_jid: fixture.workspaceJid,
    });
  }
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.sequential('WeCom DM / group channel-account mounts', () => {
  test('discovery records the account but leaves new DMs and groups unbound', () => {
    const onCreated = vi.fn();
    const sessionsBefore = db.listAgentsByJid(workspaceJid);
    for (const sourceJid of [dmJid, groupJid]) {
      const discovered = attachDefaultChannelAccountMount({
        sourceJid,
        // Even sharing the workspace folder does not authorize a binding.
        group: chatGroup('Discovered WeCom chat', { folder: 'wecom-ws' }),
        accountId: 'bot-a',
        fallbackWorkspaceJid: workspaceJid,
        userId: 'owner-a',
        onCreated,
      });
      expect(discovered.channel_account_id).toBe('bot-a');
      expect(discovered.target_main_jid).toBeUndefined();
      expect(discovered.target_agent_id).toBeUndefined();
      db.setRegisteredGroup(sourceJid, discovered);
      expect(db.getRegisteredGroup(sourceJid)?.channel_account_id).toBe(
        'bot-a',
      );
      expect(db.getChannelMount(sourceJid)).toBeUndefined();
    }
    expect(db.listAgentsByJid(workspaceJid)).toEqual(sessionsBefore);
    expect(db.getSessionChannelOwner('wecom-ws')).toBeUndefined();
    expect(onCreated).not.toHaveBeenCalled();
  });

  test('explicit session bindings keep DM and group main ownership separate', () => {
    const dm = bindDirectSession(
      dmJid,
      chatGroup('Explicit private session', { channel_account_id: 'bot-a' }),
    );
    expect(dm.target_agent_id).toBeTruthy();

    db.setRegisteredGroup(dmJid, dm);
    const dmMount = db.getChannelMount(dmJid);
    expect(dmMount).toMatchObject({
      workspace_jid: workspaceJid,
      session_id: dm.target_agent_id,
      routing_mode: 'single_session',
    });
    const dmTarget = resolveChannelMountTarget(dmMount!, {
      getAgent: db.getAgent,
      getRegisteredGroup: db.getRegisteredGroup,
    });
    expect(dmTarget).toMatchObject({
      status: 'resolved',
      effectiveJid: `${workspaceJid}#agent:${dm.target_agent_id}`,
      agentId: dm.target_agent_id,
    });

    // single_session with no child ID is an explicit Main Session binding.
    const group = buildWorkspaceMountUpdate(
      chatGroup('Team group', { channel_account_id: 'bot-a' }),
      workspaceJid,
      'single_session',
      { replyPolicy: 'source_only' },
    );
    expect(group).toMatchObject({
      channel_account_id: 'bot-a',
      target_main_jid: workspaceJid,
    });
    expect(group.target_agent_id).toBeUndefined();
    db.setRegisteredGroup(groupJid, group);
    expect(db.getChannelMount(groupJid)).toMatchObject({
      workspace_jid: workspaceJid,
      session_id: null,
    });

    const groupOwner = db.setSessionChannelOwnerOnce(
      'wecom-ws',
      null,
      groupJid,
    );
    const dmOwner = db.setSessionChannelOwnerOnce(
      'wecom-ws',
      dm.target_agent_id,
      dmJid,
    );
    expect(groupOwner).toBe(groupJid);
    expect(dmOwner).toBe(dmJid);
    expect(db.setSessionChannelOwnerOnce('wecom-ws', null, dmJid)).toBe(
      groupJid,
    );
    expect(
      db.setSessionChannelOwnerOnce('wecom-ws', dm.target_agent_id, groupJid),
    ).toBe(dmJid);
  });

  test('explicit binding reuses a DM session; rediscovery alone does not bind it', () => {
    const first = bindDirectSession(
      dmJid,
      chatGroup('Explicit private session', { channel_account_id: 'bot-a' }),
    );
    const again = attachDefaultChannelAccountMount({
      sourceJid: dmJid,
      group: first,
      accountId: 'bot-a',
      fallbackWorkspaceJid: workspaceJid,
      userId: 'owner-a',
    });
    expect(again).toBe(first);

    const discoveredAgain = attachDefaultChannelAccountMount({
      sourceJid: dmJid,
      group: chatGroup('Private DM replay'),
      accountId: 'bot-a',
      fallbackWorkspaceJid: workspaceJid,
      userId: 'owner-a',
    });
    expect(discoveredAgain.target_agent_id).toBeUndefined();
    expect(discoveredAgain.target_main_jid).toBeUndefined();
    const rebound = bindDirectSession(dmJid, discoveredAgain);
    expect(rebound.target_agent_id).toBe(first.target_agent_id);
  });

  test('keeps the same native DM isolated across WeCom accounts', () => {
    db.createChannelAccount({
      id: 'bot-b',
      owner_user_id: 'owner-a',
      provider: 'wecom',
      name: 'Second WeCom bot',
      secret_ref: 'channel-account:bot-b',
      default_workspace_jid: workspaceJid,
    });
    let secondAgentId: string | undefined;
    try {
      const first = bindDirectSession(
        dmJid,
        chatGroup('First bot session', { channel_account_id: 'bot-a' }),
      );
      const second = bindDirectSession(
        'wecom:c2c:user-1#account:bot-b',
        chatGroup('Second bot session', { channel_account_id: 'bot-b' }),
      );
      secondAgentId = second.target_agent_id;
      expect(secondAgentId).toBeTruthy();
      expect(secondAgentId).not.toBe(first.target_agent_id);
      expect(db.getAgent(secondAgentId!)?.last_im_jid).toBe(
        'wecom:c2c:user-1#account:bot-b',
      );
    } finally {
      db.deleteRegisteredGroup('wecom:c2c:user-1#account:bot-b');
      if (secondAgentId) db.deleteAgent(secondAgentId);
      db.deleteChannelAccount('bot-b', 'owner-a');
    }
  });

  test('does not overwrite an explicit Session or Main Session bind', () => {
    const sessionBound = chatGroup('Manual session', {
      channel_account_id: 'bot-a',
      target_agent_id: 'manual-session',
    });
    expect(
      attachDefaultChannelAccountMount({
        sourceJid: 'wecom:c2c:user-2#account:bot-a',
        group: sessionBound,
        accountId: 'bot-a',
        fallbackWorkspaceJid: workspaceJid,
        userId: 'owner-a',
      }),
    ).toBe(sessionBound);

    const mainSessionBound = chatGroup('Manual Main Session', {
      channel_account_id: 'bot-a',
      target_main_jid: 'web:user-selected',
    });
    expect(
      attachDefaultChannelAccountMount({
        sourceJid: 'wecom:group:chat-2#account:bot-a',
        group: mainSessionBound,
        accountId: 'bot-a',
        fallbackWorkspaceJid: workspaceJid,
        userId: 'owner-a',
      }),
    ).toBe(mainSessionBound);
  });

  test('explicit legacy repair remounts a WeCom DM onto a dedicated session', () => {
    const restoreJid = 'wecom:c2c:user-3#account:bot-a';
    db.setRegisteredGroup(
      restoreJid,
      chatGroup('Legacy DM', {
        channel_account_id: 'bot-a',
        target_main_jid: workspaceJid,
      }),
    );
    db.clearSessionChannelOwner('wecom-ws', null);
    expect(db.setSessionChannelOwnerOnce('wecom-ws', null, restoreJid)).toBe(
      restoreJid,
    );
    const restored = restoreDefaultChannelMount(
      restoreJid,
      db.getRegisteredGroup(restoreJid)!,
      'owner-a',
    );
    expect(restored.status).toBe('resolved');
    if (restored.status !== 'resolved') return;
    expect(restored.workspaceJid).toBe(workspaceJid);
    expect(restored.updated.target_main_jid).toBeUndefined();
    expect(restored.updated.target_agent_id).toBeTruthy();
    expect(db.getChannelMount(restoreJid)).toMatchObject({
      workspace_jid: workspaceJid,
      session_id: restored.updated.target_agent_id,
    });
    expect(db.getAgent(restored.updated.target_agent_id!)?.source_kind).toBe(
      'channel_direct',
    );
    expect(db.getSessionChannelOwner('wecom-ws')).toBeUndefined();
  });
});

describe.sequential(
  'QQ/Discord/WhatsApp DM / group channel-account mounts',
  () => {
    test.each(CLASSIFIABLE_ISOLATION_CASES)(
      '$name: discovery leaves DMs and groups unbound despite an account default workspace',
      (fixture) => {
        const onCreated = vi.fn();
        const sessionsBefore = db.listAgentsByJid(fixture.workspaceJid);
        for (const sourceJid of [...fixture.dms, fixture.groupJid]) {
          const discovered = attachDefaultChannelAccountMount({
            sourceJid,
            group: chatGroup(`${fixture.name} discovered chat`, {
              folder: fixture.folder,
            }),
            accountId: fixture.accountId,
            fallbackWorkspaceJid: fixture.workspaceJid,
            userId: 'owner-a',
            onCreated,
          });
          expect(discovered.channel_account_id).toBe(fixture.accountId);
          expect(discovered.target_main_jid).toBeUndefined();
          expect(discovered.target_agent_id).toBeUndefined();
          db.setRegisteredGroup(sourceJid, discovered);
          expect(db.getRegisteredGroup(sourceJid)).toBeDefined();
          expect(db.getChannelMount(sourceJid)).toBeUndefined();
        }
        expect(db.listAgentsByJid(fixture.workspaceJid)).toEqual(
          sessionsBefore,
        );
        expect(db.getSessionChannelOwner(fixture.folder)).toBeUndefined();
        expect(onCreated).not.toHaveBeenCalled();
      },
    );

    test.each(CLASSIFIABLE_ISOLATION_CASES)(
      '$name: explicit session bindings isolate DM from group main owner',
      (fixture) => {
        const mountedDms = fixture.dms.map((sourceJid) => {
          const dm = bindDirectSession(
            sourceJid,
            chatGroup(`${fixture.name} private DM`, {
              channel_account_id: fixture.accountId,
            }),
            fixture.workspaceJid,
          );
          expect(dm.channel_account_id).toBe(fixture.accountId);
          expect(dm.target_main_jid).toBeUndefined();
          expect(dm.target_agent_id).toBeTruthy();
          db.setRegisteredGroup(sourceJid, dm);
          expect(db.getChannelMount(sourceJid)).toMatchObject({
            workspace_jid: fixture.workspaceJid,
            session_id: dm.target_agent_id,
            routing_mode: 'single_session',
          });
          const dmTarget = resolveChannelMountTarget(
            db.getChannelMount(sourceJid)!,
            {
              getAgent: db.getAgent,
              getRegisteredGroup: db.getRegisteredGroup,
            },
          );
          expect(dmTarget).toMatchObject({
            status: 'resolved',
            effectiveJid: `${fixture.workspaceJid}#agent:${dm.target_agent_id}`,
            agentId: dm.target_agent_id,
          });
          return dm;
        });
        expect(new Set(mountedDms.map((dm) => dm.target_agent_id)).size).toBe(
          fixture.dms.length,
        );

        const group = buildWorkspaceMountUpdate(
          chatGroup(`${fixture.name} group`, {
            channel_account_id: fixture.accountId,
          }),
          fixture.workspaceJid,
          'single_session',
          { replyPolicy: 'source_only' },
        );
        expect(group).toMatchObject({
          channel_account_id: fixture.accountId,
          target_main_jid: fixture.workspaceJid,
        });
        expect(group.target_agent_id).toBeUndefined();
        db.setRegisteredGroup(fixture.groupJid, group);
        expect(db.getChannelMount(fixture.groupJid)).toMatchObject({
          workspace_jid: fixture.workspaceJid,
          session_id: null,
        });

        expect(
          db.setSessionChannelOwnerOnce(fixture.folder, null, fixture.groupJid),
        ).toBe(fixture.groupJid);
        for (const [index, sourceJid] of fixture.dms.entries()) {
          const agentId = mountedDms[index]!.target_agent_id!;
          expect(
            db.setSessionChannelOwnerOnce(fixture.folder, null, sourceJid),
          ).toBe(fixture.groupJid);
          expect(
            db.setSessionChannelOwnerOnce(fixture.folder, agentId, sourceJid),
          ).toBe(sourceJid);
          expect(
            db.setSessionChannelOwnerOnce(
              fixture.folder,
              agentId,
              fixture.groupJid,
            ),
          ).toBe(sourceJid);
        }
      },
    );

    test.each(CLASSIFIABLE_ISOLATION_CASES)(
      '$name: explicit legacy repair remounts leftover DM off workspace main',
      (fixture) => {
        db.setRegisteredGroup(
          fixture.restoreJid,
          chatGroup(`${fixture.name} leftover DM`, {
            channel_account_id: fixture.accountId,
            target_main_jid: fixture.workspaceJid,
          }),
        );
        db.clearSessionChannelOwner(fixture.folder, null);
        expect(
          db.setSessionChannelOwnerOnce(
            fixture.folder,
            null,
            fixture.restoreJid,
          ),
        ).toBe(fixture.restoreJid);
        const restored = restoreDefaultChannelMount(
          fixture.restoreJid,
          db.getRegisteredGroup(fixture.restoreJid)!,
          'owner-a',
        );
        expect(restored.status).toBe('resolved');
        if (restored.status !== 'resolved') return;
        expect(restored.workspaceJid).toBe(fixture.workspaceJid);
        expect(restored.updated.target_main_jid).toBeUndefined();
        expect(restored.updated.target_agent_id).toBeTruthy();
        expect(db.getChannelMount(fixture.restoreJid)).toMatchObject({
          workspace_jid: fixture.workspaceJid,
          session_id: restored.updated.target_agent_id,
        });
        expect(
          db.getAgent(restored.updated.target_agent_id!)?.source_kind,
        ).toBe('channel_direct');
        expect(db.getSessionChannelOwner(fixture.folder)).toBeUndefined();
        expect(
          db.setSessionChannelOwnerOnce(fixture.folder, null, fixture.groupJid),
        ).toBe(fixture.groupJid);
        expect(
          db.setSessionChannelOwnerOnce(
            fixture.folder,
            null,
            fixture.restoreJid,
          ),
        ).toBe(fixture.groupJid);
        expect(
          db.setSessionChannelOwnerOnce(
            fixture.folder,
            restored.updated.target_agent_id,
            fixture.restoreJid,
          ),
        ).toBe(fixture.restoreJid);
      },
    );

    test.each(CLASSIFIABLE_ISOLATION_CASES)(
      '$name: workspace recovery does not replay isolated DM transcript',
      (fixture) => {
        const sourceJid = fixture.dms[0]!;
        const dm = bindDirectSession(
          sourceJid,
          chatGroup(`${fixture.name} isolated recovery session`, {
            channel_account_id: fixture.accountId,
          }),
          fixture.workspaceJid,
        );
        db.setRegisteredGroup(
          fixture.groupJid,
          buildWorkspaceMountUpdate(
            chatGroup(`${fixture.name} group recovery session`, {
              channel_account_id: fixture.accountId,
            }),
            fixture.workspaceJid,
            'single_session',
            { replyPolicy: 'source_only' },
          ),
        );
        db.setSessionChannelOwnerOnce(fixture.folder, null, fixture.groupJid);
        expect(dm?.target_agent_id).toBeTruthy();
        expect(dm?.target_main_jid).toBeUndefined();
        db.ensureChatExists(fixture.workspaceJid);
        db.storeMessageDirect(
          `${fixture.folder}-group-recovery`,
          fixture.workspaceJid,
          fixture.groupJid,
          'Group Bob',
          `${fixture.name} group context that recovery may replay`,
          now,
          false,
          { sourceJid: fixture.groupJid },
        );
        const dmChatJid = `${fixture.workspaceJid}#agent:${dm!.target_agent_id}`;
        db.ensureChatExists(dmChatJid);
        db.storeMessageDirect(
          `${fixture.folder}-dm-recovery`,
          dmChatJid,
          sourceJid,
          'Private Alice',
          `${fixture.name} private value that must never share workspace recovery`,
          now,
          false,
          { sourceJid },
        );
        const history = buildRecentConversationHistoryContext(
          fixture.workspaceJid,
          new Set(),
          { intro: 'recovery' },
        );
        expect(history?.context).toContain(
          `${fixture.name} group context that recovery may replay`,
        );
        expect(history?.context).not.toContain(
          `${fixture.name} private value that must never share workspace recovery`,
        );
        const dmHistory = buildRecentConversationHistoryContext(
          dmChatJid,
          new Set(),
          { intro: 'recovery' },
        );
        expect(dmHistory?.context).toContain(
          `${fixture.name} private value that must never share workspace recovery`,
        );
        expect(dmHistory?.context).not.toContain(
          `${fixture.name} group context that recovery may replay`,
        );
        expect(db.getSessionChannelOwner(fixture.folder)).toBe(
          fixture.groupJid,
        );
        expect(
          db.setSessionChannelOwnerOnce(fixture.folder, null, sourceJid),
        ).toBe(fixture.groupJid);
      },
    );
  },
);
