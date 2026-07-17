# ADR：交互式 Growth 与插图持久化合同

日期：2026-07-16

状态：产品负责人和 Main Head（主线负责人）已接受决策门禁；v24 持久化与 Task 3 动态 Intent 路由已实现并通过定向验收。Task 4A 的 schema 25、Inquiry 生命周期合同和唯一 `GrowthRepository` 持久化权威已实现；Task 4B 的同 Cycle Worker/Main 工具链、dynamic-v3 升版、Main 一次性副作用门禁与 Renderer 安全摘要投影也已实现并通过定向验收。Creator Choice（创作者取舍）的自由文本回答及后续 Rule Revision（规则修订）确定性执行链已接通。Task 5 已接入确定性的 Closure evaluation 与受信任单 finding repair Worker/Main/Domain 路径，并能由 Coordinator 自动创建 evaluation Cycle；repair→recheck→accepted 跨组件回归已通过。Longform（长文）的自动 `outline → section → recheck` 确定性编排也已接通；当前 Revision/Longform 的真实 Provider 验收、通用插图队列和最终视觉闭环仍未完成。

## 决策范围

黑客松分支将 SQLite Schema v23（第 23 版数据库模式）纯加法升级为 v24，为后续 Harness（智能体运行框架）持久化以下元数据：

- 动态 Growth Cycle Intent（生长循环意图）及有序 focus/frontier；
- Evidence-grounded Inquiry（证据化自询）批次、问题、唯一选择与 Retrieval Receipt（检索凭证）证据链接；
- 稳定 Closure Profile（闭环档案）、仅追加 revision/epoch、Steward（大管家）与 Checker（检查者）独立评估、闭环审查和规范化 finding；
- 无总量上限、内部最多 20 项一批的 Illustration Request（插图请求）、恢复批次、严格来源锚点、不可变文本快照和现有 Image Job（图片任务）绑定。

本层不运行模型、不编译 Prompt（提示词）、不生成图片、不提交 Change Set（变更集），也不决定 Canon（正典）。它只验证并保存后续执行层恢复所需的已授权元数据。

## Cycle 与 Intent

v24 新建 Cycle 必须通过同一个 `BEGIN IMMEDIATE` 事务同时写入 `growth_cycles`、`growth_cycle_intents` 及其有序子表。Intent 不复制 Cycle 已固定的规则 revision；`growth_cycles.rule_revision` 仍是唯一权威。`growth_cycles_one_open_goal_idx` 以部分唯一索引保证每个 Goal 同时最多一个 `planned/running` Cycle，仓储前置检查只用于返回稳定错误码，不代替数据库约束。

Task 3 已接管 Coordinator 调用点：`beginCycle` 对所有新调用强制要求显式 Intent，不再按 sequence 生成新 Cycle fallback。旧 v23 行仍只允许通过 `legacy_v23_projection` 查询投影读取，不回填、不再增加兼容层。缺少 Intent 的行只有在其持久化 `payload_hash` 精确等于旧版“不含 Intent 的 begin payload”规范哈希时才有资格投影；新 v24 Cycle 若 Intent 行损坏或丢失，必须以 `GROWTH_CYCLE_INTENT_REQUIRED` 失败关闭。

`cycle_planned` 事件仍由现有事件 API 在事务提交之后发布，因此崩溃只能留下“已持久化、尚未发布”的可恢复状态，不能留下孤立事件。

从 v23 升级时不回填 Intent。读取通过旧 payload hash 证明身份且缺少 Intent 的历史 Cycle 时，只按 sequence 1/2/3 投影为 `world → story → oc` 的 `legacy_v23_projection`；该投影不会写回数据库。无法证明旧身份或无法映射 sequence 时失败关闭，不伪造历史。

## 动态 Frontier 路由

