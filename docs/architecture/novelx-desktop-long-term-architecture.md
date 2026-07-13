# NovelX Desktop 长期架构蓝图

状态：目标架构，不是当前实现完成声明

最后校准：2026-07-14
产品依据：`docs/product/novelx-desktop-product-requirements.md`

## 1. 架构目标

地基完成后，NovelX 应具备一个可靠、可恢复、可审计、可扩展的小说领域 Harness（智能体运行框架）。它允许大管家和专业 Agent 使用项目工具、上下文、长期记忆、版本系统与 Provider（模型服务）完成真实创作，同时确保：

- 模型不能伪造工具结果、权限、来源和完成状态；
- 程序崩溃不会重复 Provider 调用、图片费用或项目写入；
- 正史、草稿、候选记忆、玩家已知事实和 Agent 私有记忆不会混写；
- 桌面 UI 不承担业务裁决，也不靠解析自然语言猜 Agent 状态；
- 上游 Agent 项目的成熟能力可以被引入，但不能获得 NovelX 正史和项目事务的权威。

## 2. 总体结构

```text
┌──────────────── Electron Host ────────────────┐
│ React Renderer                                │
│ Agent / IDE / Player / Showcase / Graph / UI  │
│                    │ typed IPC                │
│ Main + Preload     │                          │
│ secure config / window / updater / protocol   │
└────────────────────┼──────────────────────────┘
                     │ versioned RPC + event stream
┌────────────────────▼──────────────────────────┐
│ Rust Runtime V2                               │
│ Run / Goal / Plan / Assignment / Tool /       │
│ Provider / Recovery / Permission / Audit /     │
│ Context / Compaction / Scheduler               │
└────────────────────┬──────────────────────────┘
                     │ typed domain commands
┌────────────────────▼──────────────────────────┐
│ NovelX Domain Runtime                         │
│ Resource / Document / Relation / Version /     │
│ Canon / Graph / Memory / Import / Image /      │
│ Story / Playthrough / GM / Writer / Checker    │
└────────────────────┬──────────────────────────┘
                     │ repositories + immutable artifacts
┌────────────────────▼──────────────────────────┐
│ SQLite + Artifact Store + Search Index         │
│ event journal / projections / source / assets  │
└───────────────────────────────────────────────┘
```

## 3. 三层参考体系

### 3.1 Codex CLI：可靠性标准

重点参考：Run 生命周期、事件协议、上下文压缩、工具结果管理、Goal / Plan、取消、恢复、审批、审计、沙箱和副作用安全。NovelX 不整体 Fork Codex，也不继承其“代码仓库、Shell、Patch 是核心产品”的假设。

Codex 的等量迁移不是改名，而是迁移不变量：

- 任何外部副作用先持久化 intent（意图）和稳定身份；
- 工具调用与结果严格配对；
- 不确定结果不自动重试；
- UI 投影结构化事件；
- 压缩保留恢复所需状态；
- 权限、审批和取消由 Runtime 控制，不由 Prompt 自律。

### 3.2 oh-my-pi：成熟 Agent 功能参考

重点审计：agent-loop、compaction、task、session、RPC、mnemopi、Provider、原生读取/搜索/Token 工具。每个模块必须产出四项结论：可直接复用代码、只能参考的设计、与 NovelX 冲突的假设、必须由 Rust Runtime V2 接管的状态。

禁止整体 Fork。特别禁止把进程内 Task 状态、编码 Agent 记忆或上游工具权限直接当作 NovelX 权威状态。上游代码只能在适配器后运行，其产物必须经过 Runtime 和 Domain Validator。

### 3.3 NovelX Runtime V2：小说领域权威

NovelX 自己负责：正史、故事范围、OC 变体、来源、Creator / Player Lens、Change Set、玩家流程、世界包、图片来源绑定、领域冲突和项目版本。任何上游实现都不能直接绕过这些边界。

### 3.4 Pi Agent：现有迁移与兼容参考

当前 TypeScript 路线使用 `@earendil-works/pi-agent-core` 和 `pi-ai`。它可以作为 Provider、消息循环和现有功能的迁移来源，但不是最终状态权威。Runtime V2 达到对等验收前保留旧路径；迁移后逐项删除，不永久维护两套相互竞争的运行语义。

### 3.5 webnovel-write：领域结构参考

用于审计网文项目组织、章节工作流、提示结构、连续性检查和创作工具形态。只选择性吸收领域流程与合规可用源码；不复制其数据假设、Prompt 或许可证不明内容，不让它替代 Canon、来源和 Runtime。

### 3.6 UI 参考

