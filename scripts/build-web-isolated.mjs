import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = await mkdtemp(
  path.join(os.tmpdir(), 'happyclaw-web-build-'),
);
const outputDir = path.join(outputRoot, 'dist');
const npmCli = process.env.npm_execpath;
const command = npmCli
  ? process.execPath
  : process.platform === 'win32'
    ? 'npm.cmd'
    : 'npm';
const args = npmCli
  ? [
      npmCli,
      '--prefix',
      path.join(root, 'web'),
      'run',
      'build',
      '--',
      '--outDir',
      outputDir,
      '--emptyOutDir',
    ]
  : [
      '--prefix',
      path.join(root, 'web'),
      'run',
      'build',
      '--',
      '--outDir',
      outputDir,
      '--emptyOutDir',
    ];

try {
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`isolated Web build terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });

  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
} finally {
  await rm(outputRoot, { recursive: true, force: true });
}