Coordinator 不再使用 sequence 推导 `world/story/oc` phase，也不再在第三轮后宣告完成。每个新 Expand Cycle 从仓储读取单焦点 Intent；剩余有序方向保存在 `resumeFrontier`，下一 committed checkpoint 到达后再计划恰好一个 Cycle。Worker binding 只接收 Main 从持久 Intent 投影的 `kind/focusKinds/resumeFrontier`；Lifecycle 对多焦点 Expand 或提前出现的 Revision Intent 在 Worker 和 Change Set 前失败关闭。

由于 Worker binding 形状与公开 Coordinator 状态均不兼容于旧固定三轮语义，本路由使用 `hackathon-growth-dynamic-v2` capability 与 `grow_world_story_oc_dynamic_v2` strategy。旧 v1 标识不接受新 payload，也不以兼容垫片静默升级；数据库仍为加法 Schema v24，不因 IPC/Worker 能力版本变更而改写持久数据。

正式 world/story/oc 资源种子按已有类型进行保守路由：world 先向 story/oc 生长，story 先反推 world 再进入 oc，oc 先进入 story 再反推 world。纯文本种子不在 Main 中做关键词或语义猜测，只采用 `world → story → oc` 的保守初始前沿；Task 4 才通过 pinned checkpoint 图检索和持久 Inquiry 提供证据化 Seed Analysis。

规则指导只追加单调 Rule Revision 并返回候选 `revision` Intent 摘要，不修改正在执行的 Cycle。当前 Cycle 固定旧 revision；安全终态后 Coordinator 重读 Goal 并为最新未应用 revision 创建恰好一个 Revision Cycle。没有 active Worker 时公开状态为 `awaiting_guidance`，不冒充 `running`、`completed` 或失败。`growth.get` 会重新注册当前 project/session 的安全事件 route，并在 committed 崩溃边界幂等推进；同一边界不会创建重复 Worker。

## Rule Revision 执行

Revision Cycle 固定最新 Rule Revision、input checkpoint、授权 scope 和重新检索产生的 Receipt。Main 从 pinned graph hits 解析可修改的 resource、document、assertion 与 relation 身份，并把该 authority 作为 Main→Worker 内部 binding 传递；模型可见检索结果会移除 authority、checkpoint、branch、scope、locator 与哈希。

Worker 的 Revision phase 固定执行 `retrieve_graph_evidence → submit_growth_inquiry → propose_change_set`。模型提交严格的 Impact Brief（影响简报）与高层 Fragment：每个 evidence 只能标为 `revise`、`preserve` 或 `stale_visual`，新增对象必须显式列出类型和原因。模型只写标题、正文、事实和关系选择；ID、owner、parent、依赖、来源和 Change Set 拓扑由编译器生成。`preserve` 对象不能出现在 mutation items 中；新增项和影响简报必须逐项匹配。

Main 在真实 Change Set executor 前再次依据同一 Receipt authority 校验低层提案，拒绝模型或 Worker 伪造的对象类型、owner、parent、关系端点或越权版本。每个 Revision Cycle 仍最多执行一个 Change Set；调用开始后的失败或结果未知不得重提，沿用现有 reconciliation 屏障。提交成功后，只有来源版本被 `revise` 或 `stale_visual` 命中的 Illustration Item 才标为 stale，无关 Asset 保持原状态。

Renderer 只投影持久化回执和安全事件，区分“规则已保存、等待安全边界、正在分析、Change Set 已提交”；不展示原始思维链或在提交前声称世界已修改。该实现已通过 11 个定向 Vitest 文件 146/146、typecheck、Prompt publication gate 与 diff check；尚未运行当前 Revision 实现的真实 Provider、Electron 或全量测试，因此不是交互式 Growth Live 完成证据。

## Inquiry

每个 Cycle 最多一个 Inquiry Batch（自询批次）。仓储从 Cycle 推导并固定 Receipt、checkpoint 与 rule revision，调用方不能另行覆盖。一个事务完成 3–7 个问题、证据链接、选择与封存；除非 Cycle 已因创作者价值取舍进入 `blocked`，否则封存时必须恰好选择一个问题。

