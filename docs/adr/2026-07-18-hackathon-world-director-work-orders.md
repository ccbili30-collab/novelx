# ADR：黑客松 World Director 与 Work Order 架构

日期：2026-07-18

状态：已接受为黑客松设计；实现尚未开始

## 上下文

现有 Growth（生长流程）已经证明真实文本 Provider（模型服务）、Change Set（变更集）、图片队列、Closure（闭合验收）和展示链可以协作，但同一个模型同时承担全局选题、专业创作、证据提取、事实检查、工具协议和提交结构时，会把推理预算消耗在操作细节上，并产生互相孤立的设定卡片。

黑客松 P0 需要一个可持续生长的大世界创作链：用户可以从世界、OC（原创角色）、故事或长文开始；系统按因果前沿选择下一项工作；独立候选可以并发；依赖候选等待前置提交；正式文本、断言和因果关系仍通过一个原子 Change Set 串行写入。

本决策必须同时服从以下既有边界：

- Steward（大管家）仍是产品级操作 Harness（智能体运行框架），拥有 Provider、工具、取消、恢复、权限、审计和持久化执行权。
- Rust Runtime V2（第二版运行时）A2.2、Canon（正史）权威、Free / Assist、Creator / Player Lens（创作者/玩家视角）和公开协议不因黑客松改变。
- Renderer（渲染层）只能投影权威状态，不能从模型文本推断完成、权限或提交结果。
- 文档、Canonical Assertion（权威断言）和图谱投影继续分层；模型置信度和普通共现不能自动升级为因果或 Canon。
- 本 ADR 不授权 Schema（数据结构）迁移。后续 Task 5 的纯加法 SQLite v28 仍须按计划单独实现和验证。

## 决策

### Growth 内的单一编辑职能门面

World Director（世界总编）是 Steward 控制下、仅限 Growth 模式的用户可见编辑职能门面。用户在 Growth 中与 Director 讨论生长方向和创作者取舍；离开 Growth 后，Steward 仍是 NovelX 的产品主入口。

Director 只做编辑判断：读取 Main（主进程）编译的 pinned checkpoint（固定检查点）、规则修订、Closure 空白、因果前沿和最近提交；选择下一条高价值前沿；创建有界 Editorial Round（编辑轮次）和 Work Order（创作工单）；审核候选；要求原所有者返工；决定候选进入提交队列或需要询问用户。

Director 不写最终正文，不直接调用项目工具，不接收 Provider 凭据，不构造低层 Change Set，不写数据库，不提交 Canon，也不直接调用图片 Provider。

### 职责与权威

| 角色 | 负责 | 明确不负责 |
| --- | --- | --- |
| World Director | 全局编辑计划、依赖、验收维度、编辑审核、创作者取舍 | Provider、工具、数据库、Change Set 构造、Canon 写入、最终正文 |
| Steward / Main | 检索、Provider 与工具调用、权限、持久化、取消、恢复、串行提交、图片队列 | 替代 Director 做文学方向判断，或在无候选证据时创造内容 |
| 专业作者 | 根据有界证据包生成严格候选 Artifact（产物） | 直接写 Domain（领域层）、扩大 scope、选择任意工具或角色 |
| Graph Curator（图谱书记官） | 从候选中提取带来源的事实与因果候选，标注机制、条件、时间和认识状态 | 决定 Canon、补写缺失正文、直接修改图谱或数据库 |
| Checker（检查者） | 检查事实冲突、因果不自洽、来源不足和验收维度不足 | 替代原作者重写，或自行提交 Canon |
| Domain code | 校验对象类型、关系端点、来源、版本、因果政策和事务原子性 | 接受 Prompt 约定代替可执行规则 |
| Renderer | 展示安全摘要、工单进度、已提交对象、图谱和图片队列 | 展示私密思维链、Prompt、凭据、原始工具参数或提前声称完成 |

### 固定黑客松能力注册表

注册表由代码拥有并版本化。Director 只能选择以下 capability ID（能力标识）并提供有界目标，不能提供 Prompt 文本、Provider URL、凭据、任意工具列表或新角色 ID：

- `world_director`
- `world_system_author`
- `geography_ecology_author`
- `civilization_author`
- `organization_author`
- `species_culture_author`
- `character_author`
- `story_architect`
- `writer`
- `general_setting_author`
- `graph_curator`
- `visual_director`
- `checker`
- `gm`
- `decomposer`