- Codex：信息架构、项目/会话、活动、模型、Goal / Plan、回溯和审查交互。
- shadcn/ui：可控的基础组件代码分发。
- Vercel AI Elements：只在许可证审查后选择性参考流式消息和工具组件。
- NovelX 自研：引用、图谱、图片、Change Set、冲突、版本、玩家卡片和领域编辑器。

### 3.7 正式上游审计清单

oh-my-pi 只审计以下范围，避免重复读取整仓：

- `packages/agent/src/agent-loop.ts`
- `packages/agent/src/compaction`
- `packages/coding-agent/src/task`
- `packages/coding-agent/src/session`
- `packages/coding-agent/src/modes/rpc`
- `packages/mnemopi`
- `packages/ai`
- Rust 原生读取、搜索和 Token 计算工具

每个模块的审计记录必须回答：

1. 哪些代码可在许可证和依赖允许时直接复用；
2. 哪些只能参考设计；
3. 哪些编码 Agent 假设与 NovelX 冲突；
4. 哪些状态必须继续由 Rust Runtime V2 权威持有。

Codex CLI 重点审计 app-server / protocol、Run 生命周期、compaction、tool policy、approval、cancel、recovery 和 event projection。Pi Agent 重点记录当前 `@earendil-works/pi-agent-core@0.80.6` / `pi-ai@0.80.6` 调用链与迁移覆盖率。webnovel-write 重点审计项目结构、章节工作流、连续性检查和可迁移创作工具；在重新核验其许可证、依赖和源码版本前，只能记录设计参考，不能复制代码。

所有引入均需建立 upstream manifest：仓库 URL、固定 commit、许可证、拷贝/改写文件、适配层、NovelX 合规测试和升级策略。上游宣传的性能数字不能作为 NovelX 验收结果。

## 4. 把编码 Harness 映射成小说编辑台

| 通用/编码 Agent 能力 | NovelX 等量能力 | 权威数据 |
| --- | --- | --- |
| Filesystem read/list | 读取项目、资源树、来源库、文档、图片元数据 | Source / Resource / Document |
| glob / grep / search | 文件搜索、全文检索、实体检索、图谱邻域、时间线查询 | Search Index + Graph Projection |
| Git commit | 创作 Checkpoint：正文、设定、关系、资产的一次解释性变更 | Version Journal |
| Git branch | 世界方案、故事路线、会话路线、玩家流程分支 | Branch aggregates |
| diff / patch | 段落、字段、关系、事件和资产的 Change Set | Domain Change Set |
| merge conflict | Canon / 关系 / 时间线 / 玩家存档语义冲突 | Conflict objects |
| blame / history | 来源、作者、会话、Agent、版本与引用追踪 | Provenance graph |
| compiler / LSP | Checker：规则、连续性、引用、风格和结构检查 | Validation results |
| tests / evals | 世界规则测试、角色一致性、伏笔、GM/Writer 职责 Eval | Evidence artifacts |
| build | 构建世界包、Story Profile、发布配置和移动端包 | Package manifest |
| preview / artifact | 可视书、正文、图片、角色卡、地图和图谱联合预览 | Artifact Store |
| task / sub-agent | 大管家委派 Writer、Checker、GM、Decomposer、Image Agent | Assignment aggregate |
| context providers | 文档、图谱、Canon、会话、玩家状态的按需上下文 | Context receipts |
| terminal / plugin | 受能力声明和项目边界限制的扩展工具 | Capability registry |

实际 Git 可用于源码开发、导出包或纯文本互操作，但产品内版本权威应是领域事件和内容寻址资产。否则图片、关系、数据库对象、玩家状态和部分接受无法自然表达。

## 5. Runtime V2 内核

### 5.1 权威聚合

- `Run`：一次有界执行及其终态。
- `Goal`：跨 Run 的长期意图、范围和验收标准。
- `Plan`：版本化步骤、依赖、Agent 和证据。
- `Assignment`：父 Agent 给子 Agent 的有界授权。
- `AgentLoop`：模型请求、工具请求、上下文编译和续跑阶段。
- `ProviderAttempt`：每次外部模型调用的身份和副作用边界。
- `ToolCoordination`：工具授权、租约、运行和终态清单。
- `RecoveryOperation`：启动或运行中恢复的一次可幂等操作。

聚合使用 append-only journal（追加式日志）、哈希链和严格重放。命令使用语义幂等键。客户端不能提供可伪造的 child/root 身份、权限或完成状态。

### 5.2 结构恢复与运行恢复