证据引用不是无类型 JSON。`growth_inquiry_evidence_links` 使用 `(receipt_id, rank)` 外键指向真实 Receipt 命中，并通过批次复合外键阻止跨 Receipt 混用。`idempotency_key + payload_hash` 只允许精确重放；相同键、不同负载失败关闭并回滚整个批次。

Task 4 不另建 Inquiry Repository。Schema v25 继续由 `GrowthRepository` 作为唯一权威，并为 v24 Batch 增加显式 `legacy_v24` contract 标记；新 v25 Batch 必须具有完整逐问题 detail、append-only 生命周期、Creator Answer 与 Rule Revision 关联。缺少 contract 标记或 v25 子行不完整视为损坏，不得按 legacy 猜测或回填假 action/assumption。

逐问题 detail 保存 `requiresCreatorChoice`、nullable provisional assumption 和非空 proposed action。普通 Batch 恰好一个 selected，其余为 backlog；阻塞 Batch 恰好一个具体问题为 `creator_choice_required`、没有 selected，其余为 backlog。普通 unknown 必须有 provisional assumption，但该假设不是 Canon。`promoted` 显式链接后续 Cycle/Inquiry；`answered/closed` 必须绑定新 checkpoint 与新 Receipt，不能从 Change Set committed 直接推断。

用户取舍采用自由文本指导，不强制固定选项。一条 Rule Revision 只能回答一个阻塞 Inquiry，双方唯一；Rule Revision、answer link 与内部 `creator_answered` 生命周期转换在同一个 `BEGIN IMMEDIATE` 和同一 CAS 中提交。`creator_answered` 绑定原阻塞 Inquiry 的 pinned checkpoint/Receipt 与新 rule revision，只证明创作者已选择；新 Cycle 应用规则并取得不同的新 checkpoint/Receipt 后，才可写证据意义上的 `answered/closed`。blocked Batch、具体问题、Cycle/Goal blocked 状态与安全事件同事务完成，禁止出现“已阻塞但不知道等待哪个问题”的中间事实。

Task 4 增加 `inquiry_selected` / `creator_choice_required` 安全事件，使用 event 专用 `inquiry` target。事件仅从持久 Inquiry 事实投影 allowlisted `safeSummary`，`contentRef=null`，不包含 question draft、proposed action、assumption、Prompt、token 或原始思维链。新事件 persist first、publish second，重启可确定性补后缀。为保持单一事件权威，v25 明确允许在单事务中 copy-and-swap `growth_events`，只扩大 phase/target CHECK；迁移必须证明旧行逐字段与数量不变、索引/外键保持、`foreign_key_check` 通过、故障回滚且重复打开幂等。它是语义加法，不是物理上的仅新增表。

Inquiry 工具链使用 `hackathon-growth-inquiry-v3` capability 与 `grow_world_story_oc_inquiry_v3` strategy。旧 v24 数据可无损前向升级并明确投影为 legacy；不承诺旧 v24 二进制打开 schema 25，旧程序必须失败关闭。真实执行顺序固定为 pinned retrieve → `submit_growth_inquiry` → 正常唯一 selected 后一个既有 Fragment/Change Set，或具体 creator choice blocked 且零 Change Set。Creator answer 的实际内容修订归 Task 6，Closure/Checker 归 Task 5。

Task 4B 的定向实现还固定了以下运行时边界：Main 从当前 Retrieval Receipt 精确解析 evidence ID 到局部 rank，统一规范化问题后生成正式 Inquiry ID 和 fingerprint；模型不能提交这些权威字段。新 Batch 与旧 Inquiry 的显式生命周期迁移在同一事务内提交，不会因“本轮未出现”而自动关闭旧问题。Main 在真实 `propose_change_set` 和世界地图执行器前占用 one-shot（一次性）状态，调用一旦开始，即使失败或结果未知也不允许恶意 Worker 重复产生正式副作用。相同 Inquiry 请求的同 Run 响应丢失可以精确重放，负载不同时失败关闭；运行中断后仍沿用现有 reconciliation（对账）屏障，不伪装跨进程恢复原 Run。

