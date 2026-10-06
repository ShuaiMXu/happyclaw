import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const scriptPath = path.join(repositoryRoot, 'scripts', 'cpa-quota-recover.sh');
const primaryContainerId = 'a'.repeat(64);
const shakaContainerId = 'b'.repeat(64);
const dockerInspectFormat =
  '{{.Id}}|{{range (index .NetworkSettings.Ports "8317/tcp")}}{{.HostIp}}:{{.HostPort}}{{end}}';
const dockerHostUri = 'unix:///var/run/docker.sock';
const dockerCommandPrefix = `docker --host ${dockerHostUri}`;
const productionPathDeclaration = "export PATH='/usr/bin:/bin'";
const dockerStubPreamble = `printf 'docker %s\\n' "$*" >> "$CPA_TEST_CALLS"
[ -z "\${DOCKER_HOST+x}" ] || exit 95
[ -z "\${DOCKER_CONTEXT+x}" ] || exit 95
[ -z "\${DOCKER_CONFIG+x}" ] || exit 95
[ -z "\${DOCKER_TLS_VERIFY+x}" ] || exit 95
[ -z "\${DOCKER_CERT_PATH+x}" ] || exit 95
[ -z "\${DOCKER_API_VERSION+x}" ] || exit 95
[ "$1" = "--host" ] || exit 96
[ "$2" = "${dockerHostUri}" ] || exit 96
shift 2`;
const forwardedEnvironmentKeys = [
  'ALL_PROXY',
  'BASH_ENV',
  'COOLDOWN_MARKER',
  'CPA_CONTAINER',
  'CPA_LOG_DIR',
  'CPA_URL',
  'CURL_HOME',
  'DOCKER_API_VERSION',
  'DOCKER_CERT_PATH',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_HOST',
  'DOCKER_TLS_VERIFY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'SHELLOPTS',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

type RunOptions = {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
};

type HealthyCommandOptions = {
  cooldownLine?: string;
  healthCodes?: string[];
  healthStatuses?: number[];
  restartStatus?: number;
};

let testRoot: string;
let binDirectory: string;
let callsPath: string;
let instrumentedScriptPath: string;

beforeEach(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-quota-recover-'));
  binDirectory = path.join(testRoot, 'bin');
  callsPath = path.join(testRoot, 'calls.log');
  instrumentedScriptPath = path.join(testRoot, 'cpa-quota-recover.sh');
  fs.mkdirSync(binDirectory, { recursive: true });

  const scriptSource = fs.readFileSync(scriptPath, 'utf8');
  const declarationParts = scriptSource.split(productionPathDeclaration);
  if (declarationParts.length !== 2) {
    throw new Error('Expected one fixed production PATH declaration');
  }
  const testPathDeclaration = `export PATH=${shellQuote(
    `${binDirectory}:/usr/bin:/bin`,
  )}`;
  fs.writeFileSync(
    instrumentedScriptPath,
    declarationParts.join(testPathDeclaration),
    { mode: 0o755 },
  );

  writeCommand(
    'docker',
    `printf 'docker %s\n' "$*" >> "$CPA_TEST_CALLS"
exit 97`,
  );
  writeCommand(
    'curl',
    `printf 'curl %s\n' "$*" >> "$CPA_TEST_CALLS"
exit 97`,
  );
});

afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function writeCommand(name: string, body: string): void {
  fs.writeFileSync(
    path.join(binDirectory, name),
    `#!/bin/sh\nset -eu\n${body}\n`,
    { mode: 0o755 },
  );
}

