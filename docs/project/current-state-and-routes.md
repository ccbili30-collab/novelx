# NovelX Desktop 当前状态与双轨路线

状态日期：2026-07-21
用途：区分已验证实现、进行中代码、长期计划和黑客松计划。每次可提交批次后更新。

## 0. 最新状态覆盖（优先于下方迁移历史）

- World Director 正式桌面 Growth 入口现已切换到第一段地理专业员工委派：Main 创建一个稳定幂等的地理 Work Order，要求真实文本 Provider（模型服务）与已发布 `geography_ecology_author` Prompt，Worker 返回候选正文和 Provider receipt 后，Harness（智能体运行框架）将 Markdown 与交接 JSON 写入工作区内容寻址 Artifact（产物）存储并记录候选；缺 Provider、静默超时、取消、错误身份或 Artifact 完整性异常均失败关闭。该路由目前**有意停在候选落盘**，没有执行 Graph Curator、Checker、Director 审查、Change Set（变更集）、Canon 提交、世界地图或图片生成，因而不是完整 World Director / 世界包 Live。批次证据：定向 11 文件 152/152；全量 166 文件共 1097/1097、零跳过；typecheck、三项 Prompt publication gate、生产 build 与 diff check 通过；没有运行真实 Provider、Electron E2E、安装包或真实世界生成。详细边界见 `notes/status/2026-07-21-world-director-geography-delegation.md`。
- World Director 因果 Growth P0 已从 Phase L / Task 31 文本 Provider 身份阻塞恢复：凭据安全的真实上游 `GET /models` 返回 HTTP 200 和 13 个模型 ID，证明原验收 ID `5.6luna` 不存在，实际 ID 为 `gpt-5.6-luna`；用户已授权更正。真实 E2E 在临时项目、复制、Electron、解密和 Provider 之前严格要求 `openai-compatible / gpt-5.6-luna`，并校验 image Responses 身份与两份 store 的同一 Local State。当前 active store 仍保持 `openai-compatible / gpt-5.4` 与 `openai-compatible-image / gpt-image-2`，Live 仅使用隔离副本修改公开 `modelId`，不改用户配置。Task 31/32 尚待本轮真实双 Provider 验收。
- World Director 因果 Growth P0 已完成 Phase L / Task 30 的中央冻结：修正一个 Task 27 遗留的静态主题 token 合同后，最终 `npm test` 覆盖 163 文件并通过 unit 1047、integration 22、E2E-support 9，共 1078/1078、零跳过；diff、typecheck、三项 Prompt publication、生产 build、正式 `package:win` 和 package 内容验证通过。NSIS 产物 `release/novelx-Setup-0.2.7-x64.exe` 为 121,189,145 bytes，SHA-256 `4E0843B732D912B15C0EED9695EDCBF85D0E69EDB7608BB0543AE15332F2A124`；签名状态为 `NotSigned`。installer lifecycle 因脚本检测到用户已有 `D:\NovelX` 正式安装而失败关闭，未卸载或覆盖用户软件；工作树 Electron/NovelX 残留为 0。Vite 图谱静态/动态混用和 electron-builder 重复依赖引用是未阻塞构建的警告。未运行真实 Provider 或世界包。
- World Director 因果 Growth P0 已完成 Phase K / Task 29 的崩溃/重启矩阵：真实关闭并重开 SQLite 后，allocated 工作单只创建一次首个 attempt，已持久候选不重新生成，已接受审查只经串行提交道一次，已提交 Growth Change Set 会用稳定资源版本身份补建缺失图片队列；`running/reviewing` 因缺少 editorial Provider receipt 而保守进入 `reconciliation_required/outcome_unknown`，`commit_requested` 同样阻止 Canon 重发。同进程重复 resume 先复用活跃 Round Promise，不会把真实运行误判为崩溃；图片失败仍不改变 committed 文本。六个定向文件 58/58、typecheck 与 diff check 通过；编辑 Provider/commit 回调为注入 fake，图片补偿使用真实 SQLite committed Change Set Fixture 但没有真实 Provider；未运行 Electron E2E、全量测试、build、package 或世界包。当前 `running/reviewing` 只能阻塞而不能自动判定未发送，若要恢复执行必须另行批准持久 Provider receipt 合同。
- World Director 因果 Growth P0 已完成 Phase K / Task 28 的编辑故障安全分类：能力本地 allowlist 把 Director 计划、Work Order 状态、专业员工协议、图谱因果、编辑审查以及既有 Provider、Domain、持久化和对账来源码映射到固定责任族；伪造同前缀、对象型异常、密钥/响应正文样式字符串和未知代码统一收敛为固定未分类工作单失败，不进入安全诊断原文。候选/重基失败、提交结果未知和 Scheduler 依赖失败均在编辑状态持久化后追加一次诊断，诊断落库失败不会覆盖权威终态。四个定向文件 42/42、typecheck 与 diff check 通过；测试使用真实 SQLite 和注入失败，未运行真实 Provider、Electron E2E、全量测试、build、package 或世界包。现有信封没有 editorial-round operation kind，本批沿用按 Work Order 标识的 `tool_call` 操作身份，未新增公开 Renderer 诊断流。
- World Director 因果 Growth P0 已完成 Phase J / Task 27 的安全编辑活动与因果生长投影：`growth-presentation-v2` 只从持久 Editorial Round、Work Order、attempt、候选 Artifact 元数据、显式 `safeSummary` 审查、提交状态与当前图片队列状态重建固定事件，公开范围封闭为总编规划、员工分派、候选返回、检查、返修、提交及图片排队/就绪/失败；不投影 objective、scope、checkpoint、Provider/model、Prompt、hash、候选/审查存储引用、原始 JSON 或 evidence refs。Renderer 把总编编辑进度放在折叠大管家活动之外，当前创作显示最新编辑步骤与已提交断言/因果关系计数，图谱工具栏显示因果生长计数及最近 Graph Curator/Checker/提交状态。为避免沙箱 Preload 引入不可用 TypeBox，权威 capability roster 已拆为最小 Zod 合同并由原合同重导出，没有复制规则或兼容垫片。九个定向单元文件 89/89、Electron E2E 3/3、typecheck、生产 build（含三个 active Prompt publication gate）、最终 electron-vite build、diff check 与 1440×900 视觉检查通过。投影测试使用真实 SQLite，UI 编辑活动使用严格 Fixture；未运行真实 Provider、全量测试、package 或世界包导出。图片活动反映当前持久条目状态，不是 append-only 历史；崩溃恢复真实性仍由 Task 29 验证。
- World Director 因果 Growth P0 已完成 Phase J / Task 26 的对话身份路由：公开 Growth snapshot 现在严格携带代码拥有的 `world_director` 对话者、`steward` 运行者与 `expandable_activity` 展示方式；Main 生成该身份，Main/Preload 共用严格解析边界，缺失或伪造身份失败关闭，Renderer 投影并在恢复 Goal 时保持该身份。Growth 面板标题、状态、输入无障碍文案与运行文案均面向世界总编，大管家活动收进默认关闭的可展开层；Assist/Free 仍使用原大管家会话。六个定向单元文件 106/106、Growth Electron E2E 3/3、typecheck、生产 build（含三个 active Prompt publication gate）、最终 electron-vite build、diff check 与 1440×900 视觉检查通过。未运行真实 Provider、全量测试、package 或世界包导出；本批只使用已批准的 Growth 公开身份字段变更，不改变持久化 Schema、权限、Canon 或 Runtime V2。下一入口是 Task 27 的安全编辑活动与因果生长投影。
- World Director 因果 Growth P0 已完成 Phase I / Task 25 的 Visual Director 严格交接 seam：Main trusted projection 必须同时提供同 checkpoint 的 committed-text document binding 与 graph-evidence binding，每项绑定授权 scope、精确 source version、anchor 和 safe facts；公开 Packet 只显示 `@evidenceN`、安全事实和按用途枚举的 framing/viewpoint/layout，不暴露资源/文档/版本/hash 权威。公开 Packet 与 Main 私有 source authority 各自有 canonical hash，最终编译前双重校验。Visual Director 没有自由事实文本字段，只能选择已知 evidence ref 与枚举构图；未知/重复引用、用途不兼容构图、额外 Prompt/provider/style/source/fact 字段、checkpoint 漂移、来源重复、缺文本或图谱证据、编译后篡改均失败关闭。确定性代码恢复精确来源，加入 Task 24 风格/用途政策并产出现有 Illustration Plan；真实 SQLite 测试已把该 plan 持久化为 queue item，图片 Job 与 Provider 调用均为 0。七个相关套件 41/41、typecheck、生产 build（含三个 active Prompt publication gate）与 diff check 通过。测试用 direct repository Fixture，不是 Live Change Set 或真实 Provider；未运行 Electron E2E、全量测试或 package。当前是严格 handoff/queue compatibility seam，Task 26–29 的生产编排仍须实际调用它。
- World Director 因果 Growth P0 已完成 Phase I / Task 24 的统一视觉政策：一个 versioned Domain policy 集中定义彩色钢笔/墨线、折断角线、排线、可见纸张/颜料纹理、克制水彩/水粉和成熟幻想概念插画默认风格，并集中禁止默认写实摄影、3D/Unreal/CGI、光滑游戏海报、纯黑白、chibi/kawaii、通用萌系、内嵌段落/伪地图标签/水印。代码拥有的用途适配器分别约束身份优先的角色立绘、空间因果可读的场景/细节，以及 world/region/nation/city 四级制图层次；地图只预留 Renderer 权威标签覆盖区，生成图本身不写标签。旧 world-map Brief 与 Illustration Plan 均复用该政策，非 world 比例只能由 trusted target metadata 指定。已批准的用户显式风格覆盖仍可替换默认审美，但不能覆盖用途与事实边界；未新增公开 `detail` purpose，important-detail 继续使用 scene。八个相关套件 112/112、typecheck、生产 build（含三个 active Prompt publication gate）与 diff check 通过；未运行真实图片 Provider、Electron E2E、全量测试或 package。Task 25 仍需生产非 world scale metadata 与来源绑定 Visual Director Brief。
- World Director 因果 Growth P0 已完成 Phase I / Task 23 的增量插画提交接缝：只有绑定 committed Change Set 与精确 output checkpoint 的可视觉化 `resource_revision` 才会生成请求；每个 Goal/resource/version/primary variant 具有稳定幂等身份，计划绑定该资源修订及当前稳定文档版本并先持久化后执行。同版本重放不重复调用 Provider，资源修订会先把旧条目/资产标为 stale 再创建替代请求。应用服务用一个后台执行尾串行化跨请求 Provider 调用，Growth Coordinator 只同步触发持久化且不等待图片终态；规划或图片失败不改变已 committed 的文本 Cycle。六个相关套件 57/57、typecheck、生产 build（含三个 active Prompt publication gate）与 diff check 通过；测试使用真实 SQLite 和 fake pending/failing image Gateway，未运行真实 Provider、Electron E2E、全量测试或 package。公开协议、数据库 Schema、Canon、权限和 Runtime V2 均未变化。
- World Director 因果 Growth P0 已完成 Phase H / Task 22 的 Harness-only 因果自询选择 seam：只接受 3–7 个带 affected nodes、pinned evidence、明确 causal gap kind、重要性和下游阻塞计数的 Harness projection；稳定价值排序选择一个 frontier，以 gap kind/facet/node/evidence 的 canonical hash 去重，已尝试且证据身份未变化的集合终止为 no_progress。ask_user 仅允许互斥 Canon、冲突用户规则或不可逆世界前提三类真实创作者决策。Inquiry phase compiler 进一步要求模型 Brief 的候选集合、问题、证据和最终选择与 Harness 结果精确一致。为避免真实 Bridge 断裂，本批没有暗改独立的 Worker→Main 共享协议；选择结果在 phase seam 内保留 affected nodes，不通过不支持该字段的旧 IPC 假接线。八个相关 Inquiry/Closure/Worker 套件 99/99、typecheck、生产 build 与 diff check 通过；未运行 SQLite 持久化、真实 Provider、E2E 或全量测试。调用方仍需在 Task 26 收敛编排中提供并保留 prior-attempt 投影。
- World Director 因果 Growth P0 已完成 Phase H / Task 21 的节点成熟度策略：OC 14、国家 16、组织 12、地理 12、物种 14、文明 16、故事 8、世界 8 个维度由一个 Domain 模块集中定义；它们是来源绑定 coverage criteria（覆盖标准），不是 UI 表单。core/major 节点缺任一维度都会返回明确 blocking gap，supporting/background 仍暴露全部缺口但不使用未经定义的半成熟阈值阻塞；用户从低层级提升到 major/core 后会用原证据立即重算全深度要求。未知跨 profile 维度、重复 coverage/evidence、额外模型权威字段和非法降级/同级“提升”失败关闭。定向单元测试 7/7、typecheck 与 diff check 通过；未运行 build、数据库、Provider、E2E 或全量测试。该批次只提供确定性 policy，Task 26 尚未把它接入全局收敛与世界包完成门禁。
- World Director 因果 Growth P0 已完成 Phase H / Task 20 的大世界骨架门禁：World Fragment 内部工具合同默认要求 1 个世界、至少 3 个宏观区域、分布在至少 2 个区域的 4 个政体/文明群体、山脉/海洋/河流/交通/资源分布节点、4 个时代、3 个历史转折和 4 条至少跨 2 个系统的来源绑定因果机制。Harness 将规模角色、时代和转折编译为固定谓词 assertion，并将机制编译为真实 `causal_relation.put`，不靠标题关键词或未持久化标签判断完成；独立 Closure profile 对数量、跨区域分布、来源和跨系统性逐项输出 satisfied/missing。真实 SQLite/Gateway 回归提交了符合现有 Domain 规则的完整骨架，旧小港口 Fixture 已全部升级而未加兼容旁路。六个相关套件 109/109、typecheck、生产 build 与 diff check 通过；未运行真实 Provider、Renderer E2E、全量测试或世界包导出。该门禁保证结构下限，不证明节点达到 Task 21 的语义深度，也不证明最终 World Director Live。
- World Director 因果 Growth P0 已完成 Phase G / Task 19 的确定性候选编译器：Harness 从已授权 resource/artifact/evidence 映射生成全部 Domain ID、父子顺序、ownership、断言端点、因果端点、依赖和同批文档来源绑定，并将 specialist 文档、assertion 与 causal relation 编译为一个严格 `propose_change_set` 请求。specialist/graph 未 ready、产物集合漂移、来源缺失或哈希/码点区间伪造、因果复核缺失、端点未解析、认识状态 unknown、父级顺序/范围漂移和模型注入编译字段均在 Change Set 创建前失败关闭。内部 Graph Curator 合同补齐既有 Domain 因果政策要求的 `relationKind` 与 `polarityStrengthSummary`，未改变公开 IPC 或数据库 Schema。六个相关套件 75/75、typecheck、生产 build 与 diff check 通过；原子提交测试使用真实 SQLite、真实 Gateway/ChangeSetService，未运行真实 Provider、Renderer、E2E 或全量测试。该批次只闭合候选到原子 Domain 提案/提交的确定性边界，尚未接入 Task 20–32 的世界规模 Closure、UI、恢复和最终世界包 Live。
- World Director 因果 Growth P0 已完成 Phase G / Task 18 的 Graph Curator Worker 内部运行链：单一终态工具只接受精确 `@evidence` 码点范围/片段哈希绑定的 assertion/causal candidate，或无图谱输出的 needs_more_evidence；资源、既有 assertion、本地 assertion 与因果端点均受 packet 授权，凭据样式、伪造范围/哈希/端点、自环、空机制和重复提交失败关闭。五个定向套件 53/53、typecheck、生产 build 与 diff check 通过。仅使用内存 adapter 与合成 active Prompt，正式 Prompt 未发布、未运行真实 Provider 或图谱写入；引用存在不等于因果语义成立，Task 19 仍须做确定性政策复核。
- World Director 因果 Growth P0 已完成 Phase F / Task 17 的同所有者审查/返工编排：固定确定性验证、Graph Curator、Checker、Director 顺序，阻塞发现覆盖错误接受，浅层有效结果可按原 acceptance facet 定向返工；返工复制原 capability/profile/Prompt/model，默认最多两次，相同 Checker Artifact 或超限后持久化 ask_user 并停止自动派发。五个定向套件 38/38、typecheck、生产 build 与 diff check 通过。测试使用真实 SQLite 但注入所有审查阶段，未运行真实 Provider/Graph Curator/Change Set；v28 无 awaiting_user 状态，当前以 latest Director review 区分 ask_user，Task 27 必须如实投影。
- World Director 因果 Growth P0 已完成 Phase F / Task 16 的 Main 调度骨架：Director plan 在任何 Work Order 尝试前持久化，依赖就绪候选默认三并发并受 Provider slot 回压，一条 workspace 级 commit lane 在 `commit_requested` 前强制调用重基/复查 seam；取消保留已持久化 Artifact，重启跳过已接受候选与已提交项，未知提交结果进入 reconciliation 而不重发。四个定向套件 56/56、typecheck、生产 build 与 diff check 通过。测试使用真实 SQLite 但注入候选/审查/重基/提交函数，未运行真实 Provider 或 Change Set；Task 17/19 仍负责生产审查与候选编译，running 候选崩溃边界的 Provider 去重仍属 Task 29。
- World Director 因果 Growth P0 已完成 Phase F / Task 15 的专用 Worker 内部运行链：严格验证已发布 Prompt、固定 capability profile、Creator Lens packet/checkpoint/rule/hash，唯一终态工具只接受有界 Editorial Round plan 或来源绑定审查；越权 scope/evidence/facet、直接 Change Set、重复提交、取消及缺失 Provider 均失败关闭。六个定向套件 60/60、typecheck、生产 build 与 diff check 通过。仅使用内存 Runtime adapter 与合成 active Prompt；正式 World Director Prompt 仍为 candidate，不能称为 Live。
- World Director 因果 Growth P0 已完成 Phase F / Task 14 的有界 Director packet compiler（总编证据包编译器）：严格接收同一 checkpoint 的 Creator-safe（创作者安全）投影，完整保留并校验用户规则，加入代码拥有的编辑章程与固定 capability roster，并有界汇总 Closure、因果前沿、Change Set 摘要、Checker findings、上游 node maturity、来源绑定图谱摘要和图片队列。稳定排序、逐节预算、遗漏/截断回执、总字符上限与 packet SHA-256 已实现；checkpoint 漂移、规则篡改、重复身份、Player Lens、凭据样式和额外原始/隐藏字段失败关闭。三个定向文件 14/14、typecheck 与 diff check 通过；未运行 Provider、数据库写入、build、E2E 或全量测试。仓储聚合仍属后续 Main/scheduler 接线，Task 21 仍拥有成熟度算法。
- World Director 因果 Growth P0 已完成 Phase E / Task 13 的候选 Prompt 资产：一个共享安全基线与 11 个角色文件组合成固定员工 Prompt，每项绑定 capability/terminal tool/版本/独立 SHA-256，要求来源绑定、无项目工具、无角色扩权、无原始思维链，并声明实际模型身份由 Harness 审计。静态 contract lint 明确标注为非发布证据；全部状态仍为 `candidate`、publication evidence 为 null，伪 active 和 active 加载失败关闭。四个定向文件 24/24、typecheck 与 diff check 通过；未运行真实 Provider、发布评估、build、E2E 或全量测试。World Director/Graph Curator 专用 Runtime 尚未完成，不能把这些 Prompt 称为 production-live。
- World Director 因果 Growth P0 已完成 Phase E / Task 12 的通用专业员工 Runtime（运行时）：仅九个固定创作/视觉 capability 可进入，一个来源绑定 packet、一个已发布 Prompt 身份和唯一 `submit_specialist_candidate` 工具；ready 终态同时返回严格候选与真实文本 Artifact，证据不足终态为零 Artifact 的新检索请求。Provider/Prompt 缺失、身份或内容篡改、伪造引用/维度、任意工具、重复提交和取消均失败关闭且事件不暴露凭据或 Prompt 正文。四个定向文件 23/23、typecheck、生产 build 与 diff check 通过；仅使用 fake RuntimeAdapter（伪运行适配器）和 synthetic active Prompt（合成激活提示词），未运行真实 Provider、E2E 或全量测试。该批次只实现 Runtime 门禁，不包含后续 Prompt 资产或真实发布。
- World Director 因果 Growth P0 已完成 Phase E / Task 11 的固定能力注册表：严格复用 15 个权威 capability ID，每项绑定 versioned profile/hash、输入/输出 schema、Prompt 资产 ID/版本、最大上下文级别、并发组和唯一终态工具；未知能力、profile 漂移、Prompt 身份/哈希不匹配、任意工具与合同错配均失败关闭。新增与合同回归 12/12、typecheck 和 diff check 通过，未运行 Provider、build、E2E 或全量测试。该批次只建立注册与授权边界，不包含后续 Runtime 或 Prompt 发布。
- World Director 因果 Growth P0 已完成 Phase D / Task 10 的 Creator Lens（创作者视角）因果图投影与有界上下游检索：当前 checkpoint 的因果关系投影到断言事实节点，边只暴露安全机制摘要、认识状态与来源类型/版本/定位；推断、争议和冲突有不同视觉样式。检索对 Player Lens（玩家视角）、越权端点和未来版本失败关闭，缓存键绑定 checkpoint、scope、Lens、query、方向与全部预算且不缓存截断结果。十个定向文件 166/166、Electron E2E 1/1、typecheck、生产 build 与 diff check 通过；E2E 使用本地 SQLite Fixture（测试夹具），未运行真实 Provider 或全量测试。该批次不包含后续注册表与调度工作，World Director 调度和最终世界包尚未闭环。详细证据见 `docs/plans/2026-07-18-world-director-causal-growth-p0.md`。
- World Director 因果 Growth P0 已完成 Phase B / Task 4 的未接线内部编辑合同：固定 15 个 capability、1–20 个规范无环 Work Order、专业候选、Graph Curator 来源绑定断言/因果候选、Checker/Director 审核，以及模型伪造 Prompt/凭据/Provider URL/工具/数据库身份的严格拒绝。定向 7/7、typecheck 与 diff check 通过，未运行 Provider 或全量测试。详细边界见 `notes/status/2026-07-18-world-director-task-4-editorial-contract.md`。下一入口是 Task 5 的 SQLite v28；合同存在不等于 World Director 已实现。
- World Director 因果 Growth P0 已完成 Phase B / Task 3 的架构记录：`docs/adr/2026-07-18-hackathon-world-director-work-orders.md` 固化了 Director 编辑权威、Steward 操作权威、Checker 事实检查、Graph Curator 结构提取、固定员工注册表、同所有者返工、只读候选并发、Canon 串行提交和结果未知恢复边界。该记录是设计证据；World Director、Work Order、SQLite v28、因果图谱和最终 Live 均尚未实现。下一入口是 Task 4 的严格内部编辑合同。
- World Director 因果 Growth P0 已完成 Phase A / Task 2 的绿色 pre-feature 基线：代码冻结提交 `ce8378e9deb9ad86dbbacc6eefe1bd2afbb8e4d5`；18 个定向文件 190/190、最终全量 141 文件 915/915、零跳过，typecheck、生产 build、Prompt publication 与 diff checks 通过。唯一发现的回归是安全诊断目录测试漏列一个已有生产用途的 Closure policy code，已通过最小测试修复。详细证据见 `notes/status/2026-07-18-world-director-task-2-green-baseline.md`。这不是 Provider Live、Electron、安装包或最终世界包验收；下一入口是 Phase B / Task 3。
- World Director 因果 Growth P0 已完成 Phase A / Task 1 的只读脏基线盘点；精确路径分类、状态哈希、JSON 解析/凭据标记检查和最高 Live 边界见 `notes/status/2026-07-18-world-director-task-1-dirty-baseline.md`。盘点快照为 `codex/hackathon-10day` @ `60b097e`、81 个已跟踪修改、106 个未跟踪、暂存区 0；盘点后新增的 Task 1 状态文档不属于该冻结计数。下一入口是 Task 2 的定向测试与绿色基线恢复，尚未开始 World Director、因果图谱或 SQLite v28 实现。
- 黑客松分支：`codex/hackathon-10day`。
- 当前提交头：`60b097e`。Repair、Revision、Longform、通用/默认 Illustration Queue 与 Growth UI 已完成确定性实现；阶段 6 的 E2E、计划和新失败证据尚未提交。
- 真实 Growth 最高视觉边界记录在 `notes/status/2026-07-15-hackathon-growth-live-text-boundary.md`：空工作区经真实 `gpt-5.4` 与 `gpt-image-2` 完成世界→故事→OC 三个 committed Cycle、世界地图、自动 Showcase 和后续 research-only 检索。
- 该 Live 不覆盖 Player/GM 回合、小说提取、导出、全量测试、安装包或升级链，不能称为完整 NovelX 闭环。
- Cycle 间用户指导的 Revision 路径已有新的真实提交证据。R3 修正了“合法 Revision 同批新文档证据被误判为 Greenfield”的内部权限漂移；最终 Live 的 Cycle 1/Cycle 2 均 committed，持久化 2 个 Change Set 和 2 次 checkpoint 前移，世界地图 Job/Asset 成功。随后 Cycle 3 仅持久化为 planned，`growth.get` 以公开聚合错误 `Growth Run bridge failed` 终止且没有安全诊断，因此 Closure/Longform/后续插图/reopen/research 尚未闭环。当前边界见 `notes/status/2026-07-17-safe-diagnostic-pipeline-v1.md`。
- Longform 已具备 outline/section 编译器、稳定身份、pinned progress resolver、Main→Worker authority 与自动 `outline → section → recheck` 协调的确定性证据。每节独立检索和提交；累计 10,000 Unicode 字符后进入独立 Closure recheck。章节运行中收到新规则时，先完成当前原子提交，再执行 Revision/recheck，最后以新规则继续。当前实现尚无这一完整路径的真实 Provider Live。
- 通用 Illustration Queue 已有 Main-only 的完整计划原子持久化、每批 20/并发 1/无总量上限、既有图片 Gateway 执行、来源 stale、取消、部分失败和重开 reconciliation 的确定性证据。Renderer 已接入图文图鉴；默认覆盖和自由配图的当前实现尚无完整真实多图 Live。
- `story` 与 `volume` 的关系语义已集中到 `src/domain/workspace/creativeRelationPolicy.ts`：二者均可作为 `uses_world` / `uses_oc` 的叙事源，`chapter` 不可。
- Growth 计划工具序列与稳定 `GrowthPhaseHandler` seam 已位于 `src/agent-worker/growth/core/`；新增测试阶段不需要修改顶层 Steward 状态机主体。
- Longform 与 Closure/Repair 的 Worker 编译/工具展示分别位于 `src/agent-worker/growth/phases/longform/`、`phases/closure/`；对应 Main authority resolver 位于 `src/main/growth/phases/`。顶层仍保留跨阶段工具分派、副作用门禁、恢复和终态。
- Growth 的最短 AI 阅读路径为 `src/agent-worker/growth/README.md` 与 `src/main/growth/README.md`。维护目标是缩小上下文和修改半径，不是继续增加战术功能。
- Safe Diagnostic Pipeline v1 已实现内部严格合同、SQLite 仓储、Main/Worker 诊断目录和失败关闭展示。Revision Main policy 现在保留十类精确本地错误，而 Worker 公开错误仍保持聚合；仍未覆盖最终 Live 暴露的 planned-Cycle `growth.get` bridge 失败。
- 当前 R3 冻结工作树已运行完整 `npm test`：Unit 842/842、Integration 22/22、e2e-support 8/8，共 872/872、零跳过；typecheck、3 个 active Agent Prompt publication、生产 build、diff checks 与 Electron 残留检查通过。该证据是当前混合未提交工作树的本地验收，不是提交或安装包验收。
- Windows 解包目录、包验证和 NSIS 生成已通过；解包应用已真实启动/退出。安装器为未签名的 0.2.7 x64 包。首次隔离安装因检测到用户已有 `D:\NovelX` 正式安装而安全阻断；产品负责人确认无数据并授权覆盖后，官方卸载器 exit 0，隔离安装/双启动/卸载/用户数据保留全部通过，当前 0.2.7 已重新安装到 `D:\NovelX` 并启动/退出通过。旧安装无 Growth 数据，安装后重开已有 Growth workspace 尚无证据。