除现有 GM 和 Decomposer 独立运行时外，黑客松新增编辑角色默认为 tool-light（轻工具）：只接收 Main 编译的证据包并返回严格结构候选。

固定注册表是黑客松范围控制，不是长期产品对动态职业的否定。赛后若要允许用户或插件新增能力，必须另行决定 Prompt 发布、能力签名、权限、工具 allowlist（允许列表）、版本兼容和市场安全；本实现不得预埋可绕过注册表的动态字符串入口。

### Work Order 与所有权

每个 Work Order 固定：能力所有者、目标、scope refs（范围引用）、来源 checkpoint、验收 facets（维度）、依赖、尝试序号和稳定幂等身份。

候选被拒绝时，不创建一个无关新任务，也不随机换角色。原 capability 和原 Work Order 保持所有权，新建下一 attempt（尝试），附带有界审核反馈。这样保留责任、上下文和返工谱系，并允许通过最大尝试数和 no-progress（无进展）检测停止循环。

只有以下情况可以离开原工单：Director 判定问题实际属于另一种能力，并创建具有显式依赖的新 Work Order；需要创作者作出真实产品/世界选择；或 Harness 因安全、权限、取消、结果未知而终止当前执行。不得用换角色掩盖原作者持续失败。

### 并发与串行提交

Main 将 Editorial Round 编译成无环 dependency DAG（依赖有向无环图）。从同一个 pinned checkpoint 出发且没有依赖的只读候选可以在预算内并发生成；依赖工单必须等待前置候选完成审核并正式提交，然后从新 checkpoint 重新检索。

候选并发不等于多写者 Canon：

1. 专业作者只生成零 Domain 副作用的候选 Artifact。
2. Graph Curator 提取来源绑定的断言和因果候选。
3. 确定性 Domain code 校验因果方向、机制、条件、时间、来源和认识状态。
4. Checker 与 Director 分别审核事实和编辑价值。
5. 接受的候选在进入提交队列前针对最新 checkpoint 重新检索和 rebase（重定基线）。
6. 每次只允许一个原子 Change Set 提交文本、断言和因果关系；下一项工作读取新 checkpoint。

图片是文本提交后的异步消费者。稳定文本提交后，Visual Director 生成来源绑定的 Visual Brief（视觉简报），Main 持久化图片队列项；文本 Growth 不等待图片完成。失败图片保留 `actualContent=false`，不能冒充真实内容。

### 失败、取消与恢复

所有外部执行使用持久身份、attempt 和 side-effect state（副作用状态）。错误必须保留责任边界，不能统一包装成笼统失败。

- Provider 请求发送前失败：工单可按明确 policy（策略）在同一 attempt 边界内纠正，或生成下一 attempt；不得伪造候选。
- Provider 已发送且结果未知：标记 `outcome_unknown` / `reconciliation_required`，不得自动再次调用或创建第二份候选。
- 候选协议错误且确定无副作用：允许有界模型纠正；超过上限后工单失败或返回 Director，不无限循环。
- Checker 或 Director 拒绝：回到同一所有者的新 attempt，保留原候选、审核和反馈谱系。
- 用户取消：停止尚未发送的工作；已发送的 Provider/工具按结果已知性进入 cancelled 或 reconciliation，不伪装撤回外部副作用。
- 依赖失败：下游工单保持 blocked，不得在缺少前置事实时降级生成。
- Change Set 提交开始后失败：依据现有事务与结果未知规则恢复；不得重提第二份 Change Set。
- 进程重启：从持久 Editorial Round、Work Order、attempt、review、checkpoint 和队列状态重放；只恢复安全步骤，不重复 Provider 调用或 Canon 写入。

恢复时以持久化事实为权威，模型消息和 Renderer 状态均不能宣告工单完成。缺少 checkpoint、来源、owner、终态或 side-effect state 时失败关闭。

### 目标执行流

```text
User guidance
  -> Main compiles Director packet from a pinned checkpoint
  -> Director proposes one bounded Editorial Round + dependency DAG
  -> Main validates fixed capabilities, scopes and dependencies
  -> ready Work Orders invoke specialist Providers
  -> candidate Artifact (zero Domain side effect)
  -> Graph Curator candidate
  -> deterministic Domain/causal validation
  -> Checker review
  -> Director review
       revise -> same Work Order owner, next attempt
       ask_user -> durable creator-choice boundary
       accept -> serialized commit queue
  -> rebase against latest checkpoint
  -> one atomic Change Set
  -> new checkpoint
  -> asynchronous Visual Brief and image queue
  -> next causal frontier
```

