# Runtime V2 Durable Run Cancel（持久化任务取消）A2.1 Intent Proof（意图证明）

日期：2026-07-13

状态：A2.1 Intent Service（意图服务）与 Authoritative Proof（权威证明）基础已实现，并通过定向验证、Rust workspace（Rust 工作区）全量测试和全量 Clippy（Rust 静态检查）；这只是 A2 的第一段，尚未接入生产 `run.cancel`。

## 本批完成

### 1. Global CAS（全局比较并交换）意图写入

- 新增 `RunCancellationService::record_intent`，按 `Global Event Ledger（全局事件账本）当前序号 -> Run 重放 -> scope（范围）校验 -> Run / aggregate / Global 三重 CAS -> 精确事件恢复` 的顺序记录 `run.cancellation_intent_recorded`。
- `RunAggregate` 增加仅供 crate（包）内部调用的 Global CAS 入口，并返回实际持久化的 `RuntimeEvent`（运行时事件）；服务不会仅凭调用参数自行构造成功证明。
- CAS 竞争采用最多 8 次的有界重读；完全相同的历史语义返回原事件，不同意图或同幂等键改 reason（原因）会结构化冲突，不盲目追加第二个事件。
- A2 入口允许 `Created / Preparing / Running / WaitingForApproval / Retrying / Committing` 记录意图；`Committing` 只建立副作用屏障，不自行结算。`WaitingForReconciliation` 和普通终态拒绝新意图。
- 原 A1 入口继续维持 `Running / Retrying` 的窄状态规则，避免无意改变旧调用方语义；持久事件重放按 A2 状态矩阵严格验证。

### 2. RunCancellationIntentProof（任务取消意图证明）

- 证明只能由 `RunCancellationService` 根据持久日志恢复，字段私有，不实现 `Serialize / Deserialize`（序列化 / 反序列化），调用方不能从 JSON 或裸字符串伪造权威证明，也不能把旧进程证明持久化后重新注入。
- 证明绑定 canonical database path SHA-256（规范数据库路径哈希）、不可变 `databaseInstanceId`（数据库实例标识）、当前 `leaseOwnerId / leaseEpoch / databaseFileIdentitySha256`（租约所有者 / 租约代次 / 数据库文件身份哈希）、Workspace / Project / Run（工作区 / 项目 / 任务）、完整 Intent（意图）、精确 Run / aggregate / global sequence（任务 / 聚合 / 全局序号）、意图事件 SHA-256 以及 pinned identity SHA-256（固定身份哈希）。
- 精确意图事件通过其受事件哈希覆盖的 `messageId`（消息标识）查询 `runtime_global_event_ledger`；只接受 `Ordered(sequence)`（已排序序号）。`LegacyUnordered`（旧式无序）和缺失账本行均 fail closed（失败关闭），证明恢复时同时复核事件哈希与账本序号。
- 事件哈希采用带版本的 recursive Canonical JSON（递归规范 JSON）和 UTF-8 字节，覆盖事件地址、序列、消息、幂等键、类型、版本、payload（载荷）与时间；序列限制在跨 JavaScript 安全整数范围内，并限制文本和载荷大小。
- 已固定中英文混合 golden vector（黄金向量）：`bbcd41249b0fd1a44823fce1ad9c8c1b32e59dcd5f4fd7ec41eb071352041077`。
- 数据库绑定是三层：规范路径哈希负责 path binding（路径绑定），`databaseInstanceId` 负责逻辑数据库身份，Bound Workspace Runtime Lease（绑定工作区运行租约）的操作系统文件身份负责当前租约生命周期内的 file incarnation（文件世代）。同一路径放入独立初始化的数据库会得到类型化 `DatabaseInstanceMismatch`；同 UUID（通用唯一标识符）副本替换当前文件会被文件身份屏障拒绝。
- 字节级复制数据库会保留相同 `databaseInstanceId`；复制到另一条路径时仍由路径哈希拒绝证明迁移。离线新进程必须取得新的租约代次并从 Journal（事件日志）重建新证明，旧 Proof / Fence（证明 / 栅栏）因 `leaseEpoch` 不同而失效；文件身份哈希本身不作为持久 UUID 宣传或存储。

### 3. BoundWorkspaceRuntimeLease（绑定工作区运行租约）