Task 4B 验收为 11 个定向 Vitest 文件 207/207 通过、`npm run typecheck` 通过、`npm run verify:prompt-publication` 通过（active Prompts=3）与 `git diff --check` 通过。本批没有运行真实 Provider、Electron/Playwright、生产构建或全量测试，因此只是 Inquiry Runtime（自询运行时）的定向闭环，不是完整 Growth Live 声明。

持久化内容仅含问题、安全摘要、known/conflicted/unknown 状态、候选行动、必要的临时假设、优先级、fingerprint、生命周期、Creator Answer 关联和证据位置；不保存原始思维链、Prompt 或 token stream。

## Closure

`growth_closure_profiles` 保存稳定 identity，`growth_closure_profile_revisions` 保存仅追加 revision/epoch。规则或来源变化创建新 revision，不更新旧 assessment、review 或 accepted 历史。`oc_saga` 必须绑定真实、在固定 checkpoint 可见的 OC 资源。

Steward 与 Checker assessment 分表内分角色追加，分别绑定作为评估对象载体的 evaluation Cycle、checkpoint、rule revision、Receipt、`agent_invocation_id` 与输出 SHA-256。assessment 只能在该 evaluation Cycle 为 `running`、已经从其 pinned input checkpoint 检索并绑定 Receipt 时追加；Receipt 自身 checkpoint、Cycle input checkpoint、Closure revision checkpoint 与 assessment checkpoint 必须完全相同。仓储使用现有 `agent_invocations.role`、同一 evaluation Run 关系及唯一终态 `agent_audit_events.output_sha256` 验证调用身份和真实输出；两份 assessment 必须来自同一 evaluation Run 中不同、角色匹配的终态 invocation。Review 只引用两份 assessment，finding 按 facet 和 `(receipt_id, rank)` 规范化，不能覆盖已接受历史。Task 1 只定义和验证这一可持久化状态，不宣称 post-commit Checker（提交后检查者）接线已经完成；Task 5 仍独占具体执行拓扑、调用顺序与 evaluation Cycle 的终态语义。

`contentState` 与 `visualState` 是查询投影，不是 Renderer（渲染层）可写结论。只有最新 revision 的独立 Checker 接受且所有必需内容 facet 满足时才 `closed`。视觉 ready 要求绑定到该 revision 的所有默认必需 Item 都为 `ready`；新 revision 或任何必需 Item `stale` 会重新进入 `growing/planning`，旧 accepted review 仍保持不可变。

Main Head 于 2026-07-16 以 `approve-with-conditions` 批准 Schema 26 与 Closure Contract v4。新 `closure_evaluation` Cycle Intent 必须绑定 Profile、revision 和 pinned checkpoint，不得借用 `expand/revision` 冒充。`evaluated` 是评估成功终态，要求非空 Run、Receipt 和 terminal time，且 Change Set、output checkpoint 与 failure code 均为空。它表示已得到确定、可恢复的 evaluation outcome，可承载 `continue_growing/accepted/repairs_required/blocked`，但不自动等于 Closure accepted 或 Goal completed。Provider/Checker 结果不明时仍进入 `reconciliation_required`。Cycle outcome 与 `evaluated` 在同一事务中提交；`cycle_evaluated` 安全事件使用 event-only `closure_evaluation` target、`durableState=evaluated`、`contentRef=null`，不扩张 Retrieval target。