## 非功能要求

- 可靠性：崩溃、取消和结果未知不得重复 Provider 调用、收费或 Change Set。
- 可维护性：Director、scheduler（调度器）、specialist（专业员工）、Graph Curator 和 causal Domain（因果领域）各有短 README 与定向测试；阶段私有数据不继续膨胀共享协议。
- 性能：只读独立候选可受控并发；依赖和 Canon 写入保持确定顺序；图片队列不阻塞文本。
- 安全：Renderer 和模型不接触凭据、原始数据库身份、任意工具或 Player Lens 隐藏事实。
- 成本：上下文由 Main 从固定 checkpoint 编译有界证据包，不向每个角色注入整个项目。
- 可观测性：失败码能定位 Provider、候选协议、Work Order 状态、因果 Domain、审核、持久化或 reconciliation（对账）边界。

## 后果

### 正面

- 一个编辑权威保持世界整体方向，专业作者把推理预算用于创作而不是工具协议。
- 因果候选经过来源提取、独立检查和 Domain 校验，不依赖单模型自证。
- 候选并发缩短等待时间，同时串行 Change Set 保持 Canon 顺序和可恢复性。
- 同所有者返工保留责任和反馈谱系，便于检测无进展循环。
- 固定注册表缩小黑客松权限面和测试组合。

### 负面

- 一项候选经过作者、Curator、Checker 和 Director，多次 Provider 调用会增加延迟与成本。
- Director 可能成为编辑吞吐瓶颈；P0 接受单一编辑权威，依靠有界轮次、并发候选和紧凑 packet 控制成本。
- 固定注册表无法覆盖所有未来创作职业；黑客松期间使用 `general_setting_author` 作为受限兜底，赛后再评估安全扩展机制。
- 串行提交限制写入吞吐，但这是避免 Canon 竞态和语义自动合并的有意取舍。
- 持久化工单、attempt 和审核会增加 SQLite 表与恢复测试数量；Task 5/6 必须证明纯加法迁移、幂等和重放。

### 中性

- Steward 仍是操作权威，但 Growth UI 会把 Director 编辑活动放在主视图，把 Steward 操作细节放在可展开审计区。
- Graph Curator 的输出只是候选；正式图谱增长仍由 Change Set 与 Domain policy 决定。
- 本 ADR 只决定职责和流程，不决定 Prompt 文案、表字段或 UI 动画。

## 替代方案

### 一个模型同时担任 Director、作者、Checker 和工具执行者

拒绝。它减少调用次数，但把编辑、创作、事实审核和协议权威混在一次输出中，无法提供独立检查，也会继续扩大顶层状态机和共享协议。

### 专业作者各自决定全局方向并直接提交

拒绝。独立作者缺少全局因果优先级，多个写者会竞争 Canon，必须引入语义自动合并或覆盖，违反现有 Change Set 和恢复不变量。

### Director 直接写正文和 Change Set

拒绝。这样 Director 会重新承担 schema、工具和事务细节，既削弱编辑判断，也允许模型绕过确定性编译与 Domain 校验。

### 每次拒绝后换一个新角色或新任务

拒绝。它丢失责任和反馈谱系，容易以角色轮换制造无进展循环。只有明确能力错配时才创建新的依赖工单。

### 黑客松直接支持动态职业和插件角色

拒绝为 P0。它需要新的 Prompt、能力签名、权限、工具和兼容协议决策，会扩大安全面并越过当前授权。固定注册表保留明确的赛后迁移债务。

## 实现与证据边界

本 ADR 是已批准产品决策的设计记录，不是实现或 Live（真实运行）完成证据。Task 3 完成时仍然不存在可宣称完成的 World Director、Work Order repository（工单仓储）、因果图谱、并行 scheduler、SQLite v28 或最终双 Provider 世界包。

后续实现必须按计划逐项提供严格合同、迁移、重放、并发、取消、结果未知、Renderer 安全投影和真实 Provider 验收。任何需要改变公开协议、Canon、权限、Player Lens、数据兼容性或 Runtime V2 A2.2 的实现都必须停止并请求产品决策。

## 参考

- `docs/product/novelx-desktop-product-requirements.md`
- `docs/architecture/novelx-desktop-long-term-architecture.md`
- `docs/plans/2026-07-18-world-director-causal-growth-p0.md`
- `docs/adr/2026-07-16-hackathon-interactive-growth-and-illustration.md`
- `docs/project/current-state-and-routes.md`
