# HappyClaw Mac mini 生产部署

本仓库的生产实例运行在用户的 Mac mini 上。代码目录为
`/Users/riba2534/airepo/happyclaw`，服务由用户级 launchd 单元
`com.riba2534.happyclaw` 管理，监听 `*:3000`。部署只能更新 Git 跟踪的代码、构建产物和
Agent 镜像；`data/`、本机环境变量、Keychain、渠道凭据及 launchd 配置必须原样保留。

## 1. 连接与前置条件

在部署机的私有 SSH 配置中维护 `macmini` 别名。主机地址、端口和密钥属于运维配置，
不得提交到仓库。下面的命令都假定 `ssh macmini` 已能免交互登录。

部署前必须满足：

- 目标提交已经推送到远程分支，且本地测试、类型检查和生产构建通过。
- 若 `container/` 或 Agent Runner 发生变化：已合入 `main` 时等待 `latest` 发布；部署尚未
  合入的远程分支时，用 GitHub Actions 的 `workflow_dispatch` 在该精确 ref 上构建，并使用
  `riba2534/happyclaw-agent:git-<完整提交 SHA>`。分支构建只发布不可变提交标签，不得推进
  公共 `latest`；Mac mini 不做本地镜像构建。
- 明确记录本次远程分支名和预期提交 SHA，不使用浮动的本地工作树作为部署来源。
- Mac mini 的安全 IPC 结果发布依赖 `/usr/bin/python3` 的原生目录相对系统调用。
  在切换前检查 `open`、`rename` 和 `unlink` 均支持 `dir_fd`；能力缺失时不得降级为
  路径写入或继续部署。

连接并设置本次部署参数：

```bash
ssh macmini
cd /Users/riba2534/airepo/happyclaw
export HAPPYCLAW_DEPLOY_REF='codex/replace-with-remote-branch'
export HAPPYCLAW_EXPECTED_SHA='replace-with-full-commit-sha'
export HAPPYCLAW_PUBLIC_URL_PRIMARY='https://claw.riba2534.cn'
export HAPPYCLAW_PUBLIC_URL_SECONDARY='https://claw.home.riba2534.cn:23333'
export HAPPYCLAW_AGENT_IMAGE='riba2534/happyclaw-agent:latest'
# 分支不可变镜像会自动派生同 SHA 的 `-headroom` 能力标签；只有实际配置
# headroom MCP 时 Docker 才按需拉取它。
```

## 2. 只读预检与目标校验

远程工作树不干净时立即停止，不要 stash、覆盖或删除未知文件：

```bash
test -z "$(git status --porcelain)" || {
  git status --short
  echo 'Remote worktree is not clean; deployment stopped.' >&2
  exit 1
}

/usr/bin/python3 -I -S -c 'import os; assert all(f in os.supports_dir_fd for f in (os.open, os.rename, os.unlink)), "Secure IPC dir_fd support unavailable"'

export HAPPYCLAW_PREVIOUS_SHA="$(git rev-parse HEAD)"
printf 'Rollback commit: %s\n' "$HAPPYCLAW_PREVIOUS_SHA"
git fetch --prune origin \
  "refs/heads/${HAPPYCLAW_DEPLOY_REF}:refs/remotes/origin/${HAPPYCLAW_DEPLOY_REF}"
test "$(git rev-parse "origin/$HAPPYCLAW_DEPLOY_REF")" = "$HAPPYCLAW_EXPECTED_SHA"
```

禁止运行 `make reset-init`、`git clean`、`git reset --hard`，也不要用带 `--delete` 的
rsync 同步生产目录。所有者已明确选择不保留部署备份，因此不得运行 `make backup`，也不得
创建 SQLite 快照、完整运行时归档或 `.env` 副本。部署时必须显式设置
`HAPPYCLAW_SKIP_MIGRATION_BACKUP=1`，这只跳过 schema 升级前的 `VACUUM INTO` 快照，不会
绕过迁移事务、前向升级或拒绝降级检查。该选择意味着数据库迁移后没有数据级回滚路径；若
迁移失败或新代码不兼容，只能保持服务停止并通过前向修复恢复。