Closure v4 必须持久化严格类型的 submission，不能只留 output hash。Facet Result 与 Checker adverse finding 分离：前者保存 `satisfied/missing/conflicted/blocked` 与 coverage/evidence；后者保存 severity、category、目标证据、safe summary、repair objective 与 Main 计算的稳定 fingerprint。`accepted` 要求所有必需 Facet Result 满足、Steward 为 `ready_for_checker`、Checker 通过且零 adverse finding。Repair Intent 必须绑定原 Review、一个选中 blocking finding/fingerprint 与 Repair Cycle，其他 finding 保持 backlog；重复 finding 或连续两个无进展 repair Cycle 进入 `GROWTH_CLOSURE_REPAIR_STALLED`。`mixed_birth` 显式保存用户要求的 component profiles；包含 `oc_saga` 时必须绑定 focus OC，不得从 facet ID 猜测。

实现收口（2026-07-16）：Schema 26 与上述持久化不变量已经落地；Review 本身不再驱动 `closed/blocked`，只有同事务封存并使 Cycle 进入 `evaluated` 的 durable outcome 才能驱动 Closure 状态。旧 `legacy_pre_v26` accepted Review 仅供历史读取，当前投影保持 `growing`。Repair 只有在绑定 Cycle 已原子提交 Change Set 后才能进入 `committed/no_progress`；`resolved` 还要求该输出 checkpoint 上的新 Closure revision 获得后续独立 accepted outcome。当前公开 capability/strategy 已升为 v4。`closure_evaluation` 已接入 Worker/Main/Domain：Main 固定 Profile、revision、rule revision、checkpoint 与同一 Retrieval Receipt，把 evaluator 选中的目标版本强制纳入该 Receipt；Steward 与 Checker 使用同一 Run 中角色匹配的不同 invocation，并以其终态输出 hash 持久化严格 submission、Review 与原子 outcome。完整结果进入 `evaluated`，部分持久化或结果不明进入 `reconciliation_required`，不伪造 accepted。Coordinator 现会在初始内容前沿结束后创建默认 mixed Profile 与独立 evaluation Cycle；`repairs_required` 只选择一个 blocking/major finding，Repair Run 只取得该 finding 的固定证据并只允许一个 Change Set，提交后创建新 Closure revision 与下一 evaluation Cycle。Repair 提案现在还必须在 Main 根据该 finding 的 Receipt 证据解析出的资源、文档、断言或关系边界内；已有资源、文档、断言、关系和约束档案必须由 `growthRepairTargetPolicy.ts` 从 pinned checkpoint 回查真实 type/objectKind/parent/owner/scope/identity，不能相信模型提交的换绑字段。缺失关系只允许在两个端点均由 finding 直接选中且 `creativeRelationPolicy.ts` 判定合法时于 Change Set executor 前放行。计划态恢复会先校验 durable lineage，缺失时失败关闭，已 stalled 时不会重启 Worker。无进展计数只统计同一规则修订下连续未进展尝试；若复检已消除原 fingerprint 而出现另一 finding，则前一 repair 记为进展并为新 finding 建立独立 lineage。跨组件回归已覆盖 `repairs_required → repair committed → revision 2 recheck → accepted`、替换 finding 继续返工、缺失/停滞 lineage 恢复失败关闭，以及相同 finding 复检后 `no_progress/stalled` 且不再启动 Worker。Longform 的纯编译边界已经固定为“稳定 outline 约束文档 + 有来源的 OC 个人故事绑定”和“每节一个稳定 prose 文档”；创作内容来自模型，编译器只生成结构权威与拓扑。Runtime 分段编排已完成确定性验收，真实 Provider 验收仍未完成，不能据此宣称模型正文质量或 Live 内容闭环。