- `RunCancellationService::new` 现在强制接收 `Arc<BoundWorkspaceRuntimeLease>`；不存在无租约构造路径。构造和每次 Journal 打开前后都验证 exact canonical path（精确规范路径）以及 `verify_database_file_current`，避免只在启动时检查一次。
- `WorkspaceRuntimeLease::bind_database(self, ...)` 采用消费式绑定：测试和服务装配只创建一个 unique raw lease（唯一原始租约），绑定后仅共享 `Arc<BoundWorkspaceRuntimeLease>`，不能保留可降级或绕过文件身份锁的 raw `Arc`。
- `DatabaseFileMissing / DatabaseFileReplaced / DatabaseFileIdentityUnavailable / DatabasePathNotRegularFile / WorkspaceLeasePathMismatch / LeaseOwnerMismatch / LeaseEpochMismatch` 均保持类型化映射，不折叠成普通 I/O 或笼统“证明不匹配”。
- Database Identity Lock / Global Identity Lock（数据库身份锁 / 全局身份锁）的 hash invalid、already bound、unavailable、unsafe 与全局目录失败也逐项映射为类型化 Service Error（服务错误），不降格成普通 I/O。
- Windows 活动 file anchor（文件锚点）不共享删除权限，实测会直接阻止替换主数据库；允许替换已打开文件的平台则在下一次服务操作时通过操作系统文件身份返回 `DatabaseFileReplaced`。
- Bound Lease（绑定租约）还持有按操作系统数据库文件身份哈希建立的 per-user Global Identity Lock（每用户全局身份锁）；即使 hard link / symbolic link（硬链接 / 符号链接）别名拥有不同 sidecar（旁路锁文件），也不能同时绑定同一个数据库文件。取得身份锁后会再次核验当前文件身份，避免检查与加锁之间的替换窗口。
- 多线程并发服务共享同一个 `Arc<BoundWorkspaceRuntimeLease>`，不会为每个请求伪造新的 owner（所有者）或 epoch（代次）。

### 4. RunCancellationWriteFence（任务取消写栅栏）

- `refresh_write_fence` 先复核当前 bound lease（绑定租约）、精确路径、文件身份与 `databaseInstanceId`，再执行 `读取 Global Ledger 序号 -> 重放 Run、精确事件与账本位置 -> 再读 Global Ledger 序号`；只有前后序号一致、意图仍为 `IntentRecorded` 且证明的 owner / epoch / file identity（所有者 / 代次 / 文件身份）完全匹配时才返回 Fence（栅栏）。
- Fence 不实现 `Clone`、`Serialize` 或 `Deserialize`（克隆、序列化或反序列化），后续写服务必须按值消费；任何先发生的全局写入会通过 Global CAS 使旧 Fence 失效。
- Fence 固定当前 Run sequence、Run aggregate sequence、当前 Global sequence，并显式暴露意图事件自身的 Global sequence（任务序号、任务聚合序号、当前全局序号与意图事件全局序号），为 A2.2 的 Provider Attempt Cancellation Service（模型尝试取消服务）提供写入前置条件。

### 5. 恢复、扫描、幂等与兼容阻塞

- `recover_active_intent` 只恢复仍处于 `IntentRecorded` 的精确证明；`scan_active_intents` 以稳定双时钟快照扫描并按 Run ID 排序，只返回活动意图。
- 扫描遇到活动意图的 Workspace / Project 不一致时 fail closed（失败关闭），不会静默漏过；已 `CancelledSafe` 或 `ReconciliationRequired`（安全取消或需要对账）的意图不会被重新水合为活动意图。
- 相同取消命令在活动阶段重试返回同一证明；在已经结算后延迟重试返回 `AlreadySettled` 以及原证明、结算状态和证据哈希，Global Clock 不增长。
- Legacy cancellation（旧式取消）未结算时，记录、恢复和扫描全部返回 `LegacyCancellationPending` 的类型化阻塞，不把旧事件升级或混入新式 Saga（长事务链）。
- 精确事件缺失、重复、被篡改、数据库路径变化、证明不匹配和无法取得稳定快照均为结构化失败，不降级为“没有活动取消”。
- 迁移 `0006` 的账本外键会阻止删除已被全局账本引用的 Run 事件；`RunEvidenceMissing` 只保留为灾难性历史丢失或身份屏障失守时的防御分支，测试不再通过拆外键来制造“正常”缺失证据。

## 验收证据

以下定向及全量命令于 2026-07-13 在当前未提交 A2.1 代码上由执行线程真实执行并记录：

```powershell
Set-Location 'C:\Users\16014\.codex\worktrees\250f\gm-cleanroom\desktop\app\runtime'
cargo test -p novelx-runtime --test run_cancellation_service -- --nocapture
cargo test -p novelx-runtime --test run_cancellation_aggregate -- --nocapture
cargo test -p novelx-runtime --test run_recovery -- --nocapture
cargo test -p novelx-runtime --test global_event_ledger
cargo test -p novelx-runtime --test workspace_runtime_lease -- --nocapture
cargo test -p novelx-runtime --test handshake
cargo test -p novelx-runtime --doc
cargo clippy -p novelx-runtime --test run_cancellation_service -- -D warnings
rustfmt --edition 2024 --check crates\novelx-runtime\src\run_cancellation_service.rs crates\novelx-runtime\tests\run_cancellation_service.rs
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
git diff --check
```

本次留档修正只校准最新结果，没有重跑命令。

真实结果：