function runScript(
  args: string[],
  options: RunOptions = {},
): ReturnType<typeof spawnSync> {
  const requestedEnvironment = options.environment ?? {};
  const forwardedEnvironment = Object.fromEntries(
    forwardedEnvironmentKeys.flatMap((key) => {
      const value = requestedEnvironment[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );

  return spawnSync(instrumentedScriptPath, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: {
      HOME: testRoot,
      LANG: 'C',
      LC_ALL: 'C',
      PATH: `${binDirectory}:/usr/bin:/bin`,
      TMPDIR: testRoot,
      CPA_TEST_CALLS: callsPath,
      ...forwardedEnvironment,
    },
    encoding: 'utf8',
    timeout: 5_000,
  });
}

function runProductionScript(
  args: string[],
  environment: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(scriptPath, args, {
    cwd: repositoryRoot,
    env: {
      HOME: testRoot,
      LANG: 'C',
      LC_ALL: 'C',
      PATH: `${binDirectory}:/usr/bin:/bin`,
      TMPDIR: testRoot,
      CPA_TEST_CALLS: callsPath,
      ...environment,
    },
    encoding: 'utf8',
    timeout: 5_000,
  });
}

function expectExit(
  result: ReturnType<typeof spawnSync>,
  expectedStatus: number,
): void {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(expectedStatus);
}

function readCalls(): string {
  return fs.existsSync(callsPath) ? fs.readFileSync(callsPath, 'utf8') : '';
}

function matchingCalls(prefix: string): string[] {
  return readCalls()
    .split('\n')
    .filter((line) => line.startsWith(prefix));
}

function installHealthyCommands(options: HealthyCommandOptions = {}): void {
  const healthCodes = options.healthCodes ?? ['200'];
  const healthStatuses = options.healthStatuses ?? [];
  const lastHealthCode = healthCodes.at(-1) ?? '200';
  const lastHealthStatus = healthStatuses.at(-1) ?? 0;
  const healthCases = healthCodes
    .map(
      (code, index) =>
        `${index}) code=${shellQuote(code)}; status='${healthStatuses[index] ?? 0}' ;;`,
    )
    .join('\n');
  const dockerLogCommand = options.cooldownLine
    ? `printf '%s\\n' ${shellQuote(options.cooldownLine)}`
    : ':';
  const restartStatus = options.restartStatus ?? 0;

  writeCommand(
    'docker',
    `${dockerStubPreamble}
if [ "$1" = "info" ]; then
  [ "$#" -eq 1 ] || exit 96
  exit 0
fi
if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then
  [ "$#" -eq 5 ] || exit 96
  [ "$3" = "--format" ] || exit 96
  [ "$4" = ${shellQuote(dockerInspectFormat)} ] || exit 96
  case "$5" in
    cpa-server)
      printf '%s|172.17.0.1:8317\n' '${primaryContainerId}'
      exit 0
      ;;
    cpa-server-shaka)
      printf '%s|172.17.0.1:8318\n' '${shakaContainerId}'
      exit 0
      ;;
  esac
  exit 1
fi
if [ "$1" = "logs" ]; then
  [ "$#" -eq 5 ] || exit 96
  [ "$2" = "--since" ] || exit 96
  [ "$3" = "24h" ] || exit 96
  [ "$4" = "--" ] || exit 96
  case "$5" in
    '${primaryContainerId}'|'${shakaContainerId}') ;;
    *) exit 96 ;;
  esac
  ${dockerLogCommand}
  exit 0
fi
if [ "$1" = "restart" ]; then
  [ "$#" -eq 3 ] || exit 96
  [ "$2" = "--" ] || exit 96
  case "$3" in
    '${primaryContainerId}'|'${shakaContainerId}') ;;
    *) exit 96 ;;
  esac
  exit ${restartStatus}
fi
exit 99`,
  );
  writeCommand(
    'curl',
    `printf 'curl %s\n' "$*" >> "$CPA_TEST_CALLS"
[ "$#" -eq 15 ] || exit 96
[ "$1" = "--disable" ] || exit 96
[ "$2" = "--noproxy" ] || exit 96
[ "$3" = "*" ] || exit 96
[ "$4" = "--proto" ] || exit 96
[ "$5" = "=http" ] || exit 96
[ "$6" = "--silent" ] || exit 96
[ "$7" = "--show-error" ] || exit 96
[ "$8" = "--max-time" ] || exit 96
case "$9" in
  ''|*[!0-9]*) exit 96 ;;
esac
[ "\${10}" = "--output" ] || exit 96
[ "\${11}" = "/dev/null" ] || exit 96
[ "\${12}" = "--write-out" ] || exit 96
[ "\${13}" = "%{http_code}" ] || exit 96
[ "\${14}" = "--" ] || exit 96
case "\${15}" in
  'http://172.17.0.1:8317/'|'http://172.17.0.1:8318/') ;;
  *) exit 96 ;;
esac
state_path="$TMPDIR/curl-count"
call_index=0
if [ -f "$state_path" ]; then
  IFS= read -r call_index < "$state_path"
fi
printf '%s\n' "$((call_index + 1))" > "$state_path"
case "$call_index" in
${healthCases}
  *) code=${shellQuote(lastHealthCode)}; status='${lastHealthStatus}' ;;
esac
printf '%s' "$code"
exit "$status"`,
  );
}

function installClock(values: number[]): void {
  const lastValue = values.at(-1) ?? 0;
  const valueCases = values
    .map((value, index) => `${index}) value='${value}' ;;`)
    .join('\n');

  writeCommand(
    'date',
    `printf 'date %s\n' "$*" >> "$CPA_TEST_CALLS"
[ "$#" -eq 1 ] || exit 96
[ "$1" = "+%s" ] || exit 96
state_path="$TMPDIR/date-count"
call_index=0
if [ -f "$state_path" ]; then
  IFS= read -r call_index < "$state_path"
fi
printf '%s\n' "$((call_index + 1))" > "$state_path"
case "$call_index" in
${valueCases}
  *) value='${lastValue}' ;;
esac
printf '%s\n' "$value"`,
  );
}

function installSleep(): void {
  writeCommand(
    'sleep',
    `printf 'sleep %s\n' "$*" >> "$CPA_TEST_CALLS"
[ "$#" -eq 1 ] || exit 96
case "$1" in
  ''|*[!0-9]*) exit 96 ;;
esac`,
  );
}

describe('CPA quota recovery script', () => {
  test('--help exits successfully without requiring a profile', () => {
    const result = runScript(['--help']);

    expectExit(result, 0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('primary');
    expect(result.stdout).toContain('shaka');
    expect(result.stderr).toBe('');
    expect(readCalls()).toBe('');
  });

  test('pins the direct interpreter and command search path', () => {
    writeCommand(
      'bash',
      `printf 'fake bash invoked\n' >> "$CPA_TEST_CALLS"
exit 42`,
    );

    const helpResult = runProductionScript(['--help']);

    expectExit(helpResult, 0);
    expect(helpResult.stdout).toContain('Usage:');
    expect(readCalls()).toBe('');

    writeCommand(
      'realpath',
      `printf 'fake realpath invoked\n' >> "$CPA_TEST_CALLS"
exit 42`,
    );
    const missingDirectory = path.join(testRoot, 'missing-production-log-dir');
    const checkResult = runProductionScript(['primary', 'check'], {
      CPA_LOG_DIR: missingDirectory,
    });

    expectExit(checkResult, 1);
    expect(checkResult.stderr).toContain(
      `CPA_LOG_DIR is not a directory: ${missingDirectory}`,
    );
    expect(readCalls()).toBe('');
  });

  test('requires an explicit profile', () => {
    const result = runScript([]);

    expectExit(result, 1);
    expect(result.stderr).toContain('Usage:');
    expect(readCalls()).toBe('');
  });

  test.each([
    [
      'primary',
      'cpa-server',
      primaryContainerId,
      'http://172.17.0.1:8317/',
      'cpa-server-shaka',
    ],
    [
      'shaka',
      'cpa-server-shaka',
      shakaContainerId,
      'http://172.17.0.1:8318/',
      'cpa-server',
    ],
  ])(
    'check targets only the fixed %s profile mapping',
    (profile, container, containerId, url, otherContainer) => {
      installHealthyCommands();

      const result = runScript([profile, 'check']);

      expectExit(result, 0);
      expect(matchingCalls('docker ')).toEqual([
        `${dockerCommandPrefix} info`,
        `${dockerCommandPrefix} container inspect --format ${dockerInspectFormat} ${container}`,
        `${dockerCommandPrefix} logs --since 24h -- ${containerId}`,
      ]);
      expect(matchingCalls('curl ')).toEqual([
        `curl --disable --noproxy * --proto =http --silent --show-error --max-time 5 --output /dev/null --write-out %{http_code} -- ${url}`,
      ]);
      expect(
        matchingCalls('docker ').some((call) =>
          call.endsWith(` ${otherContainer}`),
        ),
      ).toBe(false);
      expect(matchingCalls(`${dockerCommandPrefix} restart `)).toEqual([]);
    },
  );

  test('check works without a host log directory', () => {
    installHealthyCommands();

    const result = runScript(['primary', 'check']);

    expectExit(result, 0);
    expect(result.stdout).toContain(
      'No quota-cooldown evidence was found in Docker logs from the last 24h or eligible response-log files.',
    );
  });

  test('does not inherit BASH_ENV into the child shell', () => {
    const bashEnvironmentPath = path.join(testRoot, 'bash-env');
    fs.writeFileSync(
      bashEnvironmentPath,
      'set -x\nexport CPA_LOG_DIR=/path/from/ambient/bash-env\n',
    );
    installHealthyCommands();

    const result = runScript(['primary', 'check'], {
      environment: {
        BASH_ENV: bashEnvironmentPath,
        SHELLOPTS: 'xtrace',
      },
    });

    expectExit(result, 0);
    expect(result.stderr).not.toContain('/path/from/ambient/bash-env');
  });

  test.each([
    ['primary', primaryContainerId, 'http://172.17.0.1:8317/'],
    ['shaka', shakaContainerId, 'http://172.17.0.1:8318/'],
  ])(
    'restart targets exactly one validated immutable ID for %s',
    (profile, containerId, url) => {
      installHealthyCommands();

      const result = runScript([profile, 'restart'], {
        environment: {
          ALL_PROXY: 'http://proxy.invalid:8080',
          COOLDOWN_MARKER: 'oauth_refresh_token',
          CPA_CONTAINER: 'unrelated-production-db',
          CPA_URL: 'http://127.0.0.1:9',
          CURL_HOME: path.join(testRoot, 'malicious-curl-home'),
          DOCKER_CONFIG: path.join(testRoot, 'malicious-docker-config'),
          DOCKER_CONTEXT: 'remote-production',
          DOCKER_HOST: 'tcp://remote.invalid:2375',
          HTTP_PROXY: 'http://proxy.invalid:8080',
          http_proxy: 'http://proxy.invalid:8080',
        },
      });
      const curlCalls = matchingCalls('curl ');

      expectExit(result, 0);
      expect(matchingCalls(`${dockerCommandPrefix} restart `)).toEqual([
        `${dockerCommandPrefix} restart -- ${containerId}`,
      ]);
      expect(curlCalls).toHaveLength(2);
      expect(curlCalls.every((call) => call.endsWith(`-- ${url}`))).toBe(true);
      expect(readCalls()).not.toContain('unrelated-production-db');
      expect(readCalls()).not.toContain('http://127.0.0.1:9');
    },
  );

  test('post-restart health polling retries and then recovers', () => {
    installHealthyCommands({ healthCodes: ['200', '503', '200'] });
    installClock([100, 100, 101, 103, 103]);
    installSleep();

    const result = runScript(['primary', 'restart']);

    expectExit(result, 0);
    expect(matchingCalls('curl ')).toHaveLength(3);
    expect(matchingCalls('sleep ')).toEqual(['sleep 2']);
    expect(result.stdout).toContain('healthy again (waited 3s)');
  });

  test('post-restart polling rejects HTTP 200 from a failed curl transfer', () => {
    installHealthyCommands({
      healthCodes: ['200', '200', '200'],
      healthStatuses: [0, 28, 0],
    });
    installClock([100, 100, 101, 103, 103]);
    installSleep();

    const result = runScript(['primary', 'restart']);

    expectExit(result, 0);
    expect(matchingCalls('curl ')).toHaveLength(3);
    expect(matchingCalls('sleep ')).toEqual(['sleep 2']);
    expect(result.stdout).toContain('healthy again (waited 3s)');
  });

  test('post-restart health polling fails when the deadline expires', () => {
    installHealthyCommands({ healthCodes: ['200', '503'] });
    installClock([100, 100, 160]);
    installSleep();

    const result = runScript(['primary', 'restart']);

    expectExit(result, 1);
    expect(result.stderr).toContain('did not become healthy within 60s');
    expect(matchingCalls('curl ')).toHaveLength(2);
    expect(matchingCalls('sleep ')).toEqual([]);
  });

  test('health probe and sleep are capped by the remaining deadline budget', () => {
    installHealthyCommands({ healthCodes: ['200', '503'] });
    installClock([100, 159, 159, 160]);
    installSleep();

    const result = runScript(['primary', 'restart']);
    const postRestartCurl = matchingCalls('curl ')[1];

    expectExit(result, 1);
    expect(postRestartCurl).toContain('--max-time 1');
    expect(matchingCalls('sleep ')).toEqual(['sleep 1']);
  });

  test('a Docker restart failure is reported', () => {
    installHealthyCommands({ restartStatus: 1 });

    const result = runScript(['primary', 'restart']);

    expectExit(result, 1);
    expect(result.stderr).toContain('Failed to restart CPA profile primary');
    expect(matchingCalls(`${dockerCommandPrefix} restart `)).toEqual([
      `${dockerCommandPrefix} restart -- ${primaryContainerId}`,
    ]);
    expect(matchingCalls('curl ')).toHaveLength(1);
  });

  test('rejects a container whose port binding does not match the profile', () => {
    writeCommand(
      'docker',
      `${dockerStubPreamble}
if [ "$1" = "info" ]; then
  exit 0
fi
if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then
  printf '%s|172.17.0.1:8317\n' '${shakaContainerId}'
  exit 0
fi
exit 99`,
    );

    const result = runScript(['shaka', 'restart']);

    expectExit(result, 1);
    expect(result.stderr).toContain(
      'CPA container port binding mismatch for profile shaka',
    );
    expect(readCalls()).not.toContain('curl ');
    expect(readCalls()).not.toContain(`${dockerCommandPrefix} restart`);
  });

  test.each(['check', 'restart'])(
    'missing shaka container fails before %s side effects',
    (action) => {
      writeCommand(
        'docker',
        `${dockerStubPreamble}
if [ "$1" = "info" ]; then
  exit 0
fi
if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then
  exit 1
fi
exit 99`,
      );

      const result = runScript(['shaka', action]);

      expectExit(result, 1);
      expect(result.stderr).toContain(
        'Unable to inspect required CPA container for profile shaka: cpa-server-shaka (missing or inaccessible)',
      );
      expect(readCalls()).toContain(`${dockerCommandPrefix} container inspect`);
      expect(readCalls()).not.toContain('curl ');
      expect(readCalls()).not.toContain('docker logs');
      expect(readCalls()).not.toContain(`${dockerCommandPrefix} restart`);
    },
  );

  test('Docker access failure is not reported as a missing container', () => {
    writeCommand(
      'docker',
      `${dockerStubPreamble}
if [ "$1" = "info" ]; then
  exit 1
fi
exit 99`,
    );

    const result = runScript(['primary', 'check']);

    expectExit(result, 1);
    expect(result.stderr).toContain(
      'Cannot access the local Docker daemon at unix:///var/run/docker.sock',
    );
    expect(result.stderr).not.toContain('container not found');
    expect(readCalls()).not.toContain(
      `${dockerCommandPrefix} container inspect`,
    );
  });

  test('an unhealthy endpoint refuses restart', () => {
    installHealthyCommands({ healthCodes: ['503'] });

    const result = runScript(['primary', 'restart']);

    expectExit(result, 1);
    expect(result.stderr).toContain('refusing to restart blindly');
    expect(readCalls()).not.toContain(`${dockerCommandPrefix} restart`);
  });

  test('HTTP 200 from a failed curl transfer refuses restart', () => {
    installHealthyCommands({ healthCodes: ['200'], healthStatuses: [28] });

    const result = runScript(['primary', 'restart']);

    expectExit(result, 1);
    expect(result.stderr).toContain('refusing to restart blindly');
    expect(matchingCalls(`${dockerCommandPrefix} restart `)).toEqual([]);
  });

  test('Docker-log evidence is detected without printing the matching line', () => {
    const secretLine =
      'oauth_refresh_token=review-secret are cooling down via provider codex';
    const bashEnvironmentPath = path.join(testRoot, 'bash-env');
    fs.writeFileSync(bashEnvironmentPath, 'set -x\n');
    installHealthyCommands({ cooldownLine: secretLine });

    const result = runScript(['primary', 'check'], {
      environment: {
        BASH_ENV: bashEnvironmentPath,
        SHELLOPTS: 'xtrace',
      },
    });

    expectExit(result, 0);
    expect(result.stdout).toContain(
      "Found quota-cooldown evidence in the selected profile's Docker logs.",
    );
    expect(result.stdout).not.toContain(secretLine);
    expect(result.stderr).not.toContain(secretLine);
    expect(result.stdout).not.toContain('review-secret');
    expect(result.stderr).not.toContain('review-secret');
  });

  test('check ignores an inherited cooldown marker override', () => {
    const attackerMarker = 'attacker-controlled-cooldown-marker';
    installHealthyCommands({ cooldownLine: attackerMarker });

    const result = runScript(['primary', 'check'], {
      environment: { COOLDOWN_MARKER: attackerMarker },
    });

    expectExit(result, 0);
    expect(result.stdout).toContain('No quota-cooldown evidence was found');
    expect(result.stdout).not.toContain('Found quota-cooldown evidence');
    expect(result.stdout).not.toContain(attackerMarker);
    expect(result.stderr).not.toContain(attackerMarker);
  });

  test('host-log evidence is detected without printing the matching line', () => {
    const logDirectory = path.join(testRoot, 'logs');
    const secretLine =
      'oauth_refresh_token=review-secret are cooling down via provider codex';
    fs.mkdirSync(logDirectory);
    fs.writeFileSync(
      path.join(logDirectory, 'responses.log'),
      `${secretLine}\n`,
    );
    installHealthyCommands();

    const result = runScript(['shaka', 'check'], {
      environment: { CPA_LOG_DIR: logDirectory },
    });

    expectExit(result, 0);
    expect(result.stdout).toContain(
      'Found quota-cooldown evidence in the explicitly configured host log directory (profile association not verified).',
    );
    expect(result.stdout).toContain(
      'Do not use host-log evidence alone to choose a profile to restart.',
    );
    expect(result.stdout).not.toContain("selected profile's Docker logs");
    expect(result.stdout).not.toContain(secretLine);
    expect(result.stderr).not.toContain(secretLine);
    expect(result.stdout).not.toContain('review-secret');
    expect(result.stderr).not.toContain('review-secret');
  });

  test('a dash-prefixed log directory cannot become a find expression', () => {
    const dashDirectory = path.join(testRoot, '-delete');
    const victimPath = path.join(testRoot, 'victim.txt');
    fs.mkdirSync(dashDirectory);
    fs.writeFileSync(path.join(dashDirectory, 'responses.log'), 'no match\n');
    fs.writeFileSync(victimPath, 'keep me\n');
    installHealthyCommands();

    const result = runScript(['primary', 'check'], {
      cwd: testRoot,
      environment: { CPA_LOG_DIR: '-delete' },
    });

    expectExit(result, 0);
    expect(fs.existsSync(victimPath)).toBe(true);
  });

  test('an explicitly configured missing log directory fails validation', () => {
    installHealthyCommands();
    const missingDirectory = path.join(testRoot, 'missing');

    const result = runScript(['primary', 'check'], {
      environment: { CPA_LOG_DIR: missingDirectory },
    });

    expectExit(result, 1);
    expect(result.stderr).toContain(
      `CPA_LOG_DIR is not a directory: ${missingDirectory}`,
    );
    expect(readCalls()).toBe('');
  });

  test('Docker log scanner failures are reported instead of becoming no evidence', () => {
    installHealthyCommands();
    writeCommand('awk', 'exit 2');

    const result = runScript(['primary', 'check']);

    expectExit(result, 1);
    expect(result.stderr).toContain(
      'Unable to scan Docker logs for profile primary',
    );
    expect(result.stdout).not.toContain('No quota-cooldown evidence');
  });

  test('Docker log failures are reported instead of becoming no evidence', () => {
    installHealthyCommands();
    writeCommand(
      'docker',
      `${dockerStubPreamble}
if [ "$1" = "info" ]; then
  exit 0
fi
if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then
  printf '%s|172.17.0.1:8317\n' '${primaryContainerId}'
  exit 0
fi
if [ "$1" = "logs" ]; then
  printf 'permission denied\n' >&2
  exit 1
fi
exit 99`,
    );

    const result = runScript(['primary', 'check']);

    expectExit(result, 1);
    expect(result.stderr).toContain(
      'Unable to read Docker logs for profile primary',
    );
    expect(result.stdout).not.toContain('No quota-cooldown evidence');
  });
});
