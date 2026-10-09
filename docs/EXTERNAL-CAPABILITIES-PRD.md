# HappyClaw 外调能力中心 PRD（V1）

- **状态：** 实施中，首项能力保持 `draft` / `paused`，不得作为生产服务对外启用
- **产品：** HappyClaw 外调能力中心（External Capabilities）
- **首项能力：** `quote-document-process`（结构化数据规整）
- **目标读者：** 产品、工程、安全、运维、外部调用方后端团队

## 1. 背景与问题

业务系统需要把 Excel、报价单图片等资料交给模型处理，并将可继续消费的标准化结果返回业务系统。直接把工作区、通用 Agent 或任意 Prompt 暴露给外部，会导致调用方能够影响工作区、工具、模型上下文、挂载和数据边界，无法满足隔离、审计与隐私要求。

外调能力中心把一个处理能力定义为平台维护的、版本化的服务端到服务端合同：调用方只能上传允许的文件、给出受限任务说明和输出表结构；平台固定能力范围、处理策略、目标 Workspace、执行模式、模型执行边界和结果格式。

## 2. 产品目标

### 2.1 V1 目标

1. 为受控业务后端提供异步的“结构化数据规整”接口。
2. 支持 JPEG、PNG、WebP、XLSX 输入，并输出一个认证下载的 XLSX 底表；V1 明确拒绝旧版 XLS、宏、嵌入对象和外部链接内容。
3. 支持服务端 Key 鉴权、任务幂等、状态轮询、任务取消、私有文件存储和到期清理。
4. 外部输入、提示词和文档内容均视为不可信数据，不能改变平台策略或取得 Agent 工具权限。
5. 任务执行必须与普通 Workspace、Skills、MCP、Plugins、飞书状态、额外挂载和会话目录隔离。

### 2.2 成功指标

| 维度   | 发布后的衡量指标                                                             |
| ------ | ---------------------------------------------------------------------------- |
| 隔离   | 自动化隔离哨兵测试 100% 通过；跨 Key、跨任务、跨 Workspace 均不可访问        |
| 正确性 | 同 Key 的相同语义重试返回同一 `runId`；不同语义请求不得错误复用              |
| 安全   | API、日志、浏览器响应和错误信息不泄露密钥、Vault 路径、原文件、Base64 或 PII |
| 可用性 | 任务始终进入明确终态或可解释队列状态；执行中断不自动重复模型调用             |
| 运维   | 清理、队列、执行、失败、容量、成本都有指标、告警和 Runbook                   |

## 3. 范围

### 3.1 V1 范围

- 固定能力：`quote-document-process`。
- 调用方服务端以能力专属 Bearer Key 提交、查询、取消和下载任务。
- 固定的报价/业务资料规整策略，调用方仅能提供任务级说明与受限 `outputSchema`。
- 私有 Vault、哈希校验、任务租约、围栏 token、XLSX 公式注入中和、留存清理。
- 容器隔离执行，禁止 Agent tools、MCP、Skills、Plugins 与普通 Workspace 上下文。
- 控制面中的能力生命周期、Key 创建与撤销。

### 3.2 明确非目标

- PDF、DOC/DOCX、CSV、压缩包及任意二进制输入。
- 浏览器端直调、浏览器保存 Key、公共下载链接或任意回调 URL。
- 外部调用方指定 Workspace、Agent、模型、Prompt、工具、容器挂载或环境变量。
- Webhook 回调（后续版本需预注册目标、签名、防重放、耐久 Outbox、重试和死信队列）。
- 自动写回调用方业务数据库、业务结果正确性担保或自由编排能力市场。

## 4. 用户、角色与权限

| 角色           | 凭据/权限                                                       | 可以做什么                                 | 不可以做什么                                     |
| -------------- | --------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------ |
| 外部调用服务   | 能力专属 `ec_...` Key                                           | 提交、查询、取消、下载该 Key 创建的任务    | 管理能力、读取其他 Key 的任务、影响执行配置      |
| 能力运营管理员 | 登录态 + `manage_external_capabilities` + 目标 Workspace 修改权 | 查看状态、启停能力、创建/撤销 Key          | 再次读取已创建 Key 明文、越过 Workspace 归属边界 |
| 发布负责人     | 基础设施与发布权限                                              | 配置 Vault、发布、迁移、设置配额、事故处置 | 将 Vault 暴露为公开文件目录                      |
| 审计人员       | 后续单独的只读审计权限                                          | 查看脱敏事件、状态变化和清理结果           | 下载业务文件、查看 Key 明文                      |
| 终端用户       | 无 HappyClaw 直接权限                                           | 通过其所属业务系统查看结果                 | 直接调用外调 API                                 |