- `run_cancellation_service`：17/17；除原有 Global CAS、状态矩阵、证明恢复与扫描、settled retry（已结算重试）、Legacy 阻塞、并发单胜者和跨语言哈希向量外，覆盖精确账本序号、账本篡改/缺失、强制绑定租约、精确路径、旧 lease epoch（租约代次）拒绝、Windows 活动锚点、同路径独立数据库替换、复制边界、旧式无序意图及账本外键保护。
- `run_cancellation_aggregate`：10/10；确认 A1 聚合历史、严格重放和多取消周期未被 A2.1 改坏。
- `run_recovery`：9/9；确认 Run 固定身份、状态与重启重放基础未回归。
- `global_event_ledger`：16/16；确认数据库实例标识、跨 Runtime / Workspace（运行时 / 工作区）精确全局顺序、旧事件无序边界、篡改拒绝、复制/替换语义和并发连续性，并覆盖 Global CAS（全局比较并交换）幂等重试的原事件恢复、旧式/缺失顺序拒绝、结构打开与显式深检边界、触发器定义篡改以及 JavaScript 安全整数上限。
- `workspace_runtime_lease`：9/9；确认两阶段消费式绑定、独占 owner、操作系统文件身份、复制替换、Windows 主数据库锚点与 sidecar 不可删除/重命名、WAL checkpoint / VACUUM（预写日志检查点 / 数据库整理）不误判，以及按文件身份阻止硬链接别名重复绑定。符号链接用例只在当前系统允许创建测试链接时进入断言，不能把 9/9 解读为当前 Windows 已取得符号链接权限覆盖。
- `handshake`（握手黑盒测试）：17/17；确认当前 Runtime V2（第二版运行时）启动、恢复、命令交互和错误阻塞基线未因 A2.1 回归。
- compile-fail doctest（编译失败文档测试）：4/4；其中 3 个证明 IntentProof 不满足 `Serialize / Deserialize` 且 Fence 不满足 `Clone`，另 1 个证明 `bind_database(self, ...)` 消费 raw lease（原始租约），绑定后不能再复用原值。
- `cargo test --workspace` 通过；这是当前 Rust workspace 全量测试结果，不是用定向测试代替的推断。
- `cargo clippy --workspace --all-targets -- -D warnings` 通过；当前 Rust workspace 全量 target（构建目标）无 Clippy warning（警告）。
- `cargo fmt --all -- --check` 与 `git diff --check` 通过；全量 Rustfmt（Rust 格式检查）和差异空白/冲突标记检查均通过。

上述全量验证只证明当前 A2.1 与现有 Rust workspace 基线兼容；它不会扩大完成边界，不能用来声称 A2.2、Host live cancellation（宿主真实取消）或 Provider-only Durable Cancel（仅模型路径持久化取消）已完成。

## 明确未完成

- Host（宿主）尚未接入 `run.cancel` 命令、异步 accepted response（已接受响应）、错误协议或 PendingCancel（待处理取消）状态。
- RuntimeCancellationHub（运行时取消中心）尚未改为只接受权威 IntentProof，也没有 admission seal / generation fence（准入封印 / 代际栅栏）和启动水合。
- Provider Attempt Cancellation Service（模型尝试取消服务）尚未实现；现有 proof 与 Fence 尚未实际消费为 `CancelledBeforeSent` 写入授权。
- RunCancellationCoordinator（任务取消协调器）尚未实现，Provider Attempt（模型尝试）、Operational Recovery（运行恢复）和 AgentLoop（智能体循环）还没有统一收口。
- Startup Recovery（启动恢复）尚未按 `扫描意图 -> Hub 水合 -> 零网络收敛 -> ready` 顺序接线；崩溃重启后的生产路径尚未验证。
- Foreground Provider（前台模型调用）尚未统一使用 Hub、Pre-Send Gate（发送前闸门）和权威取消证明；旧授权路径还没有全部增加 `permits_new_side_effects` 屏障。
- ToolCall（工具调用）、Change Set（变更集）、Artifact（产物）、Assignment（智能体分配）及其他外部副作用尚未进入取消 Evidence Collector（证据收集器）。
- `RunCancellationSettlementProof`（任务取消结算证明）、Evidence Manifest（证据清单）、Unknown（结果未知）分支和 Hub sticky clear（粘性取消清理）尚未实现。
- 当前文件身份只在持有 Bound Workspace Runtime Lease 的进程生命周期内有效，不是可持久化的跨机器 UUID；离线启动必须用新 lease epoch 重建 Proof，不能恢复旧进程内 Fence。
- Global Identity Lock（全局身份锁）的硬链接冲突目前由同进程测试验证，尚无独立 child process（子进程）争用验收；Windows 符号链接用例受创建权限影响，Unix 路径也未在本次 Windows 验收中执行。Unix 文件锁仍是 advisory（协作式）语义，不能把当前结果宣传为所有平台的强制防篡改闭环。

## 不能宣称

- 不能称 A2 已完成。
- 不能称生产 `run.cancel` 已可用或已接入桌面端。
- 不能称 Provider-only Durable Cancel（仅模型路径的持久取消）已经闭环。
- 不能称 Tool / Change Set 等全部副作用已具备安全取消。
- 不能称 NovelX Harness（NovelX 运行框架）已经闭环。
