import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-docker-oauth-refresh-'),
);

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runtimeConfig = await import('../src/runtime-config.js');
const db = await import('../src/db.js');
const dockerOauth = await import('../src/docker-oauth-credentials.js');
const containerRunner = await import('../src/container-runner.js');

const original = {
  accessToken: 'docker-access-original',
  refreshToken: 'docker-refresh-original',
  expiresAt: 1_800_000_000_000,
  scopes: ['user:profile', 'user:inference'],
  subscriptionType: 'max',
};
const refreshed = {
  accessToken: 'docker-access-refreshed',
  refreshToken: 'docker-refresh-refreshed',
  expiresAt: 1_800_003_600_000,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
};

function writeCredentialFile(
  directory: string,
  claudeAiOauth: unknown,
): string {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, '.credentials.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ claudeAiOauth, mcpOAuth: { preserved: true } }),
  );
  return file;
}

beforeAll(() => {
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Docker SDK OAuth credential reconciliation', () => {
  test('persists a validated rotation with Provider CAS and fans it out', () => {
    const provider = runtimeConfig.createProvider({
      name: 'Docker refresh provider',
      type: 'official',
      enabled: true,
      claudeOAuthCredentials: original,
    });
    const currentSession = path.join(root, 'sessions', 'current', '.claude');
    const otherSession = path.join(root, 'sessions', 'other', '.claude');
    const foreignSession = path.join(root, 'sessions', 'foreign', '.claude');
    const credentialsFilePath = writeCredentialFile(currentSession, refreshed);
    writeCredentialFile(otherSession, original);
    const foreignCredentials = {
      accessToken: 'foreign-access',
      refreshToken: 'foreign-refresh',
      expiresAt: 1_900_000_000_000,
      scopes: ['user:inference'],
      subscriptionType: 'pro',
    };
    const foreignProvider = runtimeConfig.createProvider({
      name: 'Foreign Docker refresh provider',
      type: 'official',
      enabled: true,
      claudeOAuthCredentials: foreignCredentials,
    });
    writeCredentialFile(foreignSession, foreignCredentials);
    db.setSessionProviderId('current', null, provider.id);
    db.setSessionProviderId('other', null, provider.id);
    db.setSessionProviderId('foreign', null, foreignProvider.id);

    expect(
      containerRunner.reconcileDockerOAuthAfterExit(provider.id, {
        credentialsFilePath,
        launchCredentials: original,
      }),
    ).toBe('updated');
    expect(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)
        ?.claudeOAuthCredentials,
    ).toEqual({ ...refreshed, scopes: [...refreshed.scopes].sort() });
    expect(
      JSON.parse(
        fs.readFileSync(path.join(otherSession, '.credentials.json'), 'utf8'),
      ).claudeAiOauth,
    ).toEqual({ ...refreshed, scopes: [...refreshed.scopes].sort() });
    expect(
      JSON.parse(
        fs.readFileSync(path.join(foreignSession, '.credentials.json'), 'utf8'),
      ).claudeAiOauth,
    ).toEqual(foreignCredentials);
  });

  test('advances the launch snapshot so a warm runner can persist another rotation', () => {
    const provider = runtimeConfig.createProvider({
      name: 'Docker repeated refresh provider',
      type: 'official',
      enabled: true,
      claudeOAuthCredentials: original,
    });
    const credentialsFilePath = writeCredentialFile(
      path.join(root, 'sessions', 'repeated', '.claude'),
      refreshed,
    );
    const launch = { credentialsFilePath, launchCredentials: original };

    expect(
      containerRunner.reconcileDockerOAuthAfterExit(provider.id, launch),
    ).toBe('updated');
    expect(launch.launchCredentials).toEqual({
      ...refreshed,
      scopes: [...refreshed.scopes].sort(),
    });

    const refreshedAgain = {
      ...refreshed,
      accessToken: 'docker-access-refreshed-again',
      refreshToken: 'docker-refresh-refreshed-again',
      expiresAt: refreshed.expiresAt + 3_600_000,
    };
    writeCredentialFile(path.dirname(credentialsFilePath), refreshedAgain);
    expect(
      containerRunner.reconcileDockerOAuthAfterExit(provider.id, launch),
    ).toBe('updated');
    expect(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)
        ?.claudeOAuthCredentials,
    ).toEqual({
      ...refreshedAgain,
      scopes: [...refreshedAgain.scopes].sort(),
    });
  });

  test('advances a sibling warm runner from O to R before it persists R2', () => {
    const provider = runtimeConfig.createProvider({
      name: 'Docker sibling generation provider',
      type: 'official',
      enabled: true,
      claudeOAuthCredentials: original,
    });
    const sessionA = path.join(root, 'sessions', 'generation-a', '.claude');
    const sessionB = path.join(root, 'sessions', 'generation-b', '.claude');
    const fileA = writeCredentialFile(sessionA, refreshed);
    const fileB = writeCredentialFile(sessionB, original);
    db.setSessionProviderId('generation-a', null, provider.id);
    db.setSessionProviderId('generation-b', null, provider.id);
    const launchA = {
      credentialsFilePath: fileA,
      launchCredentials: original,
    };
    const launchB = {
      credentialsFilePath: fileB,
      launchCredentials: original,
    };

    expect(
      containerRunner.reconcileDockerOAuthAfterExit(provider.id, launchA),
    ).toBe('updated');
    expect(
      containerRunner.reconcileDockerOAuthAfterExit(provider.id, launchB),
    ).toBe('stale');
    expect(launchB.launchCredentials).toEqual({
      ...refreshed,
      scopes: [...refreshed.scopes].sort(),
    });

    const refreshedAgain = {
      ...refreshed,
      accessToken: 'sibling-r2-access',
      refreshToken: 'sibling-r2-refresh',
      expiresAt: refreshed.expiresAt + 3_600_000,
    };
    writeCredentialFile(sessionB, refreshedAgain);
    expect(
      containerRunner.reconcileDockerOAuthAfterExit(provider.id, launchB),
    ).toBe('updated');
    expect(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)
        ?.claudeOAuthCredentials,
    ).toEqual({
      ...refreshedAgain,
      scopes: [...refreshedAgain.scopes].sort(),
    });
  });

  test('does not overwrite an administrator credential update made mid-run', () => {
    const provider = runtimeConfig.createProvider({
      name: 'Docker refresh CAS provider',
      type: 'official',
      enabled: true,
      claudeOAuthCredentials: original,
    });
    const credentialsFilePath = writeCredentialFile(
      path.join(root, 'sessions', 'cas', '.claude'),
      refreshed,
    );
    const administratorUpdate = {
      accessToken: 'administrator-access',
      refreshToken: 'administrator-refresh',
      expiresAt: 1_900_000_000_000,
      scopes: ['user:inference'],
      subscriptionType: 'pro',
    };
    runtimeConfig.updateProviderSecrets(provider.id, {
      claudeOAuthCredentials: administratorUpdate,
    });

    expect(
      containerRunner.reconcileDockerOAuthAfterExit(provider.id, {
        credentialsFilePath,
        launchCredentials: original,
      }),
    ).toBe('stale');
    expect(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)
        ?.claudeOAuthCredentials,
    ).toEqual(administratorUpdate);
  });

  test('rejects malformed, incomplete, non-regular, and oversized files', () => {
    const directory = path.join(root, 'invalid-files');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, '.credentials.json');

    fs.writeFileSync(file, '{invalid');
    expect(dockerOauth.readDockerClaudeOAuthCredentials(file)).toBeNull();
    fs.writeFileSync(
      file,
      JSON.stringify({ claudeAiOauth: { ...original, scopes: [1] } }),
    );
    expect(dockerOauth.readDockerClaudeOAuthCredentials(file)).toBeNull();
    fs.writeFileSync(file, 'x'.repeat(64 * 1024 + 1));
    expect(dockerOauth.readDockerClaudeOAuthCredentials(file)).toBeNull();

    const target = writeCredentialFile(
      path.join(root, 'symlink-target'),
      refreshed,
    );
    const link = path.join(directory, 'linked-credentials.json');
    fs.symlinkSync(target, link);
    expect(dockerOauth.readDockerClaudeOAuthCredentials(link)).toBeNull();
    expect(
      dockerOauth.reconcileDockerOAuthCredentials({
        providerId: 'unused',
        credentialsFilePath: path.join(directory, 'missing.json'),
        launchCredentials: original,
      }),
    ).toBe('missing');
  });

  test('requires evidence of a later expiry before invoking the CAS', () => {
    const persist = vi.fn(() => true);
    const directory = path.join(root, 'freshness');
    const unchangedFile = writeCredentialFile(directory, {
      ...original,
      scopes: [...original.scopes].reverse(),
    });
    expect(
      dockerOauth.reconcileDockerOAuthCredentials({
        providerId: 'unused',
        credentialsFilePath: unchangedFile,
        launchCredentials: original,
        persistRefreshedCredentials: persist,
      }),
    ).toBe('unchanged');

    const notNewerFile = writeCredentialFile(directory, {
      ...refreshed,
      expiresAt: original.expiresAt,
    });
    expect(
      dockerOauth.reconcileDockerOAuthCredentials({
        providerId: 'unused',
        credentialsFilePath: notNewerFile,
        launchCredentials: original,
        persistRefreshedCredentials: persist,
      }),
    ).toBe('not_newer');
    expect(persist).not.toHaveBeenCalled();
  });

  test('runs reconciliation on Docker output and close without changing the Host path', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/container-runner.ts'),
      'utf8',
    );
    const dockerClose = source.indexOf("container.on('close'");
    const outputHandler = source.indexOf(
      'const handleOutput = async',
      source.indexOf('export async function runContainerAgent'),
    );
    const outputReconcile = source.indexOf(
      "reconcileDockerOAuth('output')",
      outputHandler,
    );
    const closeReconcile = source.indexOf(
      "reconcileDockerOAuth('exit')",
      dockerClose,
    );
    const closeHandling = source.indexOf(
      'const closeCtx: CloseHandlerContext',
      dockerClose,
    );
    const hostStart = source.indexOf('export async function runHostAgent');

    expect(dockerClose).toBeGreaterThanOrEqual(0);
    expect(outputReconcile).toBeGreaterThan(outputHandler);
    expect(outputReconcile).toBeLessThan(dockerClose);
    expect(closeReconcile).toBeGreaterThan(dockerClose);
    expect(closeReconcile).toBeLessThan(closeHandling);
    expect(source.slice(hostStart)).not.toContain(
      'reconcileDockerOAuthAfterExit(',
    );
  });

  test('contains reconciliation and fan-out failures after a completed run', () => {
    const launch = {
      credentialsFilePath: '/unused/.credentials.json',
      launchCredentials: original,
    };
    expect(
      containerRunner.reconcileDockerOAuthAfterExit('provider', launch, {
        reconcile: () => {
          throw new Error('read or CAS failure');
        },
      }),
    ).toBe('error');
    expect(
      containerRunner.reconcileDockerOAuthAfterExit('provider', launch, {
        reconcile: () => 'updated',
        fanOutUpdatedCredentials: () => {
          throw new Error('fan-out failure');
        },
      }),
    ).toBe('error');
  });
});
