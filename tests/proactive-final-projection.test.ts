import { describe, expect, test, vi } from 'vitest';

import { preserveUnacknowledgedProactiveFinal } from '../src/proactive-final-recovery.js';
import { ActiveTurnOutputRegistry } from '../src/turn-output-coordinator.js';

const SCOPE = 'workspace\0conversation:agent';
const TURN = 'turn-1';

describe('Explicit Proactive final projection', () => {
  test('preserves the exact send_message final in Web without claiming native ACK', async () => {
    const registry = new ActiveTurnOutputRegistry();
    const nativeDelivered = vi.fn();
    registry.bind(SCOPE, TURN, {
      onProgress: () => true,
      onFinalCandidate: () => true,
      onUtteranceDelivered: nativeDelivered,
    });
    registry.recordAttemptedFinal({
      scopeKey: SCOPE,
      inputTurnId: TURN,
      text: '# 完整总结\n\n四个 AI-native 工作方式',
    });
    const project = vi.fn(async () => true);

    await expect(
      preserveUnacknowledgedProactiveFinal({
        registry,
        scopeKey: SCOPE,
        inputTurnId: TURN,
        text: '# 完整总结\n\n四个 AI-native 工作方式',
        nativeFailure: 'uncertain',
        project,
      }),
    ).resolves.toEqual({
      projected: true,
      webCompleted: false,
      finalizationReason: 'delivery_uncertain',
    });
    expect(project).toHaveBeenCalledWith(
      '# 完整总结\n\n四个 AI-native 工作方式',
      'delivery_uncertain',
    );
    expect(nativeDelivered).not.toHaveBeenCalled();
    expect(registry.get(SCOPE, TURN)?.hasDeliveredUtterance).toBe(true);
  });

  test('does not record a projection when canonical Web persistence fails', async () => {
    const registry = new ActiveTurnOutputRegistry();
    registry.bind(SCOPE, TURN, {
      onProgress: () => true,
      onFinalCandidate: () => true,
    });

    await expect(
      preserveUnacknowledgedProactiveFinal({
        registry,
        scopeKey: SCOPE,
        inputTurnId: TURN,
        text: '工具明确发送的 final',
        nativeFailure: 'unavailable',
        project: async () => false,
      }),
    ).resolves.toEqual({
      projected: false,
      webCompleted: false,
      finalizationReason: 'error',
    });
    expect(registry.get(SCOPE, TURN)?.hasDeliveredUtterance).toBe(false);
  });

  test('preserves a definitively rejected native final without claiming uncertainty', async () => {
    const registry = new ActiveTurnOutputRegistry();
    registry.bind(SCOPE, TURN, {
      onProgress: () => true,
      onFinalCandidate: () => true,
    });
    const project = vi.fn(async () => true);

    await expect(
      preserveUnacknowledgedProactiveFinal({
        registry,
        scopeKey: SCOPE,
        inputTurnId: TURN,
        text: '包含公开邮件地址的完整答案',
        nativeFailure: 'rejected',
        project,
      }),
    ).resolves.toEqual({
      projected: true,
      webCompleted: true,
      finalizationReason: 'completed',
    });
    expect(project).toHaveBeenCalledWith(
      '包含公开邮件地址的完整答案',
      'completed',
    );
  });
});
