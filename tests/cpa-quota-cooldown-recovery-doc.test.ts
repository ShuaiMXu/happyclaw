import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const read = (file: string) =>
  fs.readFileSync(path.join(repositoryRoot, file), 'utf8');

describe('CPA quota cooldown recovery runbook', () => {
  test('documents host response-log scanning as optional', () => {
    const runbook = read('docs/cpa-quota-cooldown-recovery.md');

    expect(runbook).toContain('默认只读取所选容器的 Docker 日志');
    expect(runbook).toContain('`CPA_LOG_DIR` 是可选的宿主机响应错误日志目录');
    expect(runbook).toContain('显式配置但目录不存在时，脚本会拒绝继续');
    expect(runbook).toContain('仅当对应容器已经部署时');
    expect(runbook).toContain('文件修改时间在最近 24 小时内');
    expect(runbook).toContain('会搜索这些文件的全部内容');
    expect(runbook).toContain('不会验证该目录属于所选 profile');
    expect(runbook).toContain('不能单独用于选择要重启的 profile');
  });

  test('documents trusted command and local service targeting', () => {
    const runbook = read('docs/cpa-quota-cooldown-recovery.md');

    expect(runbook).toContain('固定使用 `/usr/bin/bash`');
    expect(runbook).toContain('固定为 `/usr/bin:/bin`');
    expect(runbook).toContain('不会使用\n继承 `PATH` 中的同名命令');
    expect(runbook).toContain('`unix:///var/run/docker.sock`');
    expect(runbook).toContain('不接受继承的 Docker host/context');
    expect(runbook).toContain('禁用 curl 配置并绕过代理');
  });

  test('documents deployment isolation as a requirement, not a script guarantee', () => {
    const runbook = read('docs/cpa-quota-cooldown-recovery.md');

    expect(runbook).toContain('部署时必须确保');
    expect(runbook).toContain('脚本不会验证容器挂载或凭据文件是否共享');
    expect(runbook).not.toContain(
      '两套实例同时存在时，其配置、OAuth 凭据和内存冷却状态互相独立',
    );
  });

  test('documents the restart wait as a wall-clock budget', () => {
    const runbook = read('docs/cpa-quota-cooldown-recovery.md');

    expect(runbook).toContain('60 秒墙钟时间预算');
  });

  test('separates local CPA API-key failures from upstream Codex OAuth failures', () => {
    const runbook = read('docs/cpa-quota-cooldown-recovery.md');

    expect(runbook).toContain('`Missing API key` 或 `Invalid API key`');
    expect(runbook).toContain('HappyClaw Provider 中配置的 CPA 网关密钥');
    expect(runbook).toContain('CPA 配置中的 `api-keys`');
    expect(runbook).toContain('不是重新进行 Codex OAuth 登录');
    expect(runbook).toContain('上游 Codex OAuth 凭据');
    expect(runbook).toContain('CPA 容器日志');
    expect(runbook).not.toContain(
      '401（例如 `Invalid API key` 或 `Missing API key`）才应通过',
    );
  });
});
