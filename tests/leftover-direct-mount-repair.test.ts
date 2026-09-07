import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'leftover-direct-mount-repair-'),
);
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'HappyClaw Test',
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { buildRecentConversationHistoryContext } =
  await import('../src/conversation-history.js');
const {
  diagnoseLeftoverClassifiableDirectWorkspaceMounts,
  repairLeftoverClassifiableDirectWorkspaceMounts,
} = await import('../src/leftover-direct-mount-repair.js');
const { resolveWhatsAppConversationAliasFromGroups } =
  await import('../src/whatsapp-jid.js');

const now = '2026-08-18T00:00:00.000Z';
const oldIsolationAt = '2026-08-18T00:00:00.000Z';
const repairAt = '2026-08-20T04:00:00.000Z';

const workspaceJid = 'web:leftover-repair-ws';
const folder = 'leftover-repair-ws';
const qqDmJid = 'qq:c2c:alice#account:bot-a';
const qqGroupJid = 'qq:group:sales#account:bot-a';
const discordDmJid = 'discord:dm:alice#account:bot-a';
const discordGroupJid = 'discord:guild-channel-1#account:bot-a';
const waLidJid = 'whatsapp:123456789012345@lid#account:bot-a';
const waHostedJid = 'whatsapp:15551230000@hosted#account:bot-a';
const waHostedLidJid = 'whatsapp:15551230001@hosted.lid#account:bot-a';
const waPnJid = 'whatsapp:15551230002@s.whatsapp.net#account:bot-a';
const waLegacyCusJid = 'whatsapp:15559870000@c.us#account:bot-a';
const waDeviceCusJid = 'whatsapp:15559870000:14@c.us#account:bot-a';
const waCanonicalAliasPnJid =
  'whatsapp:15559870000@s.whatsapp.net#account:bot-a';
const waCanonicalAliasJids = [
  waLegacyCusJid,
  waDeviceCusJid,
  waCanonicalAliasPnJid,
] as const;
const waLegacyOnlyCusJid = 'whatsapp:15559871111@c.us#account:legacy-only-bot';
const waLegacyOnlyDeviceCusJid =
  'whatsapp:15559871111:21@c.us#account:legacy-only-bot';
const waLegacyOnlyCanonicalJid =
  'whatsapp:15559871111@s.whatsapp.net#account:legacy-only-bot';