下方内容保存 2026-07-14 的迁移与冻结历史。若与本节冲突，以本节和日期更新的 `notes/status/` 为准。

## 1. 仓库事实

- 应用：NovelX Desktop `0.2.7`。
- 技术栈：Electron 43、React 19、TypeScript 6、SQLite 领域存储、Rust Runtime V2。
- 迁移来源分支：`codex/stage4-memory-stage5-6`。
- 长远分支：`codex/long-term-main`，产品基线提交 `a119da8`。
- 黑客松分支：`codex/hackathon-10day`，当前 WIP 提交 `cc17aab`。
- 远端：`https://github.com/ccbili30-collab/novelx.git`。
- 最近一次已验证且提交的工作树头：`8bb1695`。
- GitHub 推送曾因本机凭据失效而失败；以下状态首先是本地事实，不能据此宣称远端 Release 已更新。

## 2. 冻结基线

### Runtime V2 A2.2

- 冻结标签：`runtime-v2-a2.2-freeze`。
- 冻结记录：`notes/status/2026-07-13-runtime-v2-a2-2-freeze.md`。
- 记录提交：`284d742`。
- 真实验收：Rust 正式测试 543/543、Killpoint 10/10、TypeScript Unit 402/402、Integration 22/22、ToolCall 10/10、skip 0；typecheck 与 build 通过。