Longform 补充边界（2026-07-16）：个人长篇不得直接复用主线 story 作为字数容器，否则主线 prose 会被错误计入 OC 的 10,000 字闭环。编译器必须创建主线 story 下独立的 personal-story `volume`，为该 volume 建立 `uses_world`/`uses_oc`，再写入稳定 outline 与逐节 prose；Closure 的个人故事绑定只指向该 volume。Main 的阶段协调器只决定 outline、下一节或 recheck；每节独立绑定 Run、Receipt、Change Set 与 output checkpoint，下一节必须重新检索。Main 在 Gateway 副作用前按持久 authority 和 Receipt 重新编译并比较提案，防止 Worker 借受信任 create 边界提交越权结构。只有当前稳定个人 volume prose 的 Unicode 字符计入总量，首尾空白、越界章节、跳节、无字符进展和不足 10,000 的伪终态均失败关闭。达到目标后必须进入独立 Closure evaluation；运行中收到的新规则在当前原子节结束后先执行 Revision/recheck，再继续下一节。

最新 Longform 确定性验收覆盖 Longform coordinator/phase/compiler/progress、Growth bridge/Coordinator、Closure evaluator/phase、Gateway 与 Supervisor 的 10 个 Vitest 文件、132/132 通过，`npm run typecheck`、`npm run verify:prompt-publication` 与 `git diff --check` 通过；本批未使用 Provider（模型服务）、Electron、生产构建或全量测试，因此只证明受约束的 OC 长篇分段调度、Cycle 间规则修订和 Closure recheck，不证明模型正文质量或 Live（真实运行）。当前 Longform 闭环最低目标由共享策略统一为 7,000 Unicode code points（通常约 7–8 千字）。

## Illustration

Anchor（锚点）采用严格判别联合：

- resource 必须固定 `resource_id + resource_version_id`；
- stable text span 必须固定 document/version、Unicode code-point offset（Unicode 码点偏移）和片段 SHA-256，不复制稳定正文；
- working/conversation snapshot 保存项目内不可变原文和 SHA-256，但不创建正式 document、Assertion（断言）或 Canon。

Item 只保存编译后 Prompt 哈希，不保存 Prompt 原文、凭证或 Provider（模型服务）秘密。`source_version_set_hash` 按 source kind（来源种类）与稳定 ID 排序后的规范集合计算，所以调用方重排同一来源集合不能绕过 `request_id + anchor_hash + source_version_set_hash + variant_key` 唯一身份；来源子表的 ordinal 仍保留首次规划的展示顺序，身份规范化不重写展示顺序。`image_job_id` 唯一外键保证一个既有 Image Job 只能绑定一个 Item；绑定前还必须精确匹配 purpose、编译后 Prompt SHA-256、规范化 source version ID，以及可从来源版本推导的 resource ID，未知、畸形、多余或缺失来源全部失败关闭。Item 状态从 Image Job/Asset（资产）权威同步；`reconciliation_required` 表示 Provider outcome unknown（结果未知），不得猜测成功。来源变化可将 Item 标记 `stale`，已发送的 Provider 请求不被伪装撤回。

Request 不设 Item 总量约束；每个持久批次最多 20 项并保存 sequence、cursor、item count、状态、幂等键和负载哈希。Request/Batch 状态由 Item 聚合刷新，因此已完成请求在任一 Item 变 stale 后会重新进入 stale。

Illustration Queue 实现收口（2026-07-16）：Main-only Coordinator 会先在一个 SQLite 事务中持久化完整 Request 与全部 Batch/Item，再允许第一项 Provider 副作用；第二批写入失败会回滚整份计划。默认覆盖由 Main 派生的 evidence role 约束，要求世界地图、主要地点/势力风貌、故事场景及每个主要 OC 立绘；`all_visible_nodes` 要求每个可见 binding 均有目标，`custom` 保留一段文字多图和多变体自由。队列没有产品总量上限，固定每批 20、并发 1。Main 以 Item 的 Prompt 哈希、purpose、来源集合和稳定幂等键向既有 `generate_image` Gateway 证明内部 authority，Renderer 和模型不能提供该 authority。单项失败不删除后续项；部分完成后取消只取消未发送 Item。重开时未发送的 running Job 回到 queued，已发送的未知结果进入 `reconciliation_required`；来源版本变化会同时把 Item 与既有 ready Asset 标记 stale。工作文本和会话文本只能以项目内不可变 snapshot/hash 作为 anchor，同时仍要求正式 source version 提供事实上下文。当前只完成确定性 Main/SQLite/Gateway 队列边界；Renderer 接入和真实多图 Provider Live 尚未完成。