const waLegacyOnlyAliases = [
  waLegacyOnlyCusJid,
  waLegacyOnlyDeviceCusJid,
] as const;
const waGroupJid = 'whatsapp:120363000000000000@g.us#account:bot-a';
const feishuUnknownJid = 'feishu:oc_opaque#account:bot-a';
const leftoverDirectJids = [
  qqDmJid,
  discordDmJid,
  waLidJid,
  waHostedJid,
  waHostedLidJid,
  waPnJid,
  ...waCanonicalAliasJids,
  ...waLegacyOnlyAliases,
] as const;

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function seedLeftoverDirectState(): void {
  db.setRegisteredGroup(workspaceJid, {
    name: 'Leftover repair workspace',
    folder,
    added_at: now,
    created_by: 'owner-a',
  });
  for (const [jid, name] of [
    [qqDmJid, 'QQ leftover DM'],
    [discordDmJid, 'Discord leftover DM'],
    [waLidJid, 'WhatsApp LID leftover DM'],
    [waHostedJid, 'WhatsApp hosted leftover DM'],
    [waHostedLidJid, 'WhatsApp hosted.lid leftover DM'],
    [waPnJid, 'WhatsApp PN leftover DM'],
    [waLegacyCusJid, 'WhatsApp legacy c.us leftover DM'],
    [waDeviceCusJid, 'WhatsApp device c.us leftover DM'],
    [waCanonicalAliasPnJid, 'WhatsApp canonical PN leftover DM'],
    [waLegacyOnlyCusJid, 'WhatsApp legacy-only c.us leftover DM'],
    [waLegacyOnlyDeviceCusJid, 'WhatsApp legacy-only device c.us leftover DM'],
  ] as const) {
    db.setRegisteredGroup(jid, {
      name,
      folder: `${folder}-direct`,
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: jid.includes('#account:legacy-only-bot')
        ? 'legacy-only-bot'
        : 'bot-a',
      target_main_jid: workspaceJid,
    });
  }
  for (const [jid, name] of [
    [qqGroupJid, 'QQ group'],
    [discordGroupJid, 'Discord guild'],
    [waGroupJid, 'WhatsApp group'],
    [feishuUnknownJid, 'Feishu opaque chat'],
  ] as const) {
    db.setRegisteredGroup(jid, {
      name,
      folder: `${folder}-group`,
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: workspaceJid,
    });
  }

  db.setSession(folder, 'contaminated-main-session');
  db.setSessionChannelOwnerOnce(folder, null, waLidJid);
  db.setRouterState(
    `conversation_history_isolation:${workspaceJid}`,
    oldIsolationAt,
  );
  db.ensureChatExists(workspaceJid);
  db.storeMessageDirect(
    'pre-marker-private',
    workspaceJid,
    waLidJid,
    'Private Alice',
    'old private value fenced by the first isolation marker',
    now,
    false,
    { sourceJid: waLidJid },
  );
  db.storeMessageDirect(
    'post-marker-private-leak',
    workspaceJid,
    waLidJid,
    'Private Alice',
    'post-marker LID leak that must not stay recoverable',
    '2026-08-19T00:00:00.000Z',
    false,
    { sourceJid: waLidJid },
  );
  db.storeMessageDirect(
    'post-marker-legacy-unscoped-private-leak',
    workspaceJid,
    'whatsapp:123456789012345@lid',
    'Private Alice',
    'legacy unscoped LID alias that must be fenced with the scoped mount',
    '2026-08-19T00:00:00.500Z',
    false,
    { sourceJid: 'whatsapp:123456789012345@lid' },
  );
  db.storeMessageDirect(
    'post-marker-group',
    workspaceJid,
    waGroupJid,
    'Group Bob',
    'group context that arrived after the first isolation marker',
    '2026-08-19T00:00:01.000Z',
    false,
    { sourceJid: waGroupJid },
  );
  for (const [index, sourceJid] of waCanonicalAliasJids.entries()) {
    db.storeMessageDirect(
      `post-marker-cus-alias-${index}`,
      workspaceJid,
      sourceJid,
      'Private CUS Alice',
      `post-marker canonical alias leak ${index}`,
      `2026-08-19T00:00:0${index + 2}.000Z`,
      false,
      { sourceJid },
    );
  }
  db.storeMessageDirect(
    'post-marker-other-account-cus',
    workspaceJid,
    'whatsapp:15559870000@c.us#account:bot-b',
    'Other account Alice',
    'same PN from another account must not count as this alias',
    '2026-08-19T00:00:09.000Z',
    false,
    { sourceJid: 'whatsapp:15559870000@c.us#account:bot-b' },
  );
}