A2.2 只证明一批可靠性地基：Bound Lease、Provider legacy 封口、bind-before-open、Assist continuation proof 和独立强杀 binary。它不是完整 Harness，不包含完整启动恢复、长期记忆、多 Agent、领域 Agent 或桌面产品闭环。

依据用户命令，A2.2 暂时冻结。长期分支恢复时，从冻结文档列出的 durable Assist、evidence hash、Host authenticity、metadata cleanup、trusted storage、Cancellation Hub、Coordinator 和 oh-my-pi 审计债务继续。

## 3. 黑客松已验证能力

截至 `8bb1695`：

- Steward 图片工具能够提出并持久化来源绑定图片任务/资产；真实 Live 证据仍受凭据重新保存阻塞。
- `showcase.get` 从活动分支聚合故事稳定正文、`uses_world` / `uses_oc` 资源、来源绑定图片状态和范围图谱。
- “作品预览”可同屏展示主视觉、稳定正文、OC 卡片和 Creator Lens 范围图谱。
- 只有 ready / stale 图片返回受管 `novax-asset://` URL；working copy 不进入正式展台。
- ready 图片 Artifact 可以在来源唯一时定位故事并打开作品预览。

验收记录：`notes/status/2026-07-14-hackathon-creative-showcase.md`。该提交记录 Unit 440/440、Integration 22/22、合计 462/462、E2E 2/2、typecheck 和 build 通过。