### 2.1 外调能力额外发布门槛

代码中存在外调能力路由不等于允许生产启用。除非发布负责人另行完成并记录真实 Docker
隔离哨兵、Provider/Container 演练、跨进程生命周期围栏、容量与成本压力测试、清理和升级
恢复演练、监控告警、事故 Runbook、调用方秘密管理与灰度审批，否则生产环境必须保持
`EXTERNAL_CAPABILITY_RELEASE_ENABLED=false`，`quote-document-process` 必须保持
`draft` 或 `paused`，且不得创建或发放生产 `ec_...` Key。普通 HappyClaw 部署验证不得
顺带打开该闸门，也不得把真实 Provider 调用当作默认 smoke test。

独立发布时还必须校验：Vault 位于项目根目录外；Runner 使用 digest-pinned 镜像且协议
OCI label 匹配；专用 Docker 网络是带受控出口标签的 internal local bridge；全局、能力和
Key 级 intake/queue/concurrency/Provider-cost 配额均已显式评审；
`EXTERNAL_CAPABILITY_VAULT_ID` 必须与目标卷根目录中预置、仅所有者可读的
`.happyclaw-external-vault-id` 身份哨兵精确一致；`EXTERNAL_CAPABILITY_VAULT_MAX_BYTES` 与
`EXTERNAL_CAPABILITY_VAULT_MIN_FREE_BYTES` 已按目标卷容量、备份/日志共用空间和告警阈值显式评审；终态文件清理、孤儿目录清理、耐久字节账本
释放及失败后的短间隔重试已在目标文件系统验证。释放顺序必须是先确认物理对象删除或不存在，
再释放账本占用；不能通过清零预留来掩盖删除失败。首次使用某个 Vault 身份时，服务会先取得
按 Vault 物理路径命名的跨进程独占锁并发布 owner-fenced 维护标记；intake、执行、保留期清理、
普通容器 reconciliation 和激活写探针必须在完整文件系统及账本 finalizer 周期内持有共享锁。
锁 owner 由 PID 与随机 token 共同标识，只有确认 PID 已不存在时才能回收遗留 owner；PID 重用、
锁目录/owner 文件畸形、权限或属主异常一律 fail closed。预期 Vault ID 变化不能形成另一套锁并绕过
同一物理路径上的活动 producer。独占锁内会停止陈旧外部容器并拒绝保留任何仍存活或状态未知的
外部容器，然后在 Web 发布前通过目录描述符固定目标卷，严格盘点 `runs/` 与 `runtime/`，将逐对象
占用和 v2 完成标记原子写入账本；最终卷身份复验失败时必须把完成标记恢复为本 owner 的 blocked
标记后才能释放独占锁。旧 v1 路径标记、缺失或替换的卷、未知名称、符号/硬链接、特殊文件、
权限/属主异常、算术溢出或账本冲突都会阻止启动，不能手工跳过该盘点。外部容器的 rootfs 只读，
`HOME`、`/workspace` 与 `/tmp` 必须使用带明确 size 的 tmpfs；Vault 对容器只允许只读输入和只读
授权目录，禁止任何容器可写 Vault 挂载。Runner 通过 stdout 报告 START 已消费，宿主先持久化
固定大小的 ACK，再发布只读确认文件，确认可见后 Runner 才能进入 `query()`。能力定义不存在尚未
完成迁移的耐久目标漂移。READY/START 演练必须覆盖截止时间前的发布余量，不能把“宿主已写
START”当作 Provider 一定未执行或一定已执行的证明。

专用网络还必须显式设置 Docker bridge gateway mode：

```text
com.docker.network.bridge.gateway_mode_ipv4=isolated
```

若网络启用了 IPv6，还必须同时设置：

```text
com.docker.network.bridge.gateway_mode_ipv6=isolated
```