Key 明文只在创建响应中出现一次；数据库只保留验证材料和最小元数据。`tenantRef`、`accountRef`、`externalTaskId` 必须是调用方生成的不透明引用，禁止传姓名、电话、地址、证件号或其他 PII。

## 5. 核心流程

### 5.1 外部调用流程

1. 调用方服务端生成稳定的 `externalTaskId`，重试时复用 `idempotencyKey`。
2. 调用方以 `multipart/form-data` 上传文件、受限 `outputSchema` 与可选任务说明。
3. 平台在解析大请求体前鉴权，校验能力状态、请求字段、文件数、大小、文件名和真实内容类型。
4. 平台计算文件 SHA-256 和稳定的语义请求指纹；相同 Key 的相同请求返回原任务，不创建第二次执行。
5. 输入写入项目根目录外的私有 Vault，并持久化为 `queued` 任务。
6. Worker 领取任务，在隔离容器中执行固定策略，获得严格 JSON 行集后由服务端生成 XLSX。
7. 调用方轮询状态；成功后以相同 Key 下载 XLSX，或在任务尚未执行时/执行中请求取消。
8. 输入、输出和临时运行目录按保留策略自动删除；仅保留最小审计元数据。

### 5.2 运营流程

1. 发布负责人验证 Vault、迁移、容器隔离、容量和 Provider。
2. 能力管理员确认固定目标 Workspace 完整性后，将能力由 `draft` 转为 `active`。
3. 创建带明确用途和到期策略的 Key，保存到调用方的秘密管理系统。
4. 先以白名单 Key、低并发与低配额灰度接入，监控队列、错误、成本、清理与输出质量。
5. 异常时先 `paused` 停止新受理/领取，再撤销可疑 Key；必要时终止执行容器并轮换凭据。

## 6. 状态机

### 6.1 能力生命周期

```text
draft ──[发布前置条件满足]──> active
active ──[常规暂停]────────> paused
paused ──[恢复检查通过]────> active
draft / active / paused ───> retired
```

| 能力状态  | 新提交 | 已排队任务                   | 运行中任务                   | 新建 Key             | 历史下载     |
| --------- | ------ | ---------------------------- | ---------------------------- | -------------------- | ------------ |
| `draft`   | 拒绝   | 无                           | 无                           | 可预配置，不建议发放 | 无           |
| `active`  | 接受   | 可领取                       | 正常完成                     | 允许                 | 保留期内允许 |
| `paused`  | 拒绝   | 不领取；按运营策略冻结或取消 | 默认允许完成；紧急处置可中止 | 禁止                 | 保留期内允许 |
| `retired` | 拒绝   | 取消且不执行                 | 需明确事故策略，不能盲目重放 | 禁止                 | 仅保留期内   |

Worker 必须在领取前与调用前复核能力状态、固定目标 Workspace、folder 与 `container` 执行模式；不能只在 HTTP 受理时检查。

### 6.2 任务状态

```text
queued ──> running ──> succeeded
   │          │  └──> failed
   │          └─────> cancelled
   └────────────────> cancelled
retry_wait ──> queued
```

- `queued`：输入已安全存储并持久化，等待领取。
- `running`：Worker 已持有 lease 和 fencing token。
- `started_at`：模型执行前的不可逆边界。宿主在同一个 `synchronous=FULL` immediate transaction 中写入该字段和本次最大 Provider 成本预留，然后才向 Runner 原子发布 START。此前且 START 可证明未发布时允许安全回滚；此后中断必须 `failed(PROCESSING_INTERRUPTED)`，不得自动重放。
- `succeeded`、`failed`、`cancelled`：终态。正常终态把成本预留结算为已记录的实际 usage；已开始后的崩溃或取消在实际成本不完整时保留 `uncertain` 暴露。
- 调用方取消会先持久化为 `cancelled` 并提升 fencing token；本进程中的执行容器随后收到立即停止请求。跨进程 Worker 最迟在 lease 续约失败后停止，且不得再结算结果。未开始任务释放零 usage 预留；已开始任务不得假定 Provider 未收费。
- V1 的暂停与 Key 撤销以**执行边界**划分：`queued`、`retry_wait` 会取消；已领取但 `started_at` 为空的任务不得跨越模型调用边界，并在恢复后由正常 lease 机制重新领取；`started_at` 已写入的运行任务可以结算，避免中断后产生无法判断的重复模型调用。紧急中止已开始任务必须使用显式取消/事故处置，不可把暂停或撤销当作隐式强杀。

