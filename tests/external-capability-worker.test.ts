import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import ExcelJS from 'exceljs';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/db.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  clearExternalCapabilityRunContainerCleanupRequired: vi.fn(() => true),
}));
vi.mock('../src/external-capability-vault-lock.js', () => ({
  acquireExternalCapabilityVaultSharedLock: vi.fn(() => ({
    release: vi.fn(),
  })),
}));

import { clearExternalCapabilityRunContainerCleanupRequired } from '../src/db.js';
import {
  getInstallationId,
  HAPPYCLAW_INSTALLATION_LABEL,
  HAPPYCLAW_MANAGED_LABEL,
} from '../src/instance-ownership.js';
import {
  assertExternalCapabilityWorkbookMemoryBudget,
  clearExternalContainerCleanupMarkerIdempotentlyForTest,
  countAdoptedExternalContainerSlotsForTest,
  countPendingExternalContainerCleanupsForTest,
  createExternalCapabilitySpreadsheetPreview,
  drainExternalCapabilityExecutions,
  getExternalPrestartRetryDecision,
  hasExternalCapabilityExecutionTimedOut,
  isExternalStartDefinitelyUnpublishedForTest,
  recordExternalUsageBatch,
  parseExternalCapabilityAgentRows,
  quarantineExternalContainerCleanupForTest,
  quiesceExternalCapabilityContainersForVaultCensusForTest,
  reconcileExternalCapabilityContainersForTest,
  recoverMarkerOnlyContainerCleanupDebtsForTest,
  sealExternalCapabilityInputDirectory,
  stageExternalCapabilityInputArtifact,
  stopExternalCapabilityWorker,
  terminateExternalContainerForTest,
  type ExternalContainerExecution,
} from '../src/external-capability-worker.js';

function ownedContainerLabels(
  labels: Record<string, string> = {},
): Record<string, string> {
  return {
    [HAPPYCLAW_MANAGED_LABEL]: 'true',
    [HAPPYCLAW_INSTALLATION_LABEL]: getInstallationId(),
    ...labels,
  };
}

type StartRecoveryFixture = {
  vaultRoot: string;
  runId: string;
  authorizationDirectory: string;
  outputDirectory: string;
};

type ManagedCleanupDirectory = {
  executionDirectory: string;
  cleanup: () => void;
};

function createManagedCleanupDirectory(): ManagedCleanupDirectory {
  const vaultRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'happyclaw-external-cleanup-vault-'),
  );
  const previousVaultRoot = process.env.EXTERNAL_CAPABILITY_VAULT_DIR;
  const runtimeRoot = path.join(vaultRoot, 'runtime');
  const executionDirectory = path.join(
    runtimeRoot,
    '123e4567-e89b-42d3-a456-426614174000-a1-l1-ABC123',
  );
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  fs.mkdirSync(executionDirectory, { mode: 0o700 });
  process.env.EXTERNAL_CAPABILITY_VAULT_DIR = vaultRoot;

  return {
    executionDirectory,
    cleanup: () => {
      if (previousVaultRoot === undefined) {
        delete process.env.EXTERNAL_CAPABILITY_VAULT_DIR;
      } else {
        process.env.EXTERNAL_CAPABILITY_VAULT_DIR = previousVaultRoot;
      }
      fs.rmSync(vaultRoot, { recursive: true, force: true });
    },
  };
}

function classifyStartRecoveryFixture(
  setup: (fixture: StartRecoveryFixture) => void,
  identity = { runId: 'start-recovery-run', attempt: 2, leaseToken: 7 },
): boolean {
  const vaultRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'happyclaw-external-vault-'),
  );
  const previousVaultRoot = process.env.EXTERNAL_CAPABILITY_VAULT_DIR;
  const attemptDirectory = path.join(
    vaultRoot,
    'runtime',
    `${identity.runId}-a${identity.attempt}-l${identity.leaseToken}-ABC123`,
  );
  const authorizationDirectory = path.join(
    attemptDirectory,
    'runtime',
    'authorization',
  );
  const outputDirectory = path.join(attemptDirectory, 'output');
  fs.mkdirSync(authorizationDirectory, { recursive: true });
  fs.mkdirSync(outputDirectory);
  process.env.EXTERNAL_CAPABILITY_VAULT_DIR = vaultRoot;
  try {
    setup({
      vaultRoot,
      runId: identity.runId,
      authorizationDirectory,
      outputDirectory,
    });
    return isExternalStartDefinitelyUnpublishedForTest(identity);
  } finally {
    if (previousVaultRoot === undefined) {
      delete process.env.EXTERNAL_CAPABILITY_VAULT_DIR;
    } else {
      process.env.EXTERNAL_CAPABILITY_VAULT_DIR = previousVaultRoot;
    }
    fs.rmSync(vaultRoot, { recursive: true, force: true });
  }
}

function writeStartDecision(
  authorizationDirectory: string,
  decision: 'start' | 'abort',
  authorizationId = 'attempt-1',
): void {
  fs.writeFileSync(
    path.join(authorizationDirectory, 'decision.json'),
    JSON.stringify({ protocol: 1, authorizationId, decision }),
  );
}

function writeStartAcknowledgement(
  outputDirectory: string,
  authorizationId = 'attempt-1',
): void {
  fs.writeFileSync(
    path.join(outputDirectory, 'start-consumed.json'),
    JSON.stringify({ protocol: 1, authorizationId, consumed: true }),
  );
}

