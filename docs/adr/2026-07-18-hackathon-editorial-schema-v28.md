# ADR：黑客松 Growth Editorial SQLite Schema v28

日期：2026-07-18

状态：已接受并实现为黑客松持久化基础；生命周期仓储尚未实现

## 上下文

World Director（世界总编）需要在进程重启后恢复 Editorial Round（编辑轮次）、Work Order（创作工单）、依赖、尝试、审核和候选 Artifact（产物）。现有 SQLite v27 只拥有 Growth Goal（生长目标）、Cycle（周期）、Inquiry（询问）、Closure（闭合验收）、图片队列和安全诊断，不能表达编辑分工与候选谱系。

本迁移必须遵守以下边界：

- 只做 v27 到 v28 的纯加法迁移，不重写现有世界、文档、断言、Growth、Change Set（变更集）或审计行。
- 候选阶段不得产生 Domain（领域层）副作用；正式写入仍由既有串行 Change Set 路径负责。
- Schema（数据结构）负责持久化不变量，不复制 Task 6 的生命周期调度、依赖解锁或恢复算法。
- 数据库不得存储原始 Prompt（提示词）、Provider（模型服务）凭据或 Provider URL；候选正文采用内容寻址存储，SQLite 只保存引用与 SHA-256。
- Rust Runtime V2（第二版运行时）A2.2、公开协议、Canon（正史）语义、权限和数据兼容性保持不变。

## 决策

### 六张纯加法表

v28 新增且只新增以下表：

| 表 | 权威内容 |
| --- | --- |
| `growth_editorial_rounds` | Goal 下的编辑轮次、固定 checkpoint（检查点）、规则修订和终态 |
| `growth_work_orders` | 不可变工作定义、固定能力所有者、拓扑序和生命周期状态 |
| `growth_work_order_dependencies` | 同一 Goal / Round 内的前置依赖 |
| `growth_work_order_attempts` | 同一所有者的尝试谱系和完整执行身份钉扎 |
| `growth_editorial_reviews` | Checker（检查者）与 Director 的决策、可安全展示摘要及内容寻址审核引用 |
| `growth_work_order_artifacts` | 候选、审核和 Change Set 产物的内容寻址引用 |

没有新增便利性第七表，也没有把阶段私有数据继续塞进现有公共 Growth 合同。

### 单一拓扑权威

`growth_work_orders.ordinal` 是 Round 内唯一的规范拓扑顺序。依赖表通过复合外键保证两端属于同一 Goal 和 Round；插入触发器只允许依赖指向更小的 `ordinal`。因此每条边都严格递减，数据库层可证明有向图无环，不需要另存一套可漂移的图排序。

依赖边创建后不可更新。若计划需要不同依赖，调用方必须创建新的 Round，而不是在运行中的轮次里悄悄改图。

### 并发与所有权约束

部分唯一索引保证：

- 每个 Goal 最多一个 `planned` 或 `active` Round；
- 每个 Work Order 最多一个 `running`、`candidate_ready` 或 `reviewing` 尝试。

每个尝试通过复合外键固定到 Work Order 的 capability ID（能力标识），所以返工不能暗中换作者。新的尝试必须继续使用原 Work Order 所有者；真正改变能力需要 Director 创建新 Work Order 并声明依赖。

Work Order 定义从插入起不可变，包括 Goal、Round、序号、目标、scope refs（范围引用）、来源 checkpoint、能力、验收 facets（维度）、幂等键和负载哈希。状态和更新时间可以合法推进。`accepted` 后的内容调整只能形成新尝试，不能覆盖既有定义或候选谱系。

### 执行身份与结果未知

尝试钉扎以下身份：

- 来源 checkpoint 与 Goal 规则修订；
- capability profile（能力配置）的 ID、版本和 SHA-256；
- Prompt 的 ID、版本和 SHA-256，但不保存 Prompt 正文；
- Provider ID、模型 ID 和脱敏配置 SHA-256，但不保存凭据或地址。