## 7. 接口契约

数据面只接受 `Authorization: Bearer ec_...`，不接受 Cookie。所有查询、取消和下载均要求同一能力、同一 Key、同一 `runId`，不匹配时返回 `404`，避免泄露任务存在性。

| 方法     | 路径                                                 | 作用                   |
| -------- | ---------------------------------------------------- | ---------------------- |
| `POST`   | `/v1/external-capabilities/:slug/runs`               | 提交异步任务           |
| `GET`    | `/v1/external-capabilities/:slug/runs/:runId`        | 轮询状态和安全结果摘要 |
| `DELETE` | `/v1/external-capabilities/:slug/runs/:runId`        | 取消未终态任务         |
| `GET`    | `/v1/external-capabilities/:slug/runs/:runId/output` | 下载成功生成的 XLSX    |

### 7.1 提交字段

| 字段                      | 必填 | 约束                                                                                                                                                                                           |
| ------------------------- | ---: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `externalTaskId`          |   是 | 调用方范围内不透明 ID，1–128 字符                                                                                                                                                              |
| `idempotencyKey`          | 建议 | 重试时稳定复用，1–128 字符                                                                                                                                                                     |
| `tenantRef`、`accountRef` |   否 | 不透明、非 PII 标签                                                                                                                                                                            |
| `instructions`            |   否 | 最多 8,000 字符，只是任务数据                                                                                                                                                                  |
| `outputSchema`            |   是 | V1 schema；1–100 个唯一字段 Key，可选合法 Sheet 名；列可含 `required` 与受限 `description`，不得请求身份、联系方式、账号、凭据、路径或原文件名等敏感输出                                       |
| `files`                   |   是 | 1–10 个 JPEG/PNG/WebP/XLSX；单个 ≤20 MiB，总量 ≤50 MiB；图片必须完整解码、单帧、边长 ≤8,000 px、总像素 ≤25 MiPx；XLSX 必须是受限解压规模、无 DTD/entity、宏、嵌入对象和外部链接的 OOXML 工作簿 |

`outputSchema` 的 V1 列由 `key`、`name`、可选 `required` 和可选 `description` 组成。服务端拒绝未知字段、重复 Key、不支持的 schema 版本、非法 Sheet 名，以及明确要求输出客户身份、联系方式、证件、详细地址、银行/卡号、凭据、内部路径或原文件名的列。`required: true` 不会因源资料缺失而让整个任务失败：服务端写入 `null`，并生成结构化 `MISSING_REQUIRED_VALUE` warning。

成功状态中的 warning 只能是 `{code, rowIndex?, columnKey?}` 结构，最多 100 条；行号从 1 开始，列引用必须属于已接受的 schema。模型只可使用服务端枚举的非敏感 warning code，不能返回 warning 文案、源资料摘录、原文件名或路径；`MISSING_REQUIRED_VALUE` 仅由服务端确定性生成。

### 7.2 幂等性

服务端以 `externalTaskId` 或 `idempotencyKey` 在**同一 Key 范围内**保证唯一。稳定指纹由任务说明、规范化输出 schema、按顺序的文件名/检测类型/字节长度/SHA-256 构成，不包含随机的 `runId`、`artifactId`、`storageRef` 或上传时间。

- 同 Key、相同业务 ID、相同语义指纹：`200`，返回原 `runId` 与 `duplicate: true`。
- 同 Key、相同业务 ID、不同语义指纹：`409`，不覆盖已有任务。
- 不同 Key 可使用相同业务任务 ID，彼此不可见。

### 7.3 错误码

