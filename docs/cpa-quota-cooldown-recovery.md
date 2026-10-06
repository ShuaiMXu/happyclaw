# CPA 配额冷却误拦：现象、根因与恢复

该脚本支持 HappyClaw 主机上的两套 CLIProxyAPI（CPA）profile。必须先选择要恢复的
账号实例，避免因默认目标不明确而重启另一账号的网关：

| Profile   | Docker 容器        | 地址                     | 预期宿主机端口绑定 | 用途                             |
| --------- | ------------------ | ------------------------ | ------------------ | -------------------------------- |
| `primary` | `cpa-server`       | `http://172.17.0.1:8317` | `172.17.0.1:8317`  | 主账号 CPA                       |
| `shaka`   | `cpa-server-shaka` | `http://172.17.0.1:8318` | `172.17.0.1:8318`  | HappyClaw Provider `codex-shaka` |

仅当对应容器已经部署时，该 profile 才可使用；脚本不会创建容器、配置或 OAuth 凭据。
两套实例同时存在时，部署时必须确保它们使用不同的配置和 OAuth 凭据挂载。脚本会校验
固定容器名和预期端口绑定，但脚本不会验证容器挂载或凭据文件是否共享。每个 CPA 进程的
内存冷却状态彼此分离。

本文只处理**上游 Codex 额度已恢复后，CPA 仍在本地拦截请求**的问题；它不重置上游额度。

## 现象

- HappyClaw 侧 GPT 模型报「模型服务额度已用尽或暂时不可用」。
- 目标 CPA 的响应错误日志或容器日志出现大量耗时仅几毫秒的 429，例如：

  ```text
  All credentials for model gpt-5.6-sol are cooling down via provider codex
  ```

  某些 CPA 版本的容器日志还会记录 `reason=quota` 和剩余冷却时间。

- 直接请求目标 CPA 返回：

  ```json
  {"error":{"type":"rate_limit_error","message":"All credentials for model
  gpt-5.6-sol are cooling down via provider codex (last error:
  usage_limit_reached: The usage limit has been reached)"}}
  ```

## 根因与边界

CPA 对上游 `usage_limit_reached` 会在**进程内存**里维护冷却计时器。冷却期内，
请求会直接由 CPA 返回 429，而不会发送到上游。因此：

- 上游额度确实用完：等待额度窗口恢复；重启不能增加额度。
- 已确认上游额度已恢复、但 CPA 仍命中旧冷却：重启**对应实例**可以清除内存冷却，
  让下一条请求重新到达上游。
- 请求恢复后又收到新的 `usage_limit_reached`：说明上游额度尚未恢复，或仍受其他
  上游限制；不要反复重启。

还需要区分两个独立的鉴权边界：

- CPA 返回 `Missing API key` 或 `Invalid API key`：这是 HappyClaw 到 CPA 的本地网关
  鉴权失败。应核对 HappyClaw Provider 中配置的 CPA 网关密钥与
  CPA 配置中的 `api-keys`，修复方式不是重新进行 Codex OAuth 登录。
- CPA 容器日志明确显示上游 Codex OAuth 凭据被撤销、刷新失败或登录失效：这才是
  上游 Codex OAuth 凭据问题，应只对所选 profile 重新进行设备码/OAuth 登录。

重新 OAuth 登录不会重置额度，也不会清除另一个 CPA 进程的冷却。

## 恢复步骤

先查看可用参数：

```bash
scripts/cpa-quota-recover.sh --help
```

再只读确认目标实例和冷却证据：

```bash
# Provider codex-shaka（端口 8318；仅在该容器已部署时使用）
scripts/cpa-quota-recover.sh shaka check

# 主账号 CPA（端口 8317）
scripts/cpa-quota-recover.sh primary check
```

脚本固定使用 `/usr/bin/bash` 执行，并将外部命令搜索路径固定为 `/usr/bin:/bin`，不会使用
继承 `PATH` 中的同名命令；非标准命令安装路径需要先审查并同步修改脚本和测试，不能通过环境覆盖。
脚本只通过本机 `unix:///var/run/docker.sock` 访问 Docker，不接受继承的 Docker host/context，
随后检查固定容器名及其预期端口绑定。容器缺失或不可访问、Docker daemon 不可访问、端口
绑定不匹配时，都会在发送健康检查或执行重启前失败。通过校验后，脚本保留该容器的不可变
ID；后续读取日志或重启均使用该 ID，而不是再次解析容器名。HTTP 健康检查会禁用 curl 配置并绕过代理，直接访问表中的固定网桥地址，避免 Docker 目标与健康检查目标来自不同主机。

只有在已确认该账号的上游额度已经恢复，并确认该实例当前没有进行中的 GPT
会话流量时，才重启**同一 profile**：

```bash
scripts/cpa-quota-recover.sh shaka restart
# 或
scripts/cpa-quota-recover.sh primary restart
```

`restart` 会先验证目标实例健康，再对已校验的容器 ID 执行 `docker restart`。重启后的
健康检查共享 60 秒墙钟时间预算；每次请求的超时时间和轮询间隔都会受剩余预算限制。
它不会更改磁盘上的配置或 OAuth 凭据，但会中断该实例正在处理的请求。恢复后发送一条
真实模型请求验证：预期是正常响应；如果仍为新的 `usage_limit_reached`，不要继续重启，
应等待或确认上游额度状态。

脚本不提供隐式默认 profile；需要显式传入 `primary` 或 `shaka`。容器名、地址、端口绑定
和冷却标记均来自脚本内固定的 profile 映射，不能通过继承的环境变量改写。非标准部署需要
先审查并同步修改脚本映射、文档和测试，不能临时覆盖目标，以防错重启其他容器。

默认只读取所选容器的 Docker 日志，并检查最近 24 小时的输出中是否存在固定冷却标记。
`CPA_LOG_DIR` 是可选的宿主机响应错误日志目录；只有显式设置时才会扫描。脚本会先将其
规范化为绝对路径，显式配置但目录不存在时，脚本会拒绝继续。宿主机扫描仅检查目录顶层、
文件修改时间在最近 24 小时内且不是符号链接的 `*.log` 文件，并会搜索这些文件的全部内容；
因此匹配行本身的时间可能早于 24 小时。脚本不会验证该目录属于所选 profile，命中时会将
结果明确标记为“profile 关联未验证”；这类证据不能单独用于选择要重启的 profile。

Docker 日志与宿主机日志匹配都只能作为历史证据，不能单独证明当前仍处于冷却状态。为避免
日志中的 token、账号信息或终端控制字符泄露，脚本流式检查内容，只报告是否找到证据，
不会缓存或打印原始匹配行。

## 预防

- 单账号额度耗尽会造成空窗。为目标 CPA 配置独立的备用凭据，才能在一个账号冷却时
  自动切换。
- 在执行恢复前记录 429 的具体实例、实际命中的本地冷却错误和上游额度已恢复的依据，
  避免把本地网关鉴权故障、OAuth 故障、网络故障或真实额度耗尽误判为陈旧冷却。