describe.sequential('leftover classifiable DM diagnostic/repair tool', () => {
  test('dry-run reports leftover JID DMs and leaves contaminated recovery state intact', () => {
    db.initDatabase();
    seedLeftoverDirectState();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );

    const diagnosis = diagnoseLeftoverClassifiableDirectWorkspaceMounts();
    expect(diagnosis.schemaVersion).toBe(String(db.CURRENT_SCHEMA_VERSION));
    expect(diagnosis.aliasConflicts).toEqual([]);
    expect(diagnosis.leftovers.map((item) => item.channelJid).sort()).toEqual(
      [...leftoverDirectJids].sort(),
    );
    expect(
      diagnosis.leftovers.find((item) => item.channelJid === waLidJid),
    ).toMatchObject({
      workspaceJid,
      workspaceFolder: folder,
      mainOwnerIsThisChat: true,
      mainSessionId: 'contaminated-main-session',
      existingIsolationMarker: oldIsolationAt,
      recoverableInboundFromThisChat: 3,
    });
    for (const alias of waCanonicalAliasJids) {
      expect(
        diagnosis.leftovers.find((item) => item.channelJid === alias),
      ).toMatchObject({ recoverableInboundFromThisChat: 3 });
    }
    expect(diagnosis.affectedWorkspaces).toEqual([
      expect.objectContaining({
        workspaceJid,
        leftoverCount: leftoverDirectJids.length,
        existingIsolationMarker: oldIsolationAt,
        mainSessionId: 'contaminated-main-session',
        mainOwnerJid: waLidJid,
        recoverableInboundFromLeftovers: 6,
      }),
    ]);

    const dryRun = repairLeftoverClassifiableDirectWorkspaceMounts();
    expect(dryRun.applied).toBe(false);
    expect(dryRun.remounted).toBe(0);
    expect(dryRun.isolationGenerationsReset).toBe(0);
    expect(db.getRegisteredGroup(waLidJid)).toMatchObject({
      target_main_jid: workspaceJid,
    });
    expect(db.getSession(folder)).toBe('contaminated-main-session');
    expect(db.getSessionChannelOwner(folder)).toBe(waLidJid);
    expect(db.getConversationHistoryIsolationMarker(workspaceJid)).toBe(
      oldIsolationAt,
    );
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );

    const leaked = buildRecentConversationHistoryContext(
      workspaceJid,
      new Set(),
      { intro: 'recovery' },
    );
    expect(leaked?.context).toContain(
      'post-marker LID leak that must not stay recoverable',
    );
    expect(leaked?.context).toContain(
      'group context that arrived after the first isolation marker',
    );
  });

  test('apply remounts leftovers and resets isolation generation so post-marker leaks are not recoverable', () => {
    const repaired = repairLeftoverClassifiableDirectWorkspaceMounts({
      apply: true,
      isolationStartedAt: repairAt,
    });
    expect(repaired.applied).toBe(true);
    expect(repaired.remounted).toBe(leftoverDirectJids.length);
    expect(repaired.isolationGenerationsReset).toBe(1);
    expect(repaired.isolationMarkers[workspaceJid]).toBe(repairAt);
    expect(repaired.schemaVersion).toBe(String(db.CURRENT_SCHEMA_VERSION));
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );

    for (const jid of leftoverDirectJids) {
      const group = db.getRegisteredGroup(jid)!;
      expect(group.target_main_jid).toBeUndefined();
      expect(group.target_agent_id).toBeTruthy();
      expect(db.getAgent(group.target_agent_id!)?.source_kind).toBe(
        'channel_direct',
      );
      expect(db.getChannelMount(jid)).toMatchObject({
        workspace_jid: workspaceJid,
        session_id: group.target_agent_id,
      });
    }
    const canonicalAliasSessionIds = waCanonicalAliasJids.map(
      (jid) => db.getRegisteredGroup(jid)!.target_agent_id,
    );
    expect(new Set(canonicalAliasSessionIds)).toHaveLength(1);
    expect(
      resolveWhatsAppConversationAliasFromGroups(
        waCanonicalAliasPnJid,
        db.getAllRegisteredGroups(),
      ),
    ).toEqual({
      status: 'canonical',
      jid: waCanonicalAliasPnJid,
      aliases: [],
    });
    const legacyOnlySessionIds = waLegacyOnlyAliases.map(
      (jid) => db.getRegisteredGroup(jid)!.target_agent_id,
    );
    expect(new Set(legacyOnlySessionIds)).toHaveLength(1);
    const sortedLegacyOnlyAliases = [...waLegacyOnlyAliases].sort();
    expect(
      resolveWhatsAppConversationAliasFromGroups(
        waLegacyOnlyCanonicalJid,
        db.getAllRegisteredGroups(),
      ),
    ).toEqual({
      status: 'legacy_equivalent',
      jid: sortedLegacyOnlyAliases[0],
      aliases: sortedLegacyOnlyAliases,
    });

    expect(db.getRegisteredGroup(qqGroupJid)).toMatchObject({
      target_main_jid: workspaceJid,
    });
    expect(db.getRegisteredGroup(discordGroupJid)).toMatchObject({
      target_main_jid: workspaceJid,
    });
    expect(db.getRegisteredGroup(waGroupJid)).toMatchObject({
      target_main_jid: workspaceJid,
    });
    expect(db.getRegisteredGroup(feishuUnknownJid)).toMatchObject({
      target_main_jid: workspaceJid,
    });

    expect(db.getSession(folder)).toBeUndefined();
    expect(db.getWorkspaceRuntimeSession(folder)).toBeUndefined();
    expect(db.getSessionChannelOwner(folder)).toBeUndefined();
    expect(db.getConversationHistoryIsolationMarker(workspaceJid)).toBe(
      repairAt,
    );
    expect(repairAt).not.toBe(oldIsolationAt);

    const history = buildRecentConversationHistoryContext(
      workspaceJid,
      new Set(),
      { intro: 'recovery' },
    );
    expect(history).toBeNull();
    expect(
      db
        .getConversationHistoryMessagesPage(workspaceJid, new Set(), 30)
        .map((message) => message.id),
    ).toEqual([]);

    db.setSession(folder, 'clean-main-after-repair');
    expect(db.setSessionChannelOwnerOnce(folder, null, waGroupJid)).toBe(
      waGroupJid,
    );
    expect(db.setSessionChannelOwnerOnce(folder, null, waLidJid)).toBe(
      waGroupJid,
    );
    db.storeMessageDirect(
      'safe-after-repair',
      workspaceJid,
      waGroupJid,
      'Group Bob',
      'safe group context after the new isolation generation',
      '2026-08-20T04:00:01.000Z',
      false,
      { sourceJid: waGroupJid },
    );
    const after = buildRecentConversationHistoryContext(
      workspaceJid,
      new Set(),
      { intro: 'recovery' },
    );
    expect(after?.messageIds).toEqual(['safe-after-repair']);
    expect(after?.context).toContain(
      'safe group context after the new isolation generation',
    );
    expect(after?.context).not.toContain(
      'post-marker LID leak that must not stay recoverable',
    );
    expect(after?.context).not.toContain(
      'old private value fenced by the first isolation marker',
    );

    const noop = repairLeftoverClassifiableDirectWorkspaceMounts({
      apply: true,
    });
    expect(noop.applied).toBe(false);
    expect(noop.remounted).toBe(0);
    expect(db.getSession(folder)).toBe('clean-main-after-repair');
    expect(db.getSessionChannelOwner(folder)).toBe(waGroupJid);
    expect(db.getConversationHistoryIsolationMarker(workspaceJid)).toBe(
      repairAt,
    );
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
  });

  test('conflicting canonical WhatsApp aliases fail closed for manual unbind', () => {
    const firstWorkspace = 'web:alias-conflict-a';
    const secondWorkspace = 'web:alias-conflict-b';
    const firstFolder = 'alias-conflict-a';
    const secondFolder = 'alias-conflict-b';
    const firstAlias = 'whatsapp:16660001111:7@c.us#account:conflict-bot';
    const secondAlias = 'whatsapp:16660001111@c.us#account:conflict-bot';
    const canonical =
      'whatsapp:16660001111@s.whatsapp.net#account:conflict-bot';
    db.setRegisteredGroup(firstWorkspace, {
      name: 'Alias conflict A',
      folder: firstFolder,
      added_at: now,
      created_by: 'owner-a',
    });
    db.setRegisteredGroup(secondWorkspace, {
      name: 'Alias conflict B',
      folder: secondFolder,
      added_at: now,
      created_by: 'owner-b',
    });
    db.setRegisteredGroup(firstAlias, {
      name: 'First conflicting alias',
      folder: `${firstFolder}-direct`,
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'conflict-bot',
      target_main_jid: firstWorkspace,
    });
    db.setRegisteredGroup(secondAlias, {
      name: 'Second conflicting alias',
      folder: `${secondFolder}-direct`,
      added_at: now,
      created_by: 'owner-b',
      channel_account_id: 'conflict-bot',
      target_main_jid: secondWorkspace,
    });

    expect(
      resolveWhatsAppConversationAliasFromGroups(
        canonical,
        db.getAllRegisteredGroups(),
      ),
    ).toMatchObject({ status: 'conflict', jid: null });
    const diagnosis = diagnoseLeftoverClassifiableDirectWorkspaceMounts();
    expect(diagnosis.aliasConflicts).toEqual([
      expect.objectContaining({
        canonicalJid: canonical,
        aliases: [secondAlias, firstAlias].sort(),
        reason: 'routing_metadata_mismatch',
      }),
    ]);
    expect(() =>
      repairLeftoverClassifiableDirectWorkspaceMounts({ apply: true }),
    ).toThrow(/require manual unbind/);
    expect(db.getRegisteredGroup(firstAlias)).toMatchObject({
      target_main_jid: firstWorkspace,
    });
    expect(db.getRegisteredGroup(secondAlias)).toMatchObject({
      target_main_jid: secondWorkspace,
    });
    expect(db.listAgentsByJid(firstWorkspace)).toEqual([]);
    expect(db.listAgentsByJid(secondWorkspace)).toEqual([]);

    for (const [jid, sessionId] of [
      [firstAlias, 'conflicting-session-a'],
      [secondAlias, 'conflicting-session-b'],
    ] as const) {
      db.setRegisteredGroup(jid, {
        name: jid,
        folder: 'shared-conflict-direct',
        added_at: now,
        created_by: 'owner-a',
        channel_account_id: 'conflict-bot',
        target_agent_id: sessionId,
      });
    }
    expect(
      resolveWhatsAppConversationAliasFromGroups(
        canonical,
        db.getAllRegisteredGroups(),
      ),
    ).toMatchObject({ status: 'conflict', jid: null });
    expect(
      diagnoseLeftoverClassifiableDirectWorkspaceMounts().aliasConflicts,
    ).toHaveLength(1);
    expect(() =>
      repairLeftoverClassifiableDirectWorkspaceMounts({ apply: true }),
    ).toThrow(/require manual unbind/);

    db.deleteRegisteredGroup(firstAlias);
    db.deleteRegisteredGroup(secondAlias);
    db.deleteRegisteredGroup(firstWorkspace);
    db.deleteRegisteredGroup(secondWorkspace);
  });

  test('schema v73 remount-only leaves post-marker leaks recoverable, which is why this is not a migration', () => {
    const siblingWorkspaceJid = 'web:v73-remount-only';
    const siblingFolder = 'v73-remount-only';
    const leftoverJid = 'whatsapp:15551238888@lid#account:bot-b';
    const groupJid = 'whatsapp:120363111111111111@g.us#account:bot-b';
    db.setRegisteredGroup(siblingWorkspaceJid, {
      name: 'v73 remount-only workspace',
      folder: siblingFolder,
      added_at: now,
      created_by: 'owner-b',
    });
    db.setRegisteredGroup(leftoverJid, {
      name: 'LID leftover after old marker',
      folder: `${siblingFolder}-direct`,
      added_at: now,
      created_by: 'owner-b',
      channel_account_id: 'bot-b',
      target_main_jid: siblingWorkspaceJid,
    });
    db.setRegisteredGroup(groupJid, {
      name: 'WhatsApp group',
      folder: `${siblingFolder}-group`,
      added_at: now,
      created_by: 'owner-b',
      channel_account_id: 'bot-b',
      target_main_jid: siblingWorkspaceJid,
    });
    db.setSession(siblingFolder, 'still-contaminated-main');
    db.setSessionChannelOwnerOnce(siblingFolder, null, leftoverJid);
    db.setRouterState(
      `conversation_history_isolation:${siblingWorkspaceJid}`,
      oldIsolationAt,
    );
    db.ensureChatExists(siblingWorkspaceJid);
    db.storeMessageDirect(
      'v73-post-marker-leak',
      siblingWorkspaceJid,
      leftoverJid,
      'Private Alice',
      'v73 remount-only must not be treated as a successful privacy repair',
      '2026-08-19T12:00:00.000Z',
      false,
      { sourceJid: leftoverJid },
    );

    expect(
      db.migrateClassifiableDirectWorkspaceMountsToSessions(),
    ).toBeGreaterThanOrEqual(1);
    expect(db.getRegisteredGroup(leftoverJid)?.target_main_jid).toBeUndefined();
    expect(db.getSession(siblingFolder)).toBe('still-contaminated-main');
    expect(db.getConversationHistoryIsolationMarker(siblingWorkspaceJid)).toBe(
      oldIsolationAt,
    );
    const afterV73 = buildRecentConversationHistoryContext(
      siblingWorkspaceJid,
      new Set(),
      { intro: 'recovery' },
    );
    expect(afterV73?.context).toContain(
      'v73 remount-only must not be treated as a successful privacy repair',
    );
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
  });

  test('failed repair rolls back DB state and removes only newly created Agent directories', () => {
    const rollbackWorkspaceJid = 'web:rollback-repair-ws';
    const rollbackFolder = 'rollback-repair-ws';
    const rollbackDmJid = 'qq:c2c:rollback-user#account:bot-a';
    db.setRegisteredGroup(rollbackWorkspaceJid, {
      name: 'Rollback repair workspace',
      folder: rollbackFolder,
      added_at: now,
      created_by: 'owner-a',
    });
    db.setRegisteredGroup(rollbackDmJid, {
      name: 'Rollback private DM',
      folder: `${rollbackFolder}-direct`,
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: rollbackWorkspaceJid,
    });
    const preservedDirectories = [
      path.join(dataDir, 'ipc', rollbackFolder, 'agents', 'preexisting-agent'),
      path.join(
        dataDir,
        'sessions',
        rollbackFolder,
        'agents',
        'preexisting-agent',
      ),
    ];
    for (const directory of preservedDirectories) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'sentinel'), 'preserve me');
    }

    expect(() =>
      repairLeftoverClassifiableDirectWorkspaceMounts({
        apply: true,
        beforeIsolationReset: () => {
          throw new Error('injected repair failure');
        },
      }),
    ).toThrow('injected repair failure');

    expect(db.getRegisteredGroup(rollbackDmJid)).toMatchObject({
      target_main_jid: rollbackWorkspaceJid,
    });
    expect(db.listAgentsByJid(rollbackWorkspaceJid)).toEqual([]);
    for (const parent of [
      path.join(dataDir, 'ipc', rollbackFolder, 'agents'),
      path.join(dataDir, 'sessions', rollbackFolder, 'agents'),
    ]) {
      expect(fs.readdirSync(parent)).toEqual(['preexisting-agent']);
      expect(
        fs.readFileSync(
          path.join(parent, 'preexisting-agent', 'sentinel'),
          'utf8',
        ),
      ).toBe('preserve me');
    }
    db.deleteRegisteredGroup(rollbackDmJid);
    db.deleteRegisteredGroup(rollbackWorkspaceJid);
  });

  test('cleanup lookup errors preserve the original failure and do not stop later compensation', () => {
    const lookupWorkspaceJid = 'web:lookup-failure-ws';
    const lookupFolder = 'lookup-failure-ws';
    const lookupDms = [
      'qq:c2c:lookup-first#account:bot-a',
      'qq:c2c:lookup-second#account:bot-a',
    ];
    db.setRegisteredGroup(lookupWorkspaceJid, {
      name: 'Lookup failure workspace',
      folder: lookupFolder,
      added_at: now,
      created_by: 'owner-a',
    });
    for (const jid of lookupDms) {
      db.setRegisteredGroup(jid, {
        name: jid,
        folder: `${lookupFolder}-direct`,
        added_at: now,
        created_by: 'owner-a',
        channel_account_id: 'bot-a',
        target_main_jid: lookupWorkspaceJid,
      });
    }

    let lookupCalls = 0;
    expect(() =>
      repairLeftoverClassifiableDirectWorkspaceMounts({
        apply: true,
        beforeIsolationReset: () => {
          throw new Error('primary injected failure');
        },
        cleanupAgentLookup: (agentId) => {
          lookupCalls += 1;
          if (lookupCalls === 1)
            throw new Error(`lookup failed for ${agentId}`);
          return undefined;
        },
      }),
    ).toThrow(
      /repair failed \(primary injected failure\).*could not determine whether Agent remains committed/,
    );

    expect(lookupCalls).toBe(2);
    expect(db.listAgentsByJid(lookupWorkspaceJid)).toEqual([]);
    const ipcAgentDirs = fs.readdirSync(
      path.join(dataDir, 'ipc', lookupFolder, 'agents'),
    );
    const sessionAgentDirs = fs.readdirSync(
      path.join(dataDir, 'sessions', lookupFolder, 'agents'),
    );
    expect(ipcAgentDirs).toHaveLength(1);
    expect(sessionAgentDirs).toEqual(ipcAgentDirs);

    for (const jid of lookupDms) db.deleteRegisteredGroup(jid);
    db.deleteRegisteredGroup(lookupWorkspaceJid);
  });
});
