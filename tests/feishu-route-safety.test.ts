import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

describe('Feishu route safety integration', () => {
  test('treats a configured resolver returning null as a dropped message', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/feishu.ts'),
      'utf8',
    );

    expect(source).toContain('resolveAdmittedChannelRoute<FeishuMessageMeta>');
    expect(source).toContain(
      'Feishu binding resolver rejected route; dropping message',
    );
    expect(source).not.toContain('agentRouting?.effectiveJid ?? chatJid');
  });

  test('bootstraps an unregistered P2P chat before the route check, so the first-ever DM is not fail-closed forever', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/feishu.ts'),
      'utf8',
    );

    // P2P has no external "bot added" event like groups (onBotAddedToGroup)
    // and no /pair step like other channels, so the first DM must be able
    // to register the chat itself before resolveAdmittedChannelRoute is
    // consulted — otherwise a brand-new chat can never pass the route check
    // that must precede its own registration, dropping every message
    // forever. See channel-admission.ts's "pairing establishes ownership
    // before routing" contract.
    const bootstrapIdx = source.indexOf(
      "if (chatType === 'p2p' && resolveEffectiveChatJid) {",
    );
    const routeCheckIdx = source.indexOf(
      'resolveAdmittedChannelRoute<FeishuMessageMeta>',
    );

    expect(bootstrapIdx).toBeGreaterThan(-1);
    expect(routeCheckIdx).toBeGreaterThan(-1);
    expect(bootstrapIdx).toBeLessThan(routeCheckIdx);
  });

  test('treats resolveEffectiveChatJid throwing (account-scoped wrapper) the same as a null/no-route result in the P2P bootstrap check', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/feishu.ts'),
      'utf8',
    );

    // im-manager.ts's scopeConnectOpts wrapper throws
    // ChannelRouteRejectedError instead of returning null when a chat has
    // no route yet. Calling it unguarded in the P2P bootstrap pre-check
    // (before any registration has happened) would let that throw escape,
    // skip onNewChat/onP2pSender, and get caught by the outer handler as a
    // scheduled retry — repeating forever since registration never runs.
    const bootstrapBlock = source.slice(
      source.indexOf("if (chatType === 'p2p' && resolveEffectiveChatJid) {"),
      source.indexOf('resolveAdmittedChannelRoute<FeishuMessageMeta>'),
    );

    expect(bootstrapBlock).toContain('try {');
    expect(bootstrapBlock).toContain('hasExistingRoute = false');
  });
});