## 4. 已保存的黑客松 WIP（不得描述为完成）

`cc17aab wip(hackathon): preserve showcase player launch slice` 保存以下 6 个文件：

- `src/renderer/src/App.tsx`
- `src/renderer/src/features/player/PlayerWorkbench.tsx`
- `src/renderer/src/features/showcase/CreativeShowcase.tsx`
- `src/renderer/src/styles/base.css`
- `tests/e2e/creative-showcase.spec.ts`
- `tests/e2e/player-workbench.spec.ts`

其目标是从作品预览显式选择世界，建立/复用 Story Profile 和 Playthrough，进入 Player Workbench，并在回合卡显示严格来源绑定的 ready 场景图。迁移前验证：`npm run typecheck` 通过；`creative-showcase.spec.ts` 与 `player-workbench.spec.ts` 单 worker 合计 4/4 通过；当前测试 Electron / Node 残留进程为 0。

这只是安全保存 WIP 的定向证据。该提交没有运行全量 `npm test`、生产 build、真实文本 Provider 或真实图片 Provider，因此不能更新为完整玩家链或黑客松闭环完成。

## 5. 仍未完成的黑客松闭环

1. 重新在 NovelX 设置保存图片 Provider 凭据。
2. 验证 `Steward → 真实图片 Provider → Image Job / Asset → 作品预览`，保存脱敏证据。
3. 完成并验证“作品预览 → Story Profile / Playthrough → Player”显式入口。
4. 使用真实文本 Provider 完成一回合 GM → Writer → Validator。
5. 证明玩家上下文固定世界、故事和真实 OC bindings，且不泄漏 Creator Lens。
6. 连续运行三次完整演示脚本和失败场景。
7. 验证 Windows 安装、非 C 盘安装、升级保留配置和测试进程清理。