1. `StructuralRecoveryBarrier` 在 `runtime.ready` 前完成，只读回放、pin 校验、孤儿检测和隔离，不调用 Provider。
2. `OperationalRecoveryBarrier` 在精确 Provider bind 后运行，先消费持久终态证据，再决定是否安全继续。
3. 已发送但结果未知的 Provider 或工具进入 Outcome Unknown / reconciliation_required，禁止自动重派。
4. Runtime 重启不凭“Run 还没结束”猜测下一步；必须恢复 AgentLoop phase、持久 intent、Provider Attempt、Tool manifest 和权限租约。

### 5.3 工具系统

每个工具声明：输入 Schema、输出 Schema、读写范围、副作用类别、权限要求、超时、重试策略、版本前置条件、Artifact 类型和审计脱敏规则。确定性流程——分块游标、工具配对、重试、状态推进、写入事务——由 Runtime 调度，模型只做理解和生成。

首批通用项目工具：目录列表、元数据、分块读取、全文搜索、glob、引用定位、任务笔记。领域工具：资源/文档查询、关系查询、图谱邻域、Canon 查询、Change Set 提交、图片任务、故事配置、玩家回合。底层文件访问可以存在，但默认通过项目范围和权限控制，不向 Renderer 暴露任意 Node/Shell。

### 5.4 Provider 与模型路由

Provider Registry 保存公开能力；凭据由 Electron Main 的系统安全存储管理，Runtime 只接收短期授权或受控调用通道。模型配置包含上下文、最大输出、工具/视觉能力、推理模式、价格/预算和角色适配。文本、图片、嵌入和重排分别建模。

`ping` 使用轻量上下文；正式 Run 通过 Token 估算器计算系统、工具、历史、检索和输出预算。中文不能使用 UTF-8 字节数直接冒充 Token 数。

## 6. Domain Runtime

### 6.1 数据层级

```text
Raw Source（不可变来源）
  -> Resource / Document working version
  -> Candidate Assertion / Relation
  -> Checker decision / user approval
  -> Canonical Assertion / Story Canon
  -> Search / Graph / Timeline projection
```

关系和断言包含 `scope`、`source locator`、`source version`、`valid time`、`recorded time`、`status` 和 `supersedes/conflicts`。文档保留完整语义，结构化投影可重建。

### 6.2 记忆分区

- Agent 私有任务记忆：仅服务一个 Assignment / Session。
- 项目共享记忆：来源链接、可被多个会话检索，但不是正史。
- 候选事实：模型提取结果，等待 Checker / 用户。
- Canon：项目或世界范围的权威断言。
- Story Canon：具体故事范围内的有效事实。
- Player Knowledge：玩家角色在某个回合已知的信息。

mnemopi 或其他向量/图记忆只进入候选层。正式检索根据任务和 Lens 组合全文、结构、图邻域、时间和语义召回，并返回 receipt（凭证）。

### 6.3 版本引擎

Version Journal 记录领域操作，而非每次复制整个 SQLite。文本使用版本和增量/内容哈希；大文件和图片存 Artifact Store；关系与断言使用事件；检查点保存各聚合头的 manifest。恢复旧状态产生新头或分支。项目写入以 workspace queue、资源锁和 expected version 串行提交。

### 6.4 GM / Writer / Checker

```text
Player Action
  -> Context receipt（固定世界/故事/OC/玩家知识）
  -> real GM Provider -> immutable gmResolution
  -> real Writer Provider -> prose only
  -> Validator -> responsibility/source/leak checks
  -> commit play turn + public state + artifacts
```

没有真实 Provider 或上下文证据不完整时 fail closed。Writer 不能新增成败、伤害、奖励、线索或 NPC 决策；Checker 不补剧情。

## 7. Context 与 Compaction

### 7.1 Context Packet

每次 Provider 请求保存上下文清单、来源版本、Token 预算、检索 receipt、Prompt 版本、工具协议版本和 canonical hash。支持范围选择：轻量 ping、当前文档、当前资源、当前故事、玩家回合、显式全项目研究。

### 7.2 压缩产物

借鉴 oh-my-pi 的 Tool Protection、Branch Summary、Compaction Summary、Handoff Document 和 File Operation Summary，但由 Runtime 保存结构化状态：

- ToolCall / ToolResult 对；
- Goal / Plan / Assignment 当前修订；
- 未完成审批与 Change Set；
- 来源和检索凭证；
- Canon / Story Canon / 冲突警告；
- 任务已完成、未完成、下一步和恢复游标。

摘要不能取代原始来源；未来 Agent 使用摘要定位需要重读的文档。连续压缩必须通过协议配对、来源保持和重启恢复测试。

## 8. 多 Agent 调度

```text
Steward
  -> create durable Assignment
  -> preallocate child Run identity
  -> pin Goal/Plan/scope/checkpoint/budget/permission
  -> start real Provider
  -> receive typed Artifact
  -> Validator checks evidence and boundaries
  -> Steward accepts/rejects
  -> serialize Change Set commit
```

