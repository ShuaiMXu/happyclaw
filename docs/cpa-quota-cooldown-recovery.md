# CPA 配额冷却误拦：现象、根因与恢复

适用于 HappyClaw 主机上的 CLIProxyAPI（Docker 容器 `cpa-server`，监听
`http://172.17.0.1:8317`），上游为 ChatGPT 订阅的 Codex OAuth 凭据。

## 现象

- HappyClaw 侧 GPT 模型报「模型服务额度已用尽或暂时不可用」。
- CPA 日志出现大量 429，耗时仅几毫秒，且伴随：

  ```text
  auth unavailable: 1 of 1 candidate(s) for model "gpt-5.6-sol"
  (provider=codex) are in cooldown:
  [provider=codex auth_file=codex-...@foxmail.com-pro.json,
   reason=quota, remaining=...]
  ```

- 直接请求 CPA 返回：

  ```json
  {"error":{"type":"rate_limit_error","message":"All credentials for model
  gpt-5.6-sol are cooling down via provider codex (last error:
  usage_limit_reached: The usage limit has been reached)"}}
  ```

## 根因

CPA 对上游 `usage_limit_reached` 会在**进程内存**里维护一个冷却计时器，
时长与上游周配额窗口一致（约 7 天）。冷却期内所有请求在本地直接 429，
不会打到上游。因此：

- 如果账号额度真的用完 → 只能等窗口重置，这是正常行为；
- 如果额度已在服务商侧重置（人工重置/客服操作）→ CPA 仍按旧计时器拦截，
  形成误拦，必须清掉内存状态才能恢复。

注意区分两类故障：429 是额度/冷却问题；401（`Invalid API key` /
`Missing API key`）才是凭据问题，后者才需要重新 OAuth 登录
（`docker exec` 进容器执行 `-codex-login` 或 `-codex-device-login`）。
重置额度不等于重新授权，重新授权也不会重置配额。

## 恢复步骤

```bash
# 1. 查看状态（只读）
scripts/cpa-quota-recover.sh check

# 2. 确认上游额度已重置后，清除内存冷却
scripts/cpa-quota-recover.sh restart

# 3. 用真实模型请求验证（任选一种客户端），期望 HTTP 200
```

`restart` 会 `docker restart cpa-server` 并轮询健康检查（最多 60 秒）。
重启只影响 CPA 进程，配置与凭据均在磁盘挂载上，不受影响；执行前确认
当前没有正在进行的 GPT 会话流量。

## 预防

- 单账号配额耗尽会造成整段空窗（约一周）；在 CPA 中接入第二个
  ChatGPT 账号做备用凭据，可错峰自动切换。
- 已验证时间线（2026-10-06）：上游重置后 CPA 仍 429 → 重启容器 →
  `gpt-5.6-sol` 实测 200 正常回复。