### 5.1 2026-07-17 当前 Growth 恢复入口

- 连续诊断标准：`docs/plans/2026-07-17-continuous-growth-diagnosis-repair-standard.md`。
- 最新完整冻结：136 个测试文件、877 项测试通过、零跳过；typecheck、active Prompt gates、生产 build 和 diff checks 通过。
- 已修复并确定性覆盖：planned Cycle 启动前阶段诊断、Growth Inquiry 三次有界纠正、Inquiry Brief 安全原因分类、Revision existing-document alias → pinned evidenceId 转换。
- 当前硬停止不是模型或图片失败：`creator_choice_required` 已把 Cycle 权威状态持久化为 blocked，但 Worker 仍依赖模型再调用最终结果工具；真实运行没有投影 Agent terminal，最终为 `GROWTH_AGENT_TERMINAL_PROJECTION_TIMEOUT`。
- 恢复前必须决定：是否授权 Main 在 creator-choice 事件成功落盘后主动停止对应 Worker，并发布 authoritative blocked terminal。不得通过放宽真实 E2E 断言掩盖悬挂 Run。
- 当前代码和证据仍在混合未暂存工作树；没有提交、推送、package 或 installer 验收。

## 6. 已完成的目录迁移

```text
D:\CodexW\NovelX_Desktop\
├─ backup\baseline\
│  ├─ repository.bundle        # 可恢复 Git 历史和引用
│  ├─ source-at-baseline.zip   # 产品基线的已跟踪源码快照
│  └─ BASELINE-MANIFEST.md     # 哈希、分支、验证和恢复命令
└─ work\
   ├─ main\                    # codex/long-term-main，长远开发
   └─ worktree\                # codex/hackathon-10day，黑客松
```