## 迁移、崩溃与恢复

v23→v24 只创建新表、索引、外键和检查约束，不改写 Growth、Change Set、document、Assertion、relation、Image Job、Asset 或既有哈希，不创建默认 Profile、Inquiry、Intent、Illustration 或假历史行。

Schema 26 将 `growthContractVersion` 升为 `1.1.0`，capability/strategy 升为 `hackathon-growth-closure-v4` / `grow_world_story_oc_closure_v4`；v3 调用方不得解析或发送 v4 payload。`growth_cycles`、`growth_events`和 `growth_cycle_intents` 的 CHECK 变更需要物理重建，只能称语义加法。v25→v26 迁移必须保持旧行所有字段、数量、顺序与既有 hash 逻辑等值，保留索引/唯一约束/外键，通过 `foreign_key_check` 和完整性检查，故障全回滚且重开幂等。旧 Closure 数据标记为 `legacy_pre_v26`，不得补造 severity、reason、fingerprint、mixed components 或 evaluation outcome；旧 accepted Review 只供历史查询，不能自动升级为 v26 `evaluated` 证据。旧二进制打开 schema 26 时必须失败关闭。

所有多行写入使用 `BEGIN IMMEDIATE`：

- Intent 子表失败会连同 Cycle 和 Goal sequence 更新一起回滚；
- Inquiry 问题、选择或证据外键失败会回滚整个 sealed batch；
- Closure revision、assessment、review/finding 分别原子追加；
- Illustration snapshot、batch、Item 和 source 任何一项失败都会整批回滚。

进程崩溃后重新打开数据库，调用方以稳定 idempotency key 重放：负载哈希相同则返回原记录，不同则阻塞。Image Job 已发送但结果不明时保持 `reconciliation_required`，不得重新收费或重复提交。

## 权衡

- 选择规范化子表而非 JSON 数组，增加表数量和查询 join，但获得有序唯一性、Receipt rank 外键和数据库级回滚保证。
- 保留 v23 查询投影而不回填，读取逻辑多一个 legacy 分支，但避免把固定三轮推断写成伪历史。
- 状态同时存储并在 Item 变化事务内聚合刷新，增加写入成本，但使崩溃恢复、分页和 UI 查询不依赖 Renderer 猜测。
- 文本快照会复制 working/conversation 原文；这是不可变锚点所需成本。稳定 document 只保存位置和哈希，避免重复正文。

## 冻结边界

- Domain Runtime（领域运行时）的 Checkpoint（检查点）、Change Set、document、Assertion、relation、Canon 和 Image Job/Asset 权威不变。
- 不修改 Rust Runtime V2（第二版运行时）、A2.2、权限、Creator/Player Lens（创作者/玩家视角）、公开 Provider 协议或 Change Set/Canon 语义；数据迁移只限上述 schema 26 Closure 扩展。
- Coordinator（协调器）、Worker（工作线程）Intent binding、IPC（进程间通信）与 Renderer 已接入动态轮次、等待指导和 Revision 执行的确定性路径；这证明规则只在 Cycle 边界生效、重新检索和受限单 Change Set，不证明当前 Revision、Longform、通用插图队列或最终产品已通过真实 Provider Live（真实运行）。
- 缺少真实角色 invocation、终态输出哈希、Receipt、版本或 Image Job 时全部失败关闭；不使用 Fixture（测试夹具）或本地模板冒充 Live。