`side_effect_state='outcome_unknown'` 与 `status='reconciliation_required'` 必须成对出现。该状态提供持久化阻断标记；数据库触发器会拒绝存在结果未知前置项的后继进入 `ready` 或 `running`。Task 6 的 Growth Editorial Repository（生长编辑仓储）仍负责完整依赖解锁、恢复和合法状态转换，Schema 不假装已经实现调度闭环。

### 内容寻址产物

候选与审核正文不进入 SQLite。`growth_work_order_artifacts` 只保存 `artifact_store_ref`、`content_sha256`、类型和序号；审核表同样只保存安全摘要、证据引用和审核 Artifact 引用/哈希。表中没有正文、Prompt、API key（接口密钥）、Provider URL 或工具参数字段。

### 迁移事务与等价验证

v27 到 v28 在一个 `BEGIN IMMEDIATE` 事务中创建六张表、索引和触发器，随后执行外键与完整性检查，再把 `schema_meta.version` 更新为 28。任一对象冲突或校验失败会回滚整个事务，版本仍为 27。

测试对除 `schema_meta`、新 v28 表和既有易变运行环境探针 `retrieval_index_capability` 之外的所有旧表逐列记录 SQLite 类型及原始字节十六进制，并在迁移和再次打开后比较。`retrieval_index_capability.checked_at` 由既有 `openWorkspace` 在迁移事务之后主动刷新，不属于世界或领域数据，因此单独排除；迁移 SQL 本身不读取或更新该表。

## 后果

### 正向结果

- 重启后有足够的持久化身份恢复编辑轮次、固定所有者、尝试、审核与候选引用。
- 依赖无环、同轮次归属和单活跃约束在 SQLite 层失败关闭。
- Provider/Prompt 身份可审计，同时不把敏感正文或凭据写入数据库。
- v27 数据不需要回填，迁移冲突可完整回滚。

### 代价与限制

- 规范拓扑序使运行中修改依赖成为非法操作；改变计划必须新建 Round。
- v28 只是持久化基础，不等于 World Director 已经 Live（真实运行）。Task 6 仍需实现合法状态转换、幂等重放、依赖解锁、取消、恢复和结果未知阻断。
- Artifact Store（产物存储）的实际写入、校验和垃圾回收不在 Task 5 范围内；当前表只定义安全引用合同。
- 本任务没有执行真实 Provider，也没有生成世界包。

## 被否决的方案

### 把整个 Round 保存为单个 JSON

否决。单活跃尝试、固定所有者、依赖归属、幂等身份和重启恢复都只能靠调用方约定，SQLite 无法失败关闭。

### 用递归触发器搜索任意环

否决。它会在数据库里维护比业务所需更复杂的第二套图算法。规范 `ordinal` 已是合同的一部分，严格递减边用更小、更可审计的不变量即可证明无环。

### 把候选正文和 Prompt 直接存进数据库

否决。它扩大敏感数据面、复制 Artifact 内容并使默认诊断/备份更容易泄漏内部 Prompt。内容寻址引用已经满足恢复和审计需要。

### 在 Task 5 同时实现调度仓储

否决。Schema 与状态机一起落地会混淆迁移证据和运行语义，也会提前进入 Task 6。`reconciliation_required` 的持久状态已准备好，但后继阻断必须由下一任务用可执行仓储测试证明。

## 验收与恢复入口

- 定向验收：`npx --no-install vitest run --config vitest.config.ts tests/unit/workspace-persistence.test.ts`
- 实现入口：`src/domain/workspace/workspaceRepository.ts` 中 `migrateGrowthEditorialV28Schema`
- 可执行规格：`tests/unit/workspace-persistence.test.ts` 的 v27→v28 等价、冲突回滚和 Growth Editorial 不变量测试
- 下一阶段：计划 Task 6，新增独立 Growth Editorial Repository；不得继续扩张本迁移函数承担调度职责