规则：

- 产品/架构文档提交同时成为两条分支共同祖先。
- `codex/long-term-main` 不包含玩家入口 WIP，以稳定产品基线为起点。
- `codex/hackathon-10day` 保留经过最小编译/E2E验证的 WIP；若 WIP 不能通过，不提交为代码，只在备份中保存 patch 并记录失败。
- 黑客松结束后不直接 merge；先审计 Runtime 边界、领域模型、测试和迁移，再挑选可复用提交。
- 旧 Codex 工作树在确认新目录和备份可恢复前不删除。迁移完成后也不自动删除，以避免误伤用户数据。

迁移验证：

- `work\main`：`codex/long-term-main` @ `a119da8`（后续状态文档提交会前移分支头，但不移动产品基线标签）。
- `work\worktree`：`codex/hackathon-10day` @ `cc17aab`（后续状态文档提交会前移分支头，但 WIP 代码仍由该提交标识）。
- `repository.bundle` 通过 `git bundle verify`，包含完整历史和 20 个 refs。
- `source-at-baseline.zip` 含 751 个已跟踪条目，来自 `a119da8`；其中 `PlayerWorkbench.tsx` 不含 `PlayerLaunchTarget` WIP。
- 新 clone 通过 `git fsck --full`；只报告来源仓库已有的 dangling commits/blobs，没有缺失或损坏对象。

