import { describe, expect, test } from 'vitest';

import {
  CLI_NO_VISIBLE_OUTPUT_COMPANION,
  PROACTIVE_FINAL_DELIVERED_SENTINEL,
  isCliNoVisibleOutputCompanion,
  isProactiveFinalDeliveredSentinel,
  proactiveFinalWasDeliveredForInput,
} from '../container/agent-runner/src/proactive-turn-protocol.js';
import {
  createMcpTools,
  type McpContext,
} from '../container/agent-runner/src/mcp-tools.js';

function companion(overrides: Record<string, unknown> = {}) {
  return {
    type: 'user',
    parent_tool_use_id: null,
    isSynthetic: true,
    message: {
      role: 'user',
      content: [{ type: 'text', text: CLI_NO_VISIBLE_OUTPUT_COMPANION }],
    },
    ...overrides,
  };
}

describe('Proactive terminal control protocol', () => {
  test('recognizes only the exact invisible final sentinel', () => {
    expect(
      isProactiveFinalDeliveredSentinel(
        `  ${PROACTIVE_FINAL_DELIVERED_SENTINEL}\n`,
      ),
    ).toBe(true);
    expect(isProactiveFinalDeliveredSentinel('final delivered')).toBe(false);
  });

  test('recognizes the exact synthetic Claude CLI companion', () => {
    expect(isCliNoVisibleOutputCompanion(companion())).toBe(true);
    expect(
      isCliNoVisibleOutputCompanion(
        companion({ isSynthetic: false, isMeta: true }),
      ),
    ).toBe(true);
    expect(
      isCliNoVisibleOutputCompanion(
        companion({ isSynthetic: false, turnCompanion: true }),
      ),
    ).toBe(true);
  });

  test('never consumes user-authored or merely similar text', () => {
    expect(
      isCliNoVisibleOutputCompanion(companion({ isSynthetic: false })),
    ).toBe(false);
    expect(
      isCliNoVisibleOutputCompanion(
        companion({
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'no visible output' }],
          },
        }),
      ),
    ).toBe(false);
  });

  test('requires the final ACK to belong to the exact current input', () => {
    expect(proactiveFinalWasDeliveredForInput('turn-a', 'turn-a')).toBe(true);
    expect(proactiveFinalWasDeliveredForInput('turn-a', 'turn-b')).toBe(false);
    expect(proactiveFinalWasDeliveredForInput(undefined, 'turn-a')).toBe(false);
  });

  test('rejects a second Proactive final before creating another IPC request', async () => {
    const ctx: McpContext = {
      chatJid: 'web:main',
      groupFolder: 'main',
      isHome: true,
      isAdminHome: true,
      agentBuilderEnabled: false,
      ownerProfileEnabled: false,
      interactionMode: 'proactive',
      currentInputTurnId: 'turn-a',
      proactiveFinalDeliveredInputTurnId: 'turn-a',
      workspaceIpc: '/tmp/unused-happyclaw-ipc',
      workspaceGroup: '/tmp/unused-happyclaw-group',
    };
    const sendMessage = createMcpTools(ctx).find(
      (definition) => definition.name === 'send_message',
    );
    expect(sendMessage).toBeDefined();
    await expect(
      sendMessage!.handler({ text: 'duplicate', delivery_role: 'final' }, {}),
    ).rejects.toThrow('already sealed');
  });
});
