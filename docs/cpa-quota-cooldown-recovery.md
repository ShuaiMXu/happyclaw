# CPA 配额冷却误拦：现象、根因与恢复

适用于 HappyClaw 主机上的两套 CLIProxyAPI（CPA）实例。必须先选择要恢复的
账号实例，避免因默认目标不明确而重启另一账号的网关：

| Profile | Docker 容器 | 地址 | 用途 |
| --- | --- | --- | --- |
| `primary` | `cpa-server` | `http://172.17.0.1:8317` | 主账号 CPA |
| `shaka` | `cpa-server-shaka` | `http://172.17.0.1:8318` | HappyClaw Provider `codex-shaka` |

两套实例的配置、OAuth 凭据和内存冷却状态互相独立。本文只处理**上游 Codex
额度已恢复后，CPA 仍在本地拦截请求**的问题；它不重置上游额度，也不处理 OAuth
登录失败。

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

这与凭据问题不同。401（例如 `Invalid API key` 或 `Missing API key`）才应通过
Codex OAuth 登录处理；重新 OAuth 登录不会重置额度，也不会清除另一个实例的冷却。

## 恢复步骤

先只读确认目标实例和冷却记录：

```bash
# Provider codex-shaka（端口 8318）
scripts/cpa-quota-recover.sh shaka check

# 主账号 CPA（端口 8317）
scripts/cpa-quota-recover.sh primary check
```

只有在已确认该账号的上游额度已经恢复，并确认该实例当前没有进行中的 GPT
会话流量时，才重启**同一 profile**：

```bash
scripts/cpa-quota-recover.sh shaka restart
# 或
scripts/cpa-quota-recover.sh primary restart
```

`restart` 会先验证目标实例健康，再执行 `docker restart`，并最多等待 60 秒恢复健康。
它不会更改磁盘上的配置或 OAuth 凭据，但会中断该实例正在处理的请求。恢复后发送一条
真实模型请求验证：预期是正常响应；如果仍为新的 `usage_limit_reached`，不要继续重启，
应等待/确认上游额度状态。

脚本不再提供隐式默认 profile；需要显式传入 `primary` 或 `shaka`，以防错重启另一账号。
它会同时查询容器日志和所选 profile 的 CPA 响应错误日志，默认检测
`are cooling down via provider codex`。如部署使用了非标准地址、容器名或日志目录，
可显式覆盖 `CPA_URL`、`CPA_CONTAINER`、`CPA_LOG_DIR` 和 `COOLDOWN_MARKER`，但应确保
它们仍指向同一账号实例。

## 预防

- 单账号额度耗尽会造成空窗。为目标 CPA 配置独立的备用凭据，才能在一个账号冷却时
  自动切换。
- 在执行恢复前记录 429 的具体实例、实际命中的本地冷却错误和上游额度已恢复的依据，
  避免把 OAuth 故障、网络故障或真实额度耗尽误判为陈旧冷却。