该 internal 网络内必须运行经审核的代理服务，Runner 只能通过 `HTTPS_PROXY` / `HTTP_PROXY`
访问允许的 Provider 目标。直接连接公网 Provider、绕过代理的路由，以及 Provider 或代理使用
IP literal 的配置都会被有意拒绝；不要通过放宽 DNS 名称校验、关闭 internal 网络或添加宿主机
路由来规避 readiness 失败。发布前应从能力容器内分别验证：允许的 Provider 请求经过代理成功，
宿主机、云元数据、私网横向地址和其他公网目标全部失败。

预认证入口还必须根据压测和调用方规模显式评审以下固定窗口限流变量，而不是依赖默认值：

```text
EXTERNAL_CAPABILITY_UNAUTH_REQUESTS_PER_MINUTE
EXTERNAL_CAPABILITY_UNAUTH_PER_CLIENT_REQUESTS_PER_MINUTE
```

具体变量和默认值以 `src/external-capability-*.ts`、
`src/routes/external-capability-invoke.ts` 和控制面 readiness 响应为准，不在部署文档复制第二套
配置真相源。

## 3. 构建与切换

不得在在线目录中执行 `npm ci` 或重建 `web/dist`。先在同机独立 worktree 验证精确提交；
只有全部门槛通过后，才进入明确的维护窗口。这样旧服务不会读取一半更新的依赖、静态资源、
Runner 或 builtin Skills。

```bash
export HAPPYCLAW_RELEASE_ROOT="${HOME}/happyclaw-releases"
export HAPPYCLAW_RELEASE_DIR="${HAPPYCLAW_RELEASE_ROOT}/${HAPPYCLAW_EXPECTED_SHA}"
mkdir -p "$HAPPYCLAW_RELEASE_ROOT"
git worktree add --detach "$HAPPYCLAW_RELEASE_DIR" "$HAPPYCLAW_EXPECTED_SHA"
cd "$HAPPYCLAW_RELEASE_DIR"

NPM_CONFIG_ENGINE_STRICT=true NPM_CONFIG_REGISTRY=https://registry.npmjs.org \
  /bin/zsh -lic 'make install'
/bin/zsh -lic 'npm run docs:check'
/bin/zsh -lic './scripts/check-stream-event-sync.sh'
/bin/zsh -lic 'make typecheck'
/bin/zsh -lic 'npm run audit:prod'
/bin/zsh -lic 'npm test -- --run'
/bin/zsh -lic 'npm run build:all:check'
/bin/zsh -lic 'npm run self-test:agent-runner'
git diff --check
/bin/zsh -lic "docker pull '$HAPPYCLAW_AGENT_IMAGE'"
```

`HAPPYCLAW_AGENT_IMAGE` 必须使用已记录的 manifest digest（`name@sha256:...`），不能把
`latest` 当作实际部署输入。记录 core 与 headroom digest、应用完整 SHA、当前 schema 版本和
外调协议 OCI label；回滚时这四项必须作为同一个发布单元恢复。

验证完成后进入维护窗口，先停止 launchd 单元，再更新在线目录。停止后才能物化
`data/builtin-skills`；`make install` 已不再在旧服务在线时改写该目录。

```bash
export HAPPYCLAW_APP_DIR='/Users/riba2534/airepo/happyclaw'
export HAPPYCLAW_LAUNCHD_PLIST="$HOME/Library/LaunchAgents/com.riba2534.happyclaw.plist"
launchctl bootout "gui/$(id -u)" "$HAPPYCLAW_LAUNCHD_PLIST"

cd "$HAPPYCLAW_APP_DIR"
git switch --detach "$HAPPYCLAW_EXPECTED_SHA"
test "$(git rev-parse HEAD)" = "$HAPPYCLAW_EXPECTED_SHA"

# 服务已停止；此时重建依赖、产物和版本化 builtin Skills 不会形成混合版本。
NPM_CONFIG_ENGINE_STRICT=true NPM_CONFIG_REGISTRY=https://registry.npmjs.org \
  /bin/zsh -lic 'make install'
/bin/zsh -lic 'npm run build:all'
/bin/zsh -lic 'make _ensure-builtin-skills'
```