describe('external START recovery classification', () => {
  test('replays an attempt with no published decision', () => {
    expect(classifyStartRecoveryFixture(() => {})).toBe(true);
  });

  test('replays an explicitly aborted attempt', () => {
    expect(
      classifyStartRecoveryFixture(({ authorizationDirectory }) => {
        writeStartDecision(authorizationDirectory, 'abort');
      }),
    ).toBe(true);
  });

  test('replays a late START that the absent runner never acknowledged', () => {
    expect(
      classifyStartRecoveryFixture(({ authorizationDirectory }) => {
        writeStartDecision(authorizationDirectory, 'start');
      }),
    ).toBe(true);
  });

  test('does not replay a START with a matching consumption acknowledgement', () => {
    expect(
      classifyStartRecoveryFixture(
        ({ authorizationDirectory, outputDirectory }) => {
          writeStartDecision(authorizationDirectory, 'start');
          writeStartAcknowledgement(outputDirectory);
        },
      ),
    ).toBe(false);
  });

  test('does not use stale pre-START evidence from an earlier attempt', () => {
    expect(
      classifyStartRecoveryFixture(
        ({ vaultRoot, runId, authorizationDirectory }) => {
          const currentAttemptDirectory = path.dirname(
            path.dirname(authorizationDirectory),
          );
          fs.rmSync(currentAttemptDirectory, { recursive: true, force: true });

          const staleAuthorizationDirectory = path.join(
            vaultRoot,
            'runtime',
            `${runId}-a1-l3-ABC123`,
            'runtime',
            'authorization',
          );
          fs.mkdirSync(staleAuthorizationDirectory, { recursive: true });
          fs.mkdirSync(
            path.join(vaultRoot, 'runtime', `${runId}-a1-l3-ABC123`, 'output'),
          );
        },
      ),
    ).toBe(false);
  });

  test.each([
    {
      name: 'mismatched acknowledgement',
      setup: ({
        authorizationDirectory,
        outputDirectory,
      }: StartRecoveryFixture) => {
        writeStartDecision(authorizationDirectory, 'start');
        writeStartAcknowledgement(outputDirectory, 'different-attempt');
      },
    },
    {
      name: 'malformed acknowledgement',
      setup: ({
        authorizationDirectory,
        outputDirectory,
      }: StartRecoveryFixture) => {
        writeStartDecision(authorizationDirectory, 'start');
        fs.writeFileSync(
          path.join(outputDirectory, 'start-consumed.json'),
          '{broken',
        );
      },
    },
    {
      name: 'malformed decision',
      setup: ({ authorizationDirectory }: StartRecoveryFixture) => {
        fs.writeFileSync(
          path.join(authorizationDirectory, 'decision.json'),
          JSON.stringify({ protocol: 1, decision: 'start' }),
        );
      },
    },
    {
      name: 'oversized decision',
      setup: ({ authorizationDirectory }: StartRecoveryFixture) => {
        fs.writeFileSync(
          path.join(authorizationDirectory, 'decision.json'),
          'x'.repeat(4 * 1024 + 1),
        );
      },
    },
    {
      name: 'multiply linked acknowledgement',
      setup: ({
        authorizationDirectory,
        outputDirectory,
      }: StartRecoveryFixture) => {
        writeStartDecision(authorizationDirectory, 'start');
        writeStartAcknowledgement(outputDirectory);
        fs.linkSync(
          path.join(outputDirectory, 'start-consumed.json'),
          path.join(outputDirectory, 'ack-link.json'),
        );
      },
    },
  ])('fails closed for $name', ({ setup }) => {
    expect(classifyStartRecoveryFixture(setup)).toBe(false);
  });

  test('fails closed for a symlinked acknowledgement', () => {
    expect(
      classifyStartRecoveryFixture(
        ({ authorizationDirectory, outputDirectory }) => {
          writeStartDecision(authorizationDirectory, 'start');
          const target = path.join(outputDirectory, 'ack-target.json');
          writeStartAcknowledgement(outputDirectory);
          fs.renameSync(
            path.join(outputDirectory, 'start-consumed.json'),
            target,
          );
          fs.symlinkSync(
            target,
            path.join(outputDirectory, 'start-consumed.json'),
          );
        },
      ),
    ).toBe(false);
  });
});

describe('external capability spreadsheet preview', () => {
  test('extracts bounded worksheet text from a valid workbook', async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Items');
    worksheet.addRows([
      ['name', 'quantity'],
      ['desk', 2],
    ]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());

    await expect(
      createExternalCapabilitySpreadsheetPreview(bytes),
    ).resolves.toContain('# Sheet: Items\nname\tquantity\ndesk\t2');
  });

  test('rejects parser failures instead of sending placeholder data to the model', async () => {
    await expect(
      createExternalCapabilitySpreadsheetPreview(
        Buffer.from('PK\x03\x04broken', 'binary'),
      ),
    ).rejects.toThrow(/could not be parsed/);
  });

  test('rejects workbooks that cannot be represented without truncation', async () => {
    const workbook = new ExcelJS.Workbook();
    for (let index = 1; index <= 9; index += 1) {
      workbook.addWorksheet(`Sheet ${index}`).addRow([`value ${index}`]);
    }
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());

    await expect(
      createExternalCapabilitySpreadsheetPreview(bytes),
    ).rejects.toThrow(/exceeds safe processing limits/);
  });
});