第一稳定版最大深度 1；以后是否递归由压力测试和产品价值决定。Agent 间通过 Handoff、Artifact 和 Shared Memory 通信，不隐式读取其他会话完整聊天。所谓群聊未来只是多个结构化贡献的 UI 投影。

## 9. Electron 与 UI 边界

- Renderer 不访问 Node、路径、密钥、Prompt、原始 Pi/Codex 事件或内部数据库 ID。
- Preload 暴露 versioned allowlist；Main 做输入校验、工作区绑定、安全存储、进程监督和受管资产协议。
- Runtime 通过 RPC 发布：会话流、Goal、Plan、Assignment、ToolCall、Artifact、Change Set、引用、冲突、恢复与 Provider 状态。
- UI 的 Agent / IDE / Player / Showcase 使用同一事件模型，但各自 allowlist 不同。
- 大图、长文档、图谱和活动使用分页、虚拟化、增量投影；不在 React 中重建权威业务状态。

## 10. 图片与资产架构

Image Request 先解析为来源绑定的 `ImageJobSpec`：用途、目标资源、来源版本、视觉身份、风格、尺寸、预算和 Provider profile。队列持久化后才能调用外部 Provider；发送边界使用稳定 attempt identity。响应先进入 Artifact Store，再校验格式、尺寸、哈希和来源 manifest，最后发布 Asset。

来源版本改变时，Reconciler 将资产标记 stale；不会静默显示为最新。Player 只选择 purpose=scene、status=ready 且直接绑定当前故事/场景的图片。图片 Provider 失败不阻塞纯文本阅读，但不能显示占位图作为生成结果。

## 11. 导入与世界包

导入采用只读 Source Scanner → 分块 Parser → Decomposer candidates → 来源定位 → Checker → 用户确认 → Domain resources。所有阶段可恢复并报告覆盖范围。世界包导出使用 manifest、资源版本、许可证、来源、Creator/Player 可见策略和 Publish Profile；移动端同步使用包/事件协议，不直接复制桌面数据库。

## 12. 测试与验收体系

| 层 | 必测内容 |
| --- | --- |
| Aggregate | 重放、哈希、幂等、非法状态、终态不变性 |
| Repository | 事务、迁移、并发、版本前置条件、恢复 |
| Provider | 真实配置、零副作用失败、限流、超时、取消、outcome unknown |
| Tool | 参数、权限、路径、超时、重试、结果配对、崩溃恢复 |
| Context | Token 单位、分块、连续压缩、来源保持、轻量 ping |
| Domain | 候选/正史隔离、冲突、Lens、版本、玩家固定基线 |
| Agent | 真实 Steward/Writer/Checker/GM、职责越权、来源和 Artifact |
| Electron | 启动、退出、IPC、Worker、更新、无残留测试窗口 |
| UI | 真实接入、阻塞/错误、可访问性、1440×900 与关键视觉 |
| Release | 安装、非 C 盘、升级保留配置、回滚、崩溃恢复 |

Mock / Fixture 只证明协议和 UI。真实 Live 验收必须记录 Provider profile（脱敏）、请求数、Artifact、来源、错误路径和测试日期。

## 13. 迁移顺序

1. 以 A2.2 冻结点为长期分支起点，先恢复未完成的 durable recovery 和权限债务。
2. 完成 Runtime 的通用工具、Context、Compaction、Task / Assignment 和 RPC，而不是同时新增大量领域工具。
3. 专项审计 oh-my-pi；每个引入模块放在 adapter 后并通过 NovelX conformance tests。
4. 建立记忆候选层、来源和 Canon 管线。
5. 迁移 Steward、Writer、Checker、GM 到同一 Runtime；删除对应旧路径。
6. 接回桌面 Goal / Plan、模型、回溯、批注、图谱、图片和 Player。
7. 完成长文档、多 Agent、断网、强杀、冲突和安装升级压力验收。
8. 再进入世界包、Android 同步、市场和插件生态。

每一步使用 strangler（绞杀式迁移）：新链达到真实对等证据后，切换一个能力并删除旧入口。禁止永久兼容垫片和双写权威状态。

## 14. 架构决策停止条件

遇到以下情况必须由产品负责人决定，架构会话不能代替用户猜测：改变 Free / Assist 语义；改变 Canon/故事/玩家范围；不可逆数据迁移；允许插件执行代码；改变世界包版权/公开策略；把手机端纳入同一仓库；更换 Electron/Rust/SQLite 主路线；用功能缩水换取“Live”声明。

其余局部命名、文件摆放、纯内部实现和不改变语义的性能优化，可以由执行会话在任务边界内完成并提交证据。