| HTTP | 代表错误码                                                                             |
| ---: | -------------------------------------------------------------------------------------- |
|  400 | `INVALID_REQUEST`、`INVALID_OUTPUT_SCHEMA`、`INVALID_FILE`、`UNSUPPORTED_CONTENT_TYPE` |
|  401 | `EXTERNAL_AUTH_REQUIRED`、`EXTERNAL_AUTH_INVALID`                                      |
|  404 | `NOT_FOUND`                                                                            |
|  409 | `CAPABILITY_UNAVAILABLE`、`IDEMPOTENCY_CONFLICT`                                       |
|  410 | `OUTPUT_EXPIRED`、`OUTPUT_UNAVAILABLE`                                                 |
|  413 | `PAYLOAD_TOO_LARGE`                                                                    |
|  429 | `RATE_LIMITED`、`QUOTA_EXCEEDED`                                                       |
|  503 | `PROCESSING_UNAVAILABLE`                                                               |
|  507 | `VAULT_CAPACITY_EXCEEDED`                                                              |

错误响应不得返回内部异常、Vault 路径、工作区标识、容器名、模型原始错误或原始文件名。

## 8. 数据安全与生命周期

### 8.1 Vault 规则

- `EXTERNAL_CAPABILITY_VAULT_DIR` 必须位于项目根目录外，且没有静态 HTTP 映射。
- 目录权限为 `0700`，文件权限为 `0600`。
- 写入采用服务端生成 ID、`O_CREAT | O_EXCL | O_NOFOLLOW`；读取重新验证普通文件、长度与 SHA-256。
- 不透明的 `ecv1:<runId>:<artifactId>` 引用不是文件路径，永不对外暴露。
- 输入、输出和 per-run runtime 目录均不可从普通 Workspace、公开上传或浏览器文件面板访问。
- 输入、每次执行的 runtime 副本和输出必须在首次物理写入前创建耐久字节预留，并在 fsync 后按实际占用结算。`reserved`、`occupied` 和无法证明已删除的 `quarantined` 对象都占用容量。
- `EXTERNAL_CAPABILITY_VAULT_MAX_BYTES` 限制逻辑占用；`EXTERNAL_CAPABILITY_VAULT_MIN_FREE_BYTES` 是基于同一文件系统 `statfs.bavail * bsize` 的不可申领安全余量。默认分别为 100 GiB 和 1 GiB，非法配置回退到默认值。
- 容量准入在 SQLite immediate transaction 中串行化，并扣除其他进程尚未物化的预留；逻辑上限或文件系统余量不足必须以 `507 VAULT_CAPACITY_EXCEEDED` 失败关闭。

### 8.2 清理规则

- 默认保留期为任务终态后最多 24 小时；部署可缩短到 1–24 小时。到期边界按 `<= cutoff` 判定，不能把恰好到期的对象推迟到下一轮。
- 清理器每 30 秒扫描，并以 1 分钟调度安全余量让对象提前具备清理资格；正常调度下即使任务刚错过上一轮也不会越过配置的保留上限。单项或整轮失败在 5 秒后重试，且同一时刻只有一轮清理。
- 清理器删除终态任务的输入、结果、运行目录、入队失败残留与无数据库归属的孤儿目录。
- 清理必须文件系统优先、数据库记录随后，并可安全重试。只有物理删除成功或精确对象已确认不存在后，才能释放对应耐久字节占用；删除失败、状态不确定或账本更新失败时保持计费并由后续扫描重试。
- 清理器还会分页核对老化但未释放的预留：精确物理对象不存在时才释放，用于恢复“准入后、首个文件创建前崩溃”和“删除成功、账本更新前崩溃”。数据库墓碑删除原始私有请求上下文，但保留组合 SHA-256 等值收据，使保留前的幂等冲突不会在保留后变成重复命中。
- 过期后下载返回受限的 `404`/`410`，不透露底层存储细节。
- 生产环境需要加密卷和与备份一致的到期策略；文件删除不等于物理介质覆盖。

## 9. 执行隔离与模型安全

每次任务创建临时执行根目录，其中输入只读、输出可写、运行态独立。外调容器只能看到：

- `/workspace/input`：当前任务已验证输入的私有副本，只读；文件名由服务端生成，原始文件名和 Vault 路径不会进入容器；
- `/workspace/group`：空白且任务独占的输出目录；
- 独立的 Claude session、IPC 和 Provider 环境。