describe('external capability model output validation', () => {
  test('rejects JSON numeric overflow before generating a workbook', () => {
    expect(() =>
      parseExternalCapabilityAgentRows(
        '{"rows":[{"amount":1e400}],"warnings":[]}',
        [{ key: 'amount', name: 'Amount' }],
        100,
      ),
    ).toThrow(/unsafe numeric value/);
    expect(() =>
      parseExternalCapabilityAgentRows(
        '{"rows":[{"amount":9007199254740993}],"warnings":[]}',
        [{ key: 'amount', name: 'Amount' }],
        100,
      ),
    ).toThrow(/unsafe numeric value/);
  });

  test('rejects row-column products above the workbook cell budget', () => {
    expect(() =>
      parseExternalCapabilityAgentRows(
        JSON.stringify({ rows: [{}, {}, {}], warnings: [] }),
        [
          { key: 'a', name: 'A' },
          { key: 'b', name: 'B' },
        ],
        100,
        5,
      ),
    ).toThrow(/invalid row set/);
  });

  test('enforces the heap-safe 50,000-cell ceiling including headers', () => {
    const columns = Array.from({ length: 100 }, (_, index) => ({
      key: `column_${index}`,
      name: `Column ${index}`,
    }));
    expect(
      parseExternalCapabilityAgentRows(
        JSON.stringify({
          rows: Array.from({ length: 499 }, () => ({})),
          warnings: [],
        }),
        columns,
        10_000,
      ).rows,
    ).toHaveLength(499);
    expect(() =>
      parseExternalCapabilityAgentRows(
        JSON.stringify({
          rows: Array.from({ length: 500 }, () => ({})),
          warnings: [],
        }),
        columns,
        10_000,
      ),
    ).toThrow(/invalid row set/);
  });

  test('rejects high-amplification workbooks before ExcelJS materialization', () => {
    const columns = Array.from({ length: 100 }, (_, index) => ({
      key: `column_${index}`,
      name: `Column ${index}`,
    }));
    const denseRow = Object.fromEntries(
      columns.map((column) => [column.key, 'x'.repeat(180)]),
    );

    expect(() =>
      assertExternalCapabilityWorkbookMemoryBudget(
        { columns },
        Array.from({ length: 500 }, () => denseRow),
      ),
    ).toThrow(/materialization memory limit/);
    expect(() =>
      assertExternalCapabilityWorkbookMemoryBudget(
        { columns },
        Array.from({ length: 500 }, () => ({})),
      ),
    ).not.toThrow();
  });

  test('materializes requested columns and adds required-value warnings', () => {
    expect(
      parseExternalCapabilityAgentRows(
        JSON.stringify({
          rows: [{ quantity: 2 }],
          warnings: [
            {
              code: 'SOURCE_UNCERTAIN',
              rowIndex: 1,
              columnKey: 'quantity',
            },
          ],
        }),
        [
          { key: 'name', name: '名称', required: true },
          { key: 'quantity', name: '数量' },
        ],
        100,
      ),
    ).toEqual({
      rows: [{ name: null, quantity: 2 }],
      warnings: [
        {
          code: 'SOURCE_UNCERTAIN',
          rowIndex: 1,
          columnKey: 'quantity',
        },
        {
          code: 'MISSING_REQUIRED_VALUE',
          rowIndex: 1,
          columnKey: 'name',
        },
      ],
    });
  });

  test('treats omitted prototype-named columns as null', () => {
    expect(
      parseExternalCapabilityAgentRows(
        '{"rows":[{}],"warnings":[]}',
        [
          { key: 'constructor', name: 'Constructor' },
          { key: 'toString', name: 'To string' },
        ],
        100,
      ),
    ).toEqual({
      rows: [{ constructor: null, toString: null }],
      warnings: [],
    });
  });

  test('rejects unknown columns, warning prose, and sensitive cell values', () => {
    expect(() =>
      parseExternalCapabilityAgentRows(
        '{"rows":[{"amount":1,"phone":"secret"}],"warnings":[]}',
        [{ key: 'amount', name: '金额' }],
        100,
      ),
    ).toThrow(/unsupported column key/);
    expect(() =>
      parseExternalCapabilityAgentRows(
        '{"rows":[{"amount":1}],"warnings":["review 13800138000"]}',
        [{ key: 'amount', name: '金额' }],
        100,
      ),
    ).toThrow(/invalid warnings/);
    expect(() =>
      parseExternalCapabilityAgentRows(
        '{"rows":[{"item":"联系人：张三"}],"warnings":[]}',
        [{ key: 'item', name: '项目' }],
        100,
      ),
    ).toThrow(/prohibited sensitive data/);
    expect(() =>
      parseExternalCapabilityAgentRows(
        '{"rows":[{"value":13800138000}],"warnings":[]}',
        [{ key: 'value', name: '数值' }],
        100,
      ),
    ).toThrow(/prohibited sensitive data/);
  });
});

describe('external capability pre-START retry policy', () => {
  test('uses bounded exponential backoff for runtime failures', () => {
    expect(getExternalPrestartRetryDecision(1)).toEqual({
      retry: true,
      delayMs: 1_000,
    });
    expect(getExternalPrestartRetryDecision(2)).toEqual({
      retry: true,
      delayMs: 2_000,
    });
    expect(getExternalPrestartRetryDecision(3)).toEqual({
      retry: false,
      delayMs: 0,
    });
  });

  test('does not consume attempts while an operator gate is unavailable', () => {
    expect(getExternalPrestartRetryDecision(500, false)).toEqual({
      retry: true,
      delayMs: 1_000,
    });
  });
});

describe('external capability usage accounting', () => {
  function batchState() {
    return { batchCount: null, seenBatchIndexes: new Set<number>() };
  }

  test('requires every valid usage batch before accounting is complete', () => {
    const single = batchState();
    expect(recordExternalUsageBatch(single, undefined, undefined)).toBe(true);

    const multiple = batchState();
    expect(recordExternalUsageBatch(multiple, 1, 2)).toBe(false);
    expect(recordExternalUsageBatch(multiple, 0, 2)).toBe(true);

    expect(() => recordExternalUsageBatch(batchState(), -1, 1)).toThrow(
      /batch metadata/,
    );
    expect(() => recordExternalUsageBatch(batchState(), 1, 1)).toThrow(
      /batch metadata/,
    );
    expect(() => recordExternalUsageBatch(batchState(), 0, 0)).toThrow(
      /batch metadata/,
    );
    const inconsistent = batchState();
    expect(recordExternalUsageBatch(inconsistent, 0, 2)).toBe(false);
    expect(() => recordExternalUsageBatch(inconsistent, 1, 3)).toThrow(
      /batch metadata/,
    );
  });
});

describe('external capability execution deadline', () => {
  test('detects a crossed deadline even when the timer callback was blocked', () => {
    const execution: ExternalContainerExecution = {
      cancelled: false,
      timedOut: false,
      shuttingDown: false,
      container: null,
      containerName: null,
      terminationPromise: null,
    };

    expect(
      hasExternalCapabilityExecutionTimedOut(execution, 1_000, () => 999),
    ).toBe(false);
    expect(
      hasExternalCapabilityExecutionTimedOut(execution, 1_000, () => 1_000),
    ).toBe(true);
    expect(execution.timedOut).toBe(true);
  });
});

