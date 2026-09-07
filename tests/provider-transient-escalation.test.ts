import { describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabledProviders: [
    {
      id: 'provider-a',
      enabled: true,
      weight: 1,
      anthropicModel: 'primary-model',
    },
    {
      id: 'provider-b',
      enabled: true,
      weight: 1,
      anthropicModel: 'primary-model',
    },
  ],
  fallbackModel: '',
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/runtime-config.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/runtime-config.js')
  >('../src/runtime-config.js');
  return {
    ...actual,
    getEnabledProviders: () => mocks.enabledProviders,
    getSystemSettings: () => ({
      ...actual.getSystemSettings(),
      fallbackModel: mocks.fallbackModel,
    }),
  };
});

const { applyProviderFailureDisposition } =
  await import('../src/container-runner.js');
const { providerPool } = await import('../src/provider-pool.js');
const {
  PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE,
  PROVIDER_MODEL_CONFIG_USER_NOTICE,
  PROVIDER_TRANSIENT_FAILURE_USER_NOTICE,
} = await import('../src/provider-failure.js');
type ContainerOutput = import('../src/container-runner.js').ContainerOutput;

function transient(
  messageId: string,
  livenessTimeout = false,
): ContainerOutput {
  return {
    status: 'success',
    result: null,
    providerFailure: true,
    providerFailureClass: 'transient',
    ...(livenessTimeout ? { providerLivenessTimeout: true } : {}),
    providerRateLimitScope: 'account',
    ipcReceipts: [
      {
        deliveryId: `delivery-${Math.random()}`,
        chatJid: 'web:x',
        cursor: { timestamp: '2026-08-24T00:00:00.000Z', id: messageId },
      },
    ],
  } as ContainerOutput;
}

function missingModel(messageId: string): ContainerOutput {
  return {
    status: 'success',
    result: null,
    providerFailure: true,
    providerFailureClass: 'config',
    providerRateLimitScope: 'model',
    providerRateLimitModel: 'primary-model',
    inputTurnId: messageId,
  } as ContainerOutput;
}

function resetPool(): void {
  providerPool.refreshFromConfig(mocks.enabledProviders, {
    strategy: 'failover',
    unhealthyThreshold: 2,
    recoveryIntervalMs: 300_000,
  });
  for (const provider of mocks.enabledProviders) {
    providerPool.resetHealth(provider.id);
  }
}

describe('transient provider failure isolation', () => {
  test('one replay is allowed without judging the account', () => {
    resetPool();
    const first = transient('msg-first-only');
    expect(applyProviderFailureDisposition(first, 'provider-a')).toBe(false);
    expect(first.providerFailureTerminal).toBe(false);
    expect(first.inputTurnCompleted).toBe(false);
    expect(providerPool.getHealthStatus('provider-a').healthy).toBe(true);
  });

  test.each([
    [false, PROVIDER_TRANSIENT_FAILURE_USER_NOTICE],
    [true, PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE],
  ])(
    'repeated 529/5xx or stall ends the input but never quarantines (liveness=%s)',
    (livenessTimeout, expectedNotice) => {
      resetPool();
      const id = `msg-terminal-${livenessTimeout}`;
      applyProviderFailureDisposition(
        transient(id, livenessTimeout),
        'provider-a',
      );

      const second = transient(id, livenessTimeout);
      expect(applyProviderFailureDisposition(second, 'provider-a')).toBe(true);
      expect(second.providerFailureClass).toBe('transient');
      expect(second.inputTurnCompleted).toBe(true);
      expect(second.providerFailureNotice).toBe(expectedNotice);
      expect(providerPool.getHealthStatus('provider-a').healthy).toBe(true);
      expect(providerPool.getHealthStatus('provider-b').healthy).toBe(true);
    },
  );

  test('the transient budget remains isolated per durable input', () => {
    resetPool();
    applyProviderFailureDisposition(transient('msg-a'), 'provider-a');
    applyProviderFailureDisposition(transient('msg-a'), 'provider-a');

    const other = transient('msg-b');
    expect(applyProviderFailureDisposition(other, 'provider-a')).toBe(false);
    expect(other.providerFailureTerminal).toBe(false);
  });
});

describe('model_not_found disposition', () => {
  test('an explicitly pinned configuration fails terminally without quarantine', () => {
    resetPool();
    const output = missingModel('pinned');
    expect(applyProviderFailureDisposition(output, 'provider-a', false)).toBe(
      true,
    );
    expect(output.providerFailureNotice).toBe(
      PROVIDER_MODEL_CONFIG_USER_NOTICE,
    );
    expect(providerPool.getHealthStatus('provider-a').healthy).toBe(true);
    expect(providerPool.isModelQuarantined('provider-a', 'primary-model')).toBe(
      false,
    );
  });

  test('an automatic pool fences only the failed provider/model pair and fails over', () => {
    resetPool();
    const first = missingModel('automatic-a');
    expect(applyProviderFailureDisposition(first, 'provider-a', true)).toBe(
      false,
    );
    expect(first.inputTurnCompleted).toBe(false);
    expect(providerPool.getHealthStatus('provider-a').healthy).toBe(true);
    expect(providerPool.isModelQuarantined('provider-a', 'primary-model')).toBe(
      true,
    );
    expect(providerPool.isModelQuarantined('provider-b', 'primary-model')).toBe(
      false,
    );

    const second = missingModel('automatic-b');
    expect(applyProviderFailureDisposition(second, 'provider-b', true)).toBe(
      true,
    );
    expect(second.providerFailureNotice).toBe(
      PROVIDER_MODEL_CONFIG_USER_NOTICE,
    );
    expect(providerPool.getHealthStatus('provider-b').healthy).toBe(true);
  });
});