若本次使用不可变镜像，只原地更新现有 `.env` 中的 `CONTAINER_IMAGE`；不得覆盖其他环境变量
或把 `.env` 提交到 Git。按所有者的无备份策略，生产配置必须固定
`HAPPYCLAW_SKIP_MIGRATION_BACKUP=1`：

```bash
if grep -q '^HAPPYCLAW_SKIP_MIGRATION_BACKUP=' .env 2>/dev/null; then
  sed -i '' 's/^HAPPYCLAW_SKIP_MIGRATION_BACKUP=.*$/HAPPYCLAW_SKIP_MIGRATION_BACKUP=1/' .env
else
  printf '\nHAPPYCLAW_SKIP_MIGRATION_BACKUP=1\n' >> .env
fi
if grep -q '^CONTAINER_IMAGE=' .env 2>/dev/null; then
  sed -i '' "s|^CONTAINER_IMAGE=.*$|CONTAINER_IMAGE=$HAPPYCLAW_AGENT_IMAGE|" .env
else
  printf '\nCONTAINER_IMAGE=%s\n' "$HAPPYCLAW_AGENT_IMAGE" >> .env
fi
chmod 600 .env
```

任一安装或构建步骤失败时保持服务停止，修复后重新从只读预检开始；不得在半成品目录上启动。
切换成功并完成生产验证后，使用 `git worktree remove "$HAPPYCLAW_RELEASE_DIR"` 清理候选 worktree。

## 4. 重启与生产验证

```bash
launchctl kickstart -k "gui/$(id -u)/com.riba2534.happyclaw"

for attempt in {1..30}; do
  if curl -fsS http://127.0.0.1:3000/api/health; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo 'HappyClaw did not become healthy.' >&2
    exit 1
  fi
  sleep 2
done

launchctl print "gui/$(id -u)/com.riba2534.happyclaw" | head -40
lsof -nP -iTCP:3000 -sTCP:LISTEN
curl -fsS http://127.0.0.1:3000/api/config/appearance/public
test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/auth/me)" = 401
curl -fsS "$HAPPYCLAW_PUBLIC_URL_PRIMARY/api/health"
curl -fsS "$HAPPYCLAW_PUBLIC_URL_SECONDARY/api/health"
tail -100 "$HOME/Library/Logs/happyclaw/happyclaw.log"
```

随后从真实公网入口完成与改动相关的真实测试，并分别记录结果：

1. 未登录打开登录页，确认自定义站点名称、图形 Logo 和浏览器标题生效。
2. 注册或登录后确认同一品牌立即进入侧边栏，无需刷新页面。
3. 管理员分别修改站点名称、图形 Logo 和文字 Logo，确认保存中控件禁用，最终页面与
   `/api/config/appearance/public` 一致。
4. 展开负载均衡设置，用键盘访问策略和数字字段；数字只在失焦或 Enter 后保存，快速操作
   不得回滚为旧值。
5. 发起一个真实 Web Agent 回合；若本次涉及渠道或容器，再完成对应 IM 收发和 Container
   Agent 回合，确认流式输出、文件访问及最终回执正常。
6. 检查两个生产公网入口的 `/api/health`、TLS 和静态资源加载均成功。

本地通过不等于部署完成；以上生产检查未通过时不得报告完成。

## 5. 回滚

应用代码或构建产物异常、且数据库仍兼容旧代码时，回到第 2 节记录的提交：

```bash
git switch --detach "$HAPPYCLAW_PREVIOUS_SHA"
/bin/zsh -lic 'make install'
/bin/zsh -lic 'npm run build:all'
launchctl kickstart -k "gui/$(id -u)/com.riba2534.happyclaw"
curl -fsS http://127.0.0.1:3000/api/health
```

所有者选择不保留数据备份，因此数据库迁移后不存在数据恢复路径。若迁移导致旧代码
不兼容，应停止继续切换并以前向修复恢复服务，不得自行创建或恢复备份。回滚后重复第 4
节的健康检查与真实功能测试，并明确报告仅发生了代码回滚。