describe('external capability container termination', () => {
  test('treats an already-cleared exact cleanup marker as idempotent success', () => {
    const clearOwned = vi.fn(() => false);
    const clearAfterVerifiedAbsence = vi.fn(() => false);

    expect(
      clearExternalContainerCleanupMarkerIdempotentlyForTest(
        'concurrently-cleared',
        2,
        7,
        {
          clearOwned,
          clearAfterVerifiedAbsence,
          getRun: () =>
            ({
              container_cleanup_attempt: null,
              container_cleanup_lease_token: null,
              container_create_pending_until: null,
            }) as any,
        },
      ),
    ).toBe(true);
    expect(clearOwned).toHaveBeenCalledWith('concurrently-cleared', 2, 7);
    expect(clearAfterVerifiedAbsence).toHaveBeenCalledWith(
      'concurrently-cleared',
      2,
      7,
    );
  });

  test('keeps a replaced cleanup generation fenced', () => {
    expect(
      clearExternalContainerCleanupMarkerIdempotentlyForTest(
        'replaced-generation',
        2,
        7,
        {
          clearOwned: () => false,
          clearAfterVerifiedAbsence: () => false,
          getRun: () =>
            ({
              container_cleanup_attempt: 3,
              container_cleanup_lease_token: 8,
              container_create_pending_until: null,
            }) as any,
        },
      ),
    ).toBe(false);
  });

  test('rechecks marker-only cleanup debt after its physical witnesses are gone', async () => {
    const verifyRunContainerAbsent = vi.fn(async () => true);

    await recoverMarkerOnlyContainerCleanupDebtsForTest(
      [
        { runId: 'marker-only', attempt: 2, leaseToken: 7 },
        { runId: 'still-listed', attempt: 3, leaseToken: 9 },
      ],
      new Set(['still-listed:3:9']),
      verifyRunContainerAbsent,
    );

    expect(verifyRunContainerAbsent).toHaveBeenCalledOnce();
    expect(verifyRunContainerAbsent).toHaveBeenCalledWith('marker-only');
  });

  function execution(kill = vi.fn()): ExternalContainerExecution {
    return {
      cancelled: false,
      timedOut: false,
      shuttingDown: false,
      container: { kill } as unknown as ChildProcess,
      containerName: 'external-capability-test',
      terminationPromise: null,
    };
  }

  test('escalates a failed stop and resolves only after confirmed absence', async () => {
    const commands: string[][] = [];
    const localKill = vi.fn();
    let presenceChecks = 0;
    let releaseWait: (() => void) | null = null;
    const blockedWait = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    const wait = vi
      .fn<(milliseconds: number) => Promise<void>>()
      .mockImplementationOnce(() => blockedWait);

    const termination = terminateExternalContainerForTest(
      execution(localKill),
      {
        runDockerCommand: async (args) => {
          commands.push(args);
          if (args[0] === 'stop') return { ok: false, stdout: '' };
          if (args[0] === 'kill' || args[0] === 'rm') {
            return { ok: true, stdout: '' };
          }
          presenceChecks += 1;
          return {
            ok: true,
            stdout: presenceChecks < 3 ? 'container-id\n' : '',
          };
        },
        wait,
      },
    );

    let settled = false;
    void termination.then(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(wait).toHaveBeenCalledOnce();
    });
    expect(settled).toBe(false);
    expect(localKill).toHaveBeenCalledWith('SIGKILL');
    expect(commands.slice(0, 5).map((args) => args[0])).toEqual([
      'stop',
      'container',
      'kill',
      'rm',
      'container',
    ]);

    releaseWait!();
    await expect(termination).resolves.toBe(true);
    expect(commands.at(-1)?.[0]).toBe('container');
    expect(presenceChecks).toBe(3);
  });

  test('does not treat Docker command failures as verified absence', async () => {
    const localKill = vi.fn();
    const runDockerCommand = vi.fn(async (args: string[]) => {
      if (args[0] === 'stop' || args[0] === 'kill') {
        return { ok: true, stdout: '' };
      }
      return { ok: false, stdout: '' };
    });

    await expect(
      terminateExternalContainerForTest(execution(localKill), {
        runDockerCommand,
        wait: async () => {},
      }),
    ).resolves.toBe(false);
    expect(runDockerCommand).toHaveBeenCalledWith(
      ['kill', 'external-capability-test'],
      10_000,
    );
    expect(runDockerCommand).toHaveBeenCalledWith(
      ['rm', '--force', 'external-capability-test'],
      10_000,
    );
    expect(localKill).toHaveBeenCalledWith('SIGKILL');
  });

  test('force-removes a created container that stop and kill cannot remove', async () => {
    let present = true;
    const commands: string[][] = [];
    const runDockerCommand = vi.fn(async (args: string[]) => {
      commands.push(args);
      if (args[0] === 'container') {
        return { ok: true, stdout: present ? 'container-id\n' : '' };
      }
      if (args[0] === 'stop' || args[0] === 'kill') {
        return { ok: false, stdout: '' };
      }
      if (args[0] === 'rm') {
        present = false;
        return { ok: true, stdout: '' };
      }
      return { ok: false, stdout: '' };
    });

    await expect(
      terminateExternalContainerForTest(execution(), {
        runDockerCommand,
        wait: async () => {},
      }),
    ).resolves.toBe(true);
    expect(commands.map((args) => args[0])).toEqual([
      'stop',
      'container',
      'kill',
      'rm',
      'container',
    ]);
  });

  test('allows a Docker-free Vault census only when startup proved no container debt', async () => {
    const dependencies = {
      runDockerCommand: vi.fn(async () => ({ ok: false, stdout: '' })),
      wait: async () => {},
      inspectContainerLabels: async () => null,
      fenceLease: () => 'stale' as const,
    };

    await expect(
      quiesceExternalCapabilityContainersForVaultCensusForTest(dependencies, {
        allowDockerUnavailable: true,
      }),
    ).resolves.toEqual({
      discovered: 0,
      preserved: 0,
      stopped: 0,
      unverified: 0,
    });
    await expect(
      quiesceExternalCapabilityContainersForVaultCensusForTest(dependencies),
    ).rejects.toThrow(/Could not enumerate external capability containers/);
  });

  test('refuses a Vault census while a live foreign container can mutate runtime storage', async () => {
    const containerName = 'happyclaw-external-live-run-1-2';
    const runDockerCommand = vi.fn(async (args: string[]) => {
      if (args.includes('{{.Names}}')) {
        return { ok: true, stdout: `${containerName}\n` };
      }
      return { ok: false, stdout: '' };
    });

    await expect(
      quiesceExternalCapabilityContainersForVaultCensusForTest({
        runDockerCommand,
        wait: async () => {},
        inspectContainerLabels: async () =>
          ownedContainerLabels({
            'com.happyclaw.external': 'true',
            'com.happyclaw.external.protocol': '1',
            'com.happyclaw.external.run-id': 'live-run',
            'com.happyclaw.external.attempt': '1',
            'com.happyclaw.external.lease-token': '2',
          }),
        fenceLease: () => 'active',
      }),
    ).rejects.toThrow(/blocked by 1 live container/);
    expect(runDockerCommand).toHaveBeenCalledTimes(1);
  });

  test('releases quarantined capacity only after reconciliation verifies removal', async () => {
    const { executionDirectory, cleanup } = createManagedCleanupDirectory();
    const releaseContainerSlot = vi.fn();
    quarantineExternalContainerCleanupForTest({
      runId: 'quarantined-run',
      containerName: 'happyclaw-external-quarantined',
      executionDirectory,
      releaseContainerSlot,
    });

    try {
      await expect(
        reconcileExternalCapabilityContainersForTest({
          runDockerCommand: async (args) => {
            if (args.includes('{{.Names}}')) {
              return {
                ok: true,
                stdout: 'happyclaw-external-quarantined\n',
              };
            }
            if (args[0] === 'stop') return { ok: true, stdout: '' };
            if (args[0] === 'container') return { ok: true, stdout: '' };
            return { ok: false, stdout: '' };
          },
          wait: async () => {},
          inspectContainerLabels: async () =>
            ownedContainerLabels({
              'com.happyclaw.external': 'true',
            }),
          fenceLease: () => 'stale',
        }),
      ).resolves.toMatchObject({ stopped: 1, unverified: 0 });

      expect(releaseContainerSlot).toHaveBeenCalledOnce();
      expect(countPendingExternalContainerCleanupsForTest()).toBe(0);
      expect(fs.existsSync(executionDirectory)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('retries a quarantined finalizer after a transient database failure', async () => {
    const containerName = 'happyclaw-external-busy-cleanup';
    const releaseContainerSlot = vi.fn();
    quarantineExternalContainerCleanupForTest({
      runId: 'busy-cleanup-run',
      containerName,
      releaseContainerSlot,
    });
    const clearCleanup = vi.mocked(
      clearExternalCapabilityRunContainerCleanupRequired,
    );
    clearCleanup.mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY');
    });
    const dependencies = {
      runDockerCommand: async (args: string[]) => {
        if (args.includes('{{.Names}}')) return { ok: true, stdout: '' };
        if (args[0] === 'container') return { ok: true, stdout: '' };
        return { ok: false, stdout: '' };
      },
      wait: async () => {},
      inspectContainerLabels: async () => null,
      fenceLease: () => 'stale' as const,
    };

    await expect(
      reconcileExternalCapabilityContainersForTest(dependencies),
    ).rejects.toThrow('SQLITE_BUSY');
    expect(countPendingExternalContainerCleanupsForTest()).toBe(1);
    expect(releaseContainerSlot).not.toHaveBeenCalled();

    await expect(
      reconcileExternalCapabilityContainersForTest(dependencies),
    ).resolves.toEqual({
      discovered: 0,
      preserved: 0,
      stopped: 0,
      unverified: 0,
    });
    expect(countPendingExternalContainerCleanupsForTest()).toBe(0);
    expect(releaseContainerSlot).toHaveBeenCalledOnce();
  });

  test('retries private runtime deletion before clearing durable cleanup state', async () => {
    const { executionDirectory, cleanup } = createManagedCleanupDirectory();
    const containerName = 'happyclaw-external-runtime-cleanup-retry';
    const releaseContainerSlot = vi.fn();
    quarantineExternalContainerCleanupForTest({
      runId: 'runtime-cleanup-retry-run',
      containerName,
      executionDirectory,
      releaseContainerSlot,
    });
    const clearCleanup = vi.mocked(
      clearExternalCapabilityRunContainerCleanupRequired,
    );
    const priorClearCalls = clearCleanup.mock.calls.length;
    const removeDirectory = vi
      .spyOn(fs, 'rmSync')
      .mockImplementationOnce(() => {
        throw new Error('EBUSY');
      });
    const dependencies = {
      runDockerCommand: async (args: string[]) => {
        if (args.includes('{{.Names}}')) return { ok: true, stdout: '' };
        if (args[0] === 'container') return { ok: true, stdout: '' };
        return { ok: false, stdout: '' };
      },
      wait: async () => {},
      inspectContainerLabels: async () => null,
      fenceLease: () => 'stale' as const,
    };

    try {
      await expect(
        reconcileExternalCapabilityContainersForTest(dependencies),
      ).rejects.toThrow('EBUSY');
      expect(countPendingExternalContainerCleanupsForTest()).toBe(1);
      expect(clearCleanup).toHaveBeenCalledTimes(priorClearCalls);
      expect(releaseContainerSlot).not.toHaveBeenCalled();
      expect(fs.existsSync(executionDirectory)).toBe(true);

      await expect(
        reconcileExternalCapabilityContainersForTest(dependencies),
      ).resolves.toEqual({
        discovered: 0,
        preserved: 0,
        stopped: 0,
        unverified: 0,
      });
      expect(clearCleanup).toHaveBeenCalledTimes(priorClearCalls + 1);
      expect(countPendingExternalContainerCleanupsForTest()).toBe(0);
      expect(releaseContainerSlot).toHaveBeenCalledOnce();
      expect(fs.existsSync(executionDirectory)).toBe(false);
    } finally {
      removeDirectory.mockRestore();
      cleanup();
    }
  });

  test('retries pre-container runtime cleanup without inventing a durable marker', async () => {
    const { executionDirectory, cleanup } = createManagedCleanupDirectory();
    const containerName = 'happyclaw-external-precreate-cleanup';
    const releaseContainerSlot = vi.fn();
    const clearCleanup = vi.mocked(
      clearExternalCapabilityRunContainerCleanupRequired,
    );
    const priorClearCalls = clearCleanup.mock.calls.length;
    quarantineExternalContainerCleanupForTest({
      runId: 'precreate-cleanup-run',
      containerName,
      executionDirectory,
      cleanupMarkerRequired: false,
      releaseContainerSlot,
    });

    try {
      await expect(
        reconcileExternalCapabilityContainersForTest({
          runDockerCommand: async (args) => {
            if (args.includes('{{.Names}}')) return { ok: true, stdout: '' };
            if (args[0] === 'container') return { ok: true, stdout: '' };
            return { ok: false, stdout: '' };
          },
          wait: async () => {},
          inspectContainerLabels: async () => null,
          fenceLease: () => 'stale',
        }),
      ).resolves.toMatchObject({ unverified: 0 });
      expect(clearCleanup).toHaveBeenCalledTimes(priorClearCalls);
      expect(releaseContainerSlot).toHaveBeenCalledOnce();
      expect(fs.existsSync(executionDirectory)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('keeps quarantined capacity fenced across an unverified pass', async () => {
    const releaseContainerSlot = vi.fn();
    const containerName = 'happyclaw-external-still-present-run-1-1';
    quarantineExternalContainerCleanupForTest({
      runId: 'still-present-run',
      containerName,
      releaseContainerSlot,
    });

    await expect(
      reconcileExternalCapabilityContainersForTest({
        runDockerCommand: async (args) => {
          if (args.includes('{{.Names}}')) {
            return { ok: true, stdout: `${containerName}\n` };
          }
          if (args[0] === 'stop' || args[0] === 'kill') {
            return { ok: true, stdout: '' };
          }
          if (args[0] === 'container') {
            return { ok: true, stdout: 'container-id\n' };
          }
          return { ok: false, stdout: '' };
        },
        wait: async () => {},
        inspectContainerLabels: async () =>
          ownedContainerLabels({
            'com.happyclaw.external': 'true',
            'com.happyclaw.external.protocol': '1',
            'com.happyclaw.external.run-id': 'still-present-run',
            'com.happyclaw.external.attempt': '1',
            'com.happyclaw.external.lease-token': '1',
          }),
        fenceLease: () => 'stale',
      }),
    ).rejects.toThrow(/Could not verify removal/);
    expect(releaseContainerSlot).not.toHaveBeenCalled();
    expect(countPendingExternalContainerCleanupsForTest()).toBe(1);

    await expect(
      reconcileExternalCapabilityContainersForTest({
        runDockerCommand: async (args) => {
          if (args.includes('{{.Names}}')) return { ok: true, stdout: '' };
          if (args[0] === 'container') return { ok: true, stdout: '' };
          return { ok: false, stdout: '' };
        },
        wait: async () => {},
        inspectContainerLabels: async () => null,
        fenceLease: () => 'stale',
      }),
    ).resolves.toEqual({
      discovered: 0,
      preserved: 0,
      stopped: 0,
      unverified: 0,
    });
    expect(releaseContainerSlot).toHaveBeenCalledOnce();
    expect(countPendingExternalContainerCleanupsForTest()).toBe(0);
  });

  test('discovers and removes labeled orphan containers', async () => {
    const commands: string[][] = [];
    const result = await reconcileExternalCapabilityContainersForTest({
      runDockerCommand: async (args) => {
        commands.push(args);
        if (args.includes('{{.Names}}')) {
          return {
            ok: true,
            stdout:
              'happyclaw-external-run-a-1-1\nhappyclaw-external-run-b-2-4\n',
          };
        }
        if (args[0] === 'stop') return { ok: true, stdout: '' };
        if (args[0] === 'container') return { ok: true, stdout: '' };
        return { ok: false, stdout: '' };
      },
      wait: async () => {},
      inspectContainerLabels: async () =>
        ownedContainerLabels({
          'com.happyclaw.external': 'true',
        }),
      fenceLease: () => 'stale',
    });

    expect(result).toEqual({
      discovered: 2,
      preserved: 0,
      stopped: 2,
      unverified: 0,
    });
    expect(commands[0]).toContain(`label=${HAPPYCLAW_MANAGED_LABEL}=true`);
    expect(commands[0]).toContain(
      `label=${HAPPYCLAW_INSTALLATION_LABEL}=${getInstallationId()}`,
    );
    expect(commands).toContainEqual([
      'stop',
      '--time',
      '10',
      'happyclaw-external-run-a-1-1',
    ]);
    expect(commands).toContainEqual([
      'stop',
      '--time',
      '10',
      'happyclaw-external-run-b-2-4',
    ]);
  });

  test('never claims an unowned legacy external lookalike', async () => {
    const runDockerCommand = vi.fn(async (args: string[]) => {
      if (args.includes('{{.Names}}')) {
        return {
          ok: true,
          stdout: 'happyclaw-external-legacy-run-3-9\n',
        };
      }
      return { ok: false, stdout: '' };
    });
    const fenceLease = vi.fn(() => 'active' as const);

    await expect(
      reconcileExternalCapabilityContainersForTest({
        runDockerCommand,
        wait: async () => {},
        inspectContainerLabels: async () => ({}),
        fenceLease,
        shouldAdoptActiveContainer: () => false,
      }),
    ).resolves.toEqual({
      discovered: 0,
      preserved: 0,
      stopped: 0,
      unverified: 0,
    });
    expect(fenceLease).not.toHaveBeenCalled();
    expect(runDockerCommand).toHaveBeenCalledTimes(1);
  });

  test('removes an earliest-generation container through external reconciliation', async () => {
    const runId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const containerName = `happyclaw-flow-main-external-${runId}-1712345678901`;
    const stopped: string[] = [];
    const fenceLease = vi.fn(() => 'active' as const);

    await expect(
      reconcileExternalCapabilityContainersForTest({
        runDockerCommand: async (args) => {
          if (args.includes('{{.Names}}')) {
            return { ok: true, stdout: `${containerName}\n` };
          }
          if (args[0] === 'stop') {
            stopped.push(args.at(-1)!);
            return { ok: true, stdout: '' };
          }
          if (args[0] === 'container') return { ok: true, stdout: '' };
          return { ok: false, stdout: '' };
        },
        wait: async () => {},
        inspectContainerLabels: async () => ownedContainerLabels({}),
        fenceLease,
      }),
    ).resolves.toEqual({
      discovered: 1,
      preserved: 0,
      stopped: 1,
      unverified: 0,
    });
    expect(stopped).toEqual([containerName]);
    expect(fenceLease).not.toHaveBeenCalled();
  });

  test('preserves a foreign container with a matching active durable lease', async () => {
    const runDockerCommand = vi.fn(async (args: string[]) => {
      if (args.includes('{{.Names}}')) {
        return {
          ok: true,
          stdout: 'happyclaw-external-foreign-run-2-7\n',
        };
      }
      return { ok: false, stdout: '' };
    });
    const fenceLease = vi.fn(() => 'active' as const);

    await expect(
      reconcileExternalCapabilityContainersForTest({
        runDockerCommand,
        wait: async () => {},
        inspectContainerLabels: async () =>
          ownedContainerLabels({
            'com.happyclaw.external': 'true',
            'com.happyclaw.external.protocol': '1',
            'com.happyclaw.external.run-id': 'foreign-run',
            'com.happyclaw.external.attempt': '2',
            'com.happyclaw.external.lease-token': '7',
          }),
        fenceLease,
      }),
    ).resolves.toEqual({
      discovered: 1,
      preserved: 1,
      stopped: 0,
      unverified: 0,
    });
    expect(fenceLease).toHaveBeenCalledWith({
      runId: 'foreign-run',
      attempt: 2,
      leaseToken: 7,
    });
    expect(runDockerCommand).toHaveBeenCalledTimes(1);
  });

  test('runs a fresh reconciliation after shutdown execution finalizers settle', async () => {
    const releaseContainerSlot = vi.fn();
    quarantineExternalContainerCleanupForTest({
      runId: 'late-cleanup-run',
      attempt: 3,
      leaseToken: 9,
      containerName: 'happyclaw-external-late-cleanup-run-3-9',
      releaseContainerSlot,
    });
    const finalReconciliation = vi.fn(() =>
      reconcileExternalCapabilityContainersForTest({
        runDockerCommand: async (args) => {
          if (args.includes('{{.Names}}')) return { ok: true, stdout: '' };
          if (args[0] === 'container') return { ok: true, stdout: '' };
          return { ok: false, stdout: '' };
        },
        wait: async () => {},
        inspectContainerLabels: async () => null,
        fenceLease: () => 'stale',
      }).then(() => undefined),
    );

    await expect(
      stopExternalCapabilityWorker(
        1_000,
        async () => true,
        finalReconciliation,
      ),
    ).resolves.toBeUndefined();

    expect(finalReconciliation).toHaveBeenCalledOnce();
    expect(releaseContainerSlot).toHaveBeenCalledOnce();
    expect(countPendingExternalContainerCleanupsForTest()).toBe(0);
  });

  test('accounts for a recovered foreign container without acquiring stop authority', async () => {
    const containerName = 'happyclaw-external-recovered-run-2-7';
    const releaseContainerSlot = vi.fn();
    const adoptContainerSlot = vi.fn(() => releaseContainerSlot);
    let listed = true;
    const dependencies = {
      runDockerCommand: async (args: string[]) => {
        if (args.includes('{{.Names}}')) {
          return { ok: true, stdout: listed ? `${containerName}\n` : '' };
        }
        if (args[0] === 'stop') {
          listed = false;
          return { ok: true, stdout: '' };
        }
        if (args[0] === 'container') return { ok: true, stdout: '' };
        return { ok: false, stdout: '' };
      },
      wait: async () => {},
      inspectContainerLabels: async () =>
        ownedContainerLabels({
          'com.happyclaw.external': 'true',
          'com.happyclaw.external.protocol': '1',
          'com.happyclaw.external.run-id': 'recovered-run',
          'com.happyclaw.external.attempt': '2',
          'com.happyclaw.external.lease-token': '7',
        }),
      fenceLease: () => 'active' as const,
      resolveWorkspaceJid: () => 'web:recovered-workspace',
      adoptContainerSlot,
    };

    await expect(
      reconcileExternalCapabilityContainersForTest(dependencies),
    ).resolves.toMatchObject({ discovered: 1, preserved: 1 });
    await expect(
      reconcileExternalCapabilityContainersForTest(dependencies),
    ).resolves.toMatchObject({ discovered: 1, preserved: 1 });

    expect(adoptContainerSlot).toHaveBeenCalledOnce();
    expect(adoptContainerSlot).toHaveBeenCalledWith('web:recovered-workspace');
    expect(countAdoptedExternalContainerSlotsForTest()).toBe(1);
    expect(releaseContainerSlot).not.toHaveBeenCalled();

    const stopExecution = vi.fn(async () => true);
    await expect(
      stopExternalCapabilityWorker(1_000, stopExecution),
    ).resolves.toBeUndefined();
    expect(stopExecution).not.toHaveBeenCalled();
    expect(releaseContainerSlot).toHaveBeenCalledOnce();
    expect(countAdoptedExternalContainerSlotsForTest()).toBe(0);
    listed = false;

    await expect(
      reconcileExternalCapabilityContainersForTest(dependencies),
    ).resolves.toEqual({
      discovered: 0,
      preserved: 0,
      stopped: 0,
      unverified: 0,
    });
    expect(releaseContainerSlot).toHaveBeenCalledOnce();
    expect(countAdoptedExternalContainerSlotsForTest()).toBe(0);
  });

  test('retries an adopted-slot finalizer after a transient database failure', async () => {
    const containerName = 'happyclaw-external-adopted-busy-run-2-7';
    const releaseContainerSlot = vi.fn();
    const adoptContainerSlot = vi.fn(() => releaseContainerSlot);
    let listed = true;
    const dependencies = {
      runDockerCommand: async (args: string[]) => {
        if (args.includes('{{.Names}}')) {
          return { ok: true, stdout: listed ? `${containerName}\n` : '' };
        }
        if (args[0] === 'container') return { ok: true, stdout: '' };
        return { ok: false, stdout: '' };
      },
      wait: async () => {},
      inspectContainerLabels: async () =>
        ownedContainerLabels({
          'com.happyclaw.external': 'true',
          'com.happyclaw.external.protocol': '1',
          'com.happyclaw.external.run-id': 'adopted-busy-run',
          'com.happyclaw.external.attempt': '2',
          'com.happyclaw.external.lease-token': '7',
        }),
      fenceLease: () => 'active' as const,
      resolveWorkspaceJid: () => 'web:adopted-busy-workspace',
      adoptContainerSlot,
    };

    await expect(
      reconcileExternalCapabilityContainersForTest(dependencies),
    ).resolves.toMatchObject({ discovered: 1, preserved: 1 });
    listed = false;
    vi.mocked(
      clearExternalCapabilityRunContainerCleanupRequired,
    ).mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY');
    });

    await expect(
      reconcileExternalCapabilityContainersForTest(dependencies),
    ).rejects.toThrow('SQLITE_BUSY');
    expect(countAdoptedExternalContainerSlotsForTest()).toBe(1);
    expect(releaseContainerSlot).not.toHaveBeenCalled();

    await expect(
      reconcileExternalCapabilityContainersForTest(dependencies),
    ).resolves.toMatchObject({ discovered: 0 });
    expect(countAdoptedExternalContainerSlotsForTest()).toBe(0);
    expect(releaseContainerSlot).toHaveBeenCalledOnce();
  });

  test('does not adopt a live foreign container after shutdown begins', async () => {
    const adoptContainerSlot = vi.fn(() => vi.fn());
    const result = await reconcileExternalCapabilityContainersForTest({
      runDockerCommand: async (args) => {
        if (args.includes('{{.Names}}')) {
          return {
            ok: true,
            stdout: 'happyclaw-external-foreign-run-1-1\n',
          };
        }
        return { ok: true, stdout: '' };
      },
      wait: async () => {},
      inspectContainerLabels: async () =>
        ownedContainerLabels({
          'com.happyclaw.external': 'true',
          'com.happyclaw.external.protocol': '1',
          'com.happyclaw.external.run-id': 'foreign-run',
          'com.happyclaw.external.attempt': '1',
          'com.happyclaw.external.lease-token': '1',
        }),
      fenceLease: () => 'active',
      resolveWorkspaceJid: () => 'web:foreign-workspace',
      adoptContainerSlot,
      shouldAdoptActiveContainer: () => false,
    });

    expect(result).toMatchObject({ discovered: 1, preserved: 1, stopped: 0 });
    expect(adoptContainerSlot).not.toHaveBeenCalled();
    expect(countAdoptedExternalContainerSlotsForTest()).toBe(0);
  });

  test('removes containers whose lease identity is malformed or inactive', async () => {
    const stopped: string[] = [];
    const labels = new Map<string, Record<string, string>>([
      [
        'happyclaw-external-malformed',
        {
          'com.happyclaw.external': 'true',
          'com.happyclaw.external.protocol': '1',
          'com.happyclaw.external.run-id': 'malformed-run',
          'com.happyclaw.external.attempt': 'not-a-number',
          'com.happyclaw.external.lease-token': '4',
        },
      ],
      [
        'happyclaw-external-expired',
        {
          'com.happyclaw.external': 'true',
          'com.happyclaw.external.protocol': '1',
          'com.happyclaw.external.run-id': 'expired-run',
          'com.happyclaw.external.attempt': '3',
          'com.happyclaw.external.lease-token': '9',
        },
      ],
    ]);
    const fenceLease = vi.fn(() => 'stale' as const);

    const result = await reconcileExternalCapabilityContainersForTest({
      runDockerCommand: async (args) => {
        if (args.includes('{{.Names}}')) {
          return { ok: true, stdout: [...labels.keys()].join('\n') };
        }
        if (args[0] === 'stop') {
          stopped.push(args.at(-1)!);
          return { ok: true, stdout: '' };
        }
        if (args[0] === 'container') return { ok: true, stdout: '' };
        return { ok: false, stdout: '' };
      },
      wait: async () => {},
      inspectContainerLabels: async (containerName) => {
        const containerLabels = labels.get(containerName);
        return containerLabels ? ownedContainerLabels(containerLabels) : null;
      },
      fenceLease,
    });

    expect(result).toEqual({
      discovered: 2,
      preserved: 0,
      stopped: 2,
      unverified: 0,
    });
    expect(stopped).toEqual([
      'happyclaw-external-malformed',
      'happyclaw-external-expired',
    ]);
    expect(fenceLease).toHaveBeenCalledOnce();
    expect(fenceLease).toHaveBeenCalledWith({
      runId: 'expired-run',
      attempt: 3,
      leaseToken: 9,
    });
  });

  test('ignores an unrelated container that vanishes between list and inspect', async () => {
    const runDockerCommand = vi.fn(async (args: string[]) => {
      if (args.includes('{{.Names}}')) {
        return { ok: true, stdout: 'happyclaw-agent-ephemeral\n' };
      }
      if (args.includes('--quiet')) return { ok: true, stdout: '' };
      return { ok: false, stdout: '' };
    });

    await expect(
      reconcileExternalCapabilityContainersForTest({
        runDockerCommand,
        wait: async () => {},
        inspectContainerLabels: async () => null,
        fenceLease: () => 'stale',
      }),
    ).resolves.toEqual({
      discovered: 0,
      preserved: 0,
      stopped: 0,
      unverified: 0,
    });
    expect(runDockerCommand).toHaveBeenCalledTimes(2);
  });

  test('fails reconciliation when Docker cannot inspect container labels', async () => {
    const runDockerCommand = vi.fn(async (args: string[]) => {
      if (args.includes('{{.Names}}')) {
        return { ok: true, stdout: 'happyclaw-external-uninspectable\n' };
      }
      return { ok: true, stdout: '' };
    });

    await expect(
      reconcileExternalCapabilityContainersForTest({
        runDockerCommand,
        wait: async () => {},
        inspectContainerLabels: async () => null,
        fenceLease: () => 'stale',
      }),
    ).rejects.toThrow(/Could not inspect/);
    expect(runDockerCommand).toHaveBeenCalledTimes(1);
  });

  test('fails reconciliation while orphan removal cannot be verified', async () => {
    await expect(
      reconcileExternalCapabilityContainersForTest({
        runDockerCommand: async (args) => {
          if (args.includes('{{.Names}}')) {
            return { ok: true, stdout: 'happyclaw-external-stuck\n' };
          }
          if (args[0] === 'stop' || args[0] === 'kill') {
            return { ok: true, stdout: '' };
          }
          if (args[0] === 'container') {
            return { ok: true, stdout: 'container-id\n' };
          }
          return { ok: false, stdout: '' };
        },
        wait: async () => {},
        inspectContainerLabels: async () =>
          ownedContainerLabels({
            'com.happyclaw.external': 'true',
          }),
        fenceLease: () => 'stale',
      }),
    ).rejects.toThrow(/Could not verify removal/);
  });

  test('shutdown drain stops active containers and waits for execution settlement', async () => {
    let settleExecution: (() => void) | null = null;
    const pendingExecution = new Promise<void>((resolve) => {
      settleExecution = resolve;
    });
    const stopExecution = vi.fn(async () => true);
    const drain = drainExternalCapabilityExecutions(
      [execution()],
      [pendingExecution],
      5_000,
      stopExecution,
    );

    let settled = false;
    void drain.then(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(stopExecution).toHaveBeenCalledOnce();
    });
    expect(settled).toBe(false);

    settleExecution!();
    await expect(drain).resolves.toEqual({
      unverifiedContainers: 0,
      timedOut: false,
    });
  });
});

describe('external capability input staging', () => {
  test('uses server-generated private file names and durable bytes', () => {
    const inputDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'external-capability-input-'),
    );
    const bytes = Buffer.from('verified source bytes');
    try {
      stageExternalCapabilityInputArtifact(
        inputDirectory,
        0,
        'image/png',
        bytes,
      );

      const stagedPath = path.join(inputDirectory, 'source-001.png');
      expect(fs.readdirSync(inputDirectory)).toEqual(['source-001.png']);
      expect(fs.readFileSync(stagedPath)).toEqual(bytes);
      expect(fs.statSync(stagedPath).mode & 0o777).toBe(0o444);
      expect(fs.statSync(inputDirectory).mode & 0o777).toBe(0o700);

      sealExternalCapabilityInputDirectory(inputDirectory);
      expect(fs.statSync(inputDirectory).mode & 0o777).toBe(0o755);
      expect(fs.statSync(stagedPath).mode & 0o777).toBe(0o444);
    } finally {
      fs.rmSync(inputDirectory, { recursive: true, force: true });
    }
  });

  test('rejects an unsupported staged content type before the container mounts it', () => {
    const inputDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'external-capability-input-'),
    );
    try {
      expect(() =>
        stageExternalCapabilityInputArtifact(
          inputDirectory,
          0,
          'application/pdf',
          Buffer.from('not allowed'),
        ),
      ).toThrow(/source material is invalid or unsupported/i);
      expect(fs.readdirSync(inputDirectory)).toEqual([]);
    } finally {
      fs.rmSync(inputDirectory, { recursive: true, force: true });
    }
  });
});