外调任务不得继承普通 Workspace/project 挂载、用户环境变量、额外挂载、飞书 CLI、用户 Skills、MCP、Plugins、原会话目录或其他 run。每个 run 使用运行目录内的新建最小 `.claude.json`，不共享宿主派生的身份文件；外调任务只允许不可变镜像模式，开发热重载模式必须拒绝执行，避免挂载项目源码。Agent Profile 固定，`allowedTools` 为空；调用方不能注入 Agent、Prompt、工具或环境配置。容器必须使用预创建、经审核且非默认的专用 Docker 网络，并启用 capability drop、`no-new-privileges`、PID、内存和 CPU 限制。

所有上传资料、解析出的表格文本和任务说明均是不可信数据。服务端策略优先，明确要求模型只返回受限 JSON；结果必须再经过 JSON、部署配置的最大行数、单元格类型、列白名单、长度、有限数值、结构化 warning 和敏感值模式校验。未知列、自由文本 warning、非有限数值和命中敏感值规则的单元格均使结果失败关闭。服务端在创建 ExcelJS 工作簿前以行列数量和字符串字节数估算物化堆内存，超过固定内存预算时先失败，序列化后仍执行实际 XLSX 字节上限检查。导出的 XLSX 对以 `= + - @` 开头的值添加前导单引号，防止公式注入。

代码已要求 `EXTERNAL_CAPABILITY_DOCKER_NETWORK` 指向预创建、经审核的专用网络，并在激活、受理和 Worker 调度时检查 Docker inspect 结果：网络必须是 local bridge、`Internal=true`、非 ingress/config-only，且带有 `com.happyclaw.external-capability-egress=true` 和 `com.happyclaw.egress-policy=provider-only` 标签。Provider 必须通过同网络内的受控代理访问；这些结构与标签仍不能代替 V1 发布前的真实出口哨兵测试：仅允许 Provider 所需受控出口，禁止访问宿主机、元数据服务、内网横向地址和其他公网地址。

## 10. 容量、成本和可观测性

发布配置必须提供全局、能力级和 Key 级限制：并发执行数、排队数、请求速率、日文件量、单次运行时长、最大输出行数和模型费用预算。达到限制时必须安全拒绝而不是无限排队或绕过配额。

Provider 成本保护按滚动 24 小时计算，START 在不可逆边界内为单次最大预算创建耐久
预留。暴露值对 `active`/`uncertain` 取 `max(预留, 已知实际)`，对 `settled` 取实际
成本，对明确未发布的 `released` 取零。usage event 使用稳定 ID 恰好一次累加；过期
started lease、已开始取消和 Workspace 删除保留 `uncertain`，不得因最终 usage 不完整
而释放全部成本空间。该账本保护平台 Provider 暴露；若产品要求向工作区 owner 钱包计费，
仍需单独定义与统一 `usage_events`/余额账本一致的 escrow 或 held-balance 语义。

最小指标包括：受理数、幂等命中、状态分布、队列深度、排队/运行耗时、失败率、lease 过期、容器数、Vault 容量、清理结果、认证失败、Key 撤销命中、模型 token/成本。

告警覆盖：认证异常、Key 滥用、队列堆积、失败率升高、`PROCESSING_INTERRUPTED`、Vault 空间不足、清理失败、容器/隔离失败、单 Key 成本突增、迁移异常。

审计事件至少记录能力启停、Key 创建/撤销、任务受理/重复/开始/终态/取消/清理、配额拒绝与紧急操作；事件不得含原始文件、Key 明文、PII 或 Vault 路径。

## 11. 当前实现进度与剩余问题

已完成的基础能力：专属 Key、受理/轮询/下载、私有 Vault、防路径与链接攻击、耐久 intake admission 与独立状态/取消/下载限流、任务租约和 fencing（含过期 lease 不得续租或结算）、能力暂停/退役、Key 撤销和 Workspace owner 停用围栏、隔离 execution 目录与只读输入物化、精确到期边界和短重试的保留清理、Worker 并发槽位、调用方和运营方取消 API、可中止本进程执行容器、稳定请求指纹与保留后私有上下文等值收据、宿主发布闸门、专用 Docker 网络强制和基础容器进程/资源硬化、镜像 digest/协议 label 证明、带发布余量的 READY/START/ABORT 授权协议、启动与周期孤儿容器协调、执行中不可变目标漂移的暂停与延迟迁移、单次输入/Key 日输入量/最大输出行数和输出字节配额、输入/runtime/输出的跨进程耐久 Vault 容量预留与文件系统优先释放、全局/能力/Key Provider 成本预留与 usage 结算、图片完整解码、namespace-aware OOXML 校验、受限输出 schema、结构化 warning、敏感输出防护、XLSX 物化前内存预算、Runner 零工具/零 MCP/零 Skills/Plugins 回归测试，以及 Key/生命周期/就绪度控制面 UI。