## 7. 后续会话角色

本工作树会话是黑客松路线的 Worktree 头脑，不是普通执行工。它负责：在既定产品定义和冻结边界内制定 10 天战术架构、安排演示顺序、拆分有界任务、分配文件所有权、定义验收、审查执行结果并维护黑客松完成边界。具体编码可以由用户转发给该路线的执行会话。

Main 头脑位于 `work\main`，负责长期产品、Rust Runtime V2、完整 Harness、全局 ADR 和赛后整合。Worktree 头脑不能改写 Main 的长期路线，也不能因为演示需要自行改变公开协议、Schema、权限、Canon 语义、不可逆迁移或 A2.2 冻结边界；这些事项必须返回产品负责人和 Main 头脑决策。

执行会话使用 `docs/project/session-handoff-template.md`。默认一个执行 Agent；不允许多个会话同时改同一文件或状态机。全量测试只在合并后的冻结状态集中运行。

## 8. 状态更新规则

- 产品愿景变化：更新完整 PRD，并记录 ADR 或产品决策。
- 架构路线变化：更新长期架构蓝图和 ADR。
- 每个可提交批次：在 `notes/status/` 添加或更新证据，随后更新本文的哈希、测试数量和未完成项。
- 新会话只读 `CONTEXT.md` 和任务路由文档；不要把整段历史聊天复制进上下文。