仍是发布阻断项：

1. 在真实 Docker 环境补齐端到端和隔离哨兵测试，证明容器无法读取项目、普通 Workspace 或其他任务。
2. 在真实并发和跨进程条件下补齐 pause/retired/Key revoked/owner inactive 的三阶段围栏 E2E，覆盖 READY 前后的取消、lease 丢失和下载失效。
3. 已将 V1 收缩到图片和 XLSX：拒绝旧版 XLS、DTD/entity、宏、嵌入对象、外部链接、加密复合文档和超出解压规模/比例限制的 OOXML；仍需以恶意样本库补充真实解析压力测试。图片已实施完整解码、单帧、边长与像素总量限制。
4. 全局/能力/Key 级速率、队列、并发和 Provider 成本配额已实现；仍需真实并发压力测试、成本拒绝/恢复可观测性，并决定是否把外调 usage 接入统一用户钱包 escrow。
5. 对错误响应和持久化错误做统一安全映射，禁止向调用方回传内部异常消息。
6. 不可变 run/attempt/lease 标签、启动扫描、周期孤儿协调和删除前容器不存在性确认已实现；仍需在真实 Docker daemon 故障和跨进程恢复演练中验证。
7. 完成真实 Provider + Container 演练、数据库升级恢复演练、监控告警和事故 Runbook。

## 12. 发布阶段与验收

### 阶段 A：安全与正确性

- 隔离容器 E2E；Key A/B 越权查询、下载、取消测试；真实 multipart 重传；恶意/超限文件；公式注入；Worker lease 围栏。
- 验收：容器看不到哨兵文件；同语义重试只产生一个可执行 run；任务中断不重复模型调用。

### 阶段 B：生命周期和运维

- 清理、孤儿扫描、暂停/退役/Key 撤销语义、配额、超时、指标、审计和告警。
- 验收：成功/失败/取消/过期/孤儿均按策略处理；模拟 Vault 满、Provider 不可用、Worker 重启时安全失败且可观测。

### 阶段 C：灰度发布

- 仅向白名单调用方发放低配额 Key，使用脱敏真实样本验收，逐步放量。
- 验收：连续稳定窗口内的准确性、延迟、成本、清理和安全指标满足目标，并完成产品、工程、安全、运维的发布审批。

能力在以下条件全部满足前必须保持 `draft` 或 `paused`，且宿主机 `EXTERNAL_CAPABILITY_RELEASE_ENABLED` 发布闸门必须保持关闭：真实隔离 E2E、状态机围栏、配额/限流/成本保护、清理验证、升级与恢复演练、监控告警、调用方秘密管理和灰度审批。只有发布负责人完成验收后，才可先打开宿主机闸门，再由能力管理员切换生命周期状态。

## 13. 待确认的产品决策

1. 是否统一以终态后 24 小时作为输入与结果保留期？
2. 已决定 V1 仅接受图片和受限 XLSX；旧版 XLS 需独立安全评审后才可进入后续版本。
3. 已决定 `required: true` 在源资料缺失时采用 `null + MISSING_REQUIRED_VALUE`，不让整批任务失败。
4. 已决定 `paused` 将 queued/未开始的 running 任务置为可恢复等待；`retired` 取消 queued/未开始任务；已跨过执行边界的任务不自动重放，只允许安全结算或显式事故取消。
5. 已决定 Key 撤销后立即阻断该 Key 的查询、取消与下载，并取消 queued/未开始任务；已开始任务仍按 at-most-once 规则安全结算，必要时由运营方事故取消。
6. 一个业务系统一个 Key，还是一个租户一个 Key；是否增加 IP allowlist/mTLS？
7. 每 Key 的 QPS、并发、运行时长和费用上限由谁审批？
8. 输出是仅供人工复核的草稿，还是可直接写入业务流程？
9. 未来是否需要 Webhook；若需要，谁维护预注册接收端和签名密钥？
10. 审计元数据、Key 使用记录和安全事件分别保留多久、由谁可读？
