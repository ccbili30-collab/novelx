# World Director Growth 核心运行链与 Live 验收合同

状态：核心运行与验收合同；不代表实现已经接通或通过 Live（真实运行）

适用范围：Growth 模式、World Director（世界总编）、因果生长、专业作者调度、图片队列与世界包导出

上位权威：`docs/product/novelx-desktop-product-requirements.md`

关联决策：`docs/adr/2026-07-18-hackathon-world-director-work-orders.md`

当前实现状态：只以 `docs/project/current-state-and-routes.md` 和对应 `notes/status/` 为证据

## 1. 本文解决什么问题

本文把 World Director 的产品链定义成一个可检查的运行合同，防止再次出现以下错误：

> 把独立模块已经实现、定向测试通过、编译成功或 UI 已展示，误判为 World Director 已经在真实产品链中工作。

World Director 的完成对象不是一组模块，而是一条从用户输入到可恢复世界包的真实生产调用链。代码绿色是必要条件，不是产品链完成条件。

任何实现、测试、Live 或完成报告都必须先回答：

1. 真实生产入口调用了谁；
2. 每一步消费了什么权威输入；
3. 每一步产生了什么持久证据；
4. 下一步是否真实读取了前一步的新 Checkpoint（检查点）；
5. 因果、成熟度、图片和发布门禁是否实际参与了推进或阻塞；
6. 崩溃、取消和结果未知时是否失败关闭且没有重复副作用。

只要其中任一关键步骤没有真实调用或没有对应证据，就必须报告“链路未接通”或“链路在该步骤断开”，不得使用模块测试、Fixture（测试夹具）、静态投影或后续步骤的偶然成功替代。

## 2. 核心完成定义

一次 World Director Growth 只有同时满足以下条件才算链路跑通：

- 用户从正式 Growth 入口建立一个 Goal（目标）。
- Main（主进程）从同一分支、检查点和规则修订编译有界 Director Packet（总编资料包）。
- 真实 World Director Provider（模型服务）读取该资料包并提出 Editorial Round（编辑轮次）与 dependency DAG（依赖有向无环图）。
- Round 在任何专业作者启动前持久化。
- 只有依赖已满足的 Work Order（创作工单）被派发；独立候选可以并发，依赖候选必须等待前置提交。
- 专业作者只返回候选 Artifact（产物），不直接写 Domain（领域层）或 Canon（正史）。
- 每个候选真实经过 Graph Curator（图谱书记官）、确定性领域校验、Checker（检查者）和 World Director 编辑复审。
- 返修回到同一工单、同一能力所有者的新 attempt（尝试），并保留审核谱系。
- 接受的正文、断言和因果关系通过一个串行、原子的 Change Set（变更集）提交。
- 提交产生新检查点；下游工单从新检查点重新检索，而不是继续使用过期上下文。
- 系统重新计算世界尺度、节点成熟度、因果缺口和下游解锁状态，并据此选择下一生长前沿。
- 只有已提交且达到稳定条件的视觉目标进入异步图片队列；图片失败不冒充成功，也不阻塞文本继续生长。
- Closure（闭合检查）通过后，重启恢复和只读因果检索仍能证明同一检查点链。
- 世界包从已通过的固定检查点导出，保留来源、成熟度、因果图、Change Set、图片真实性和未完成边界。

以下结果都不能单独证明链路完成：

- World Director、Scheduler（调度器）、Graph Curator、Checker 或成熟度模块各自测试通过；
- UI 显示“世界总编”“正在检查”或“已提交”；
- SQLite 中存在孤立的 Round、工单或因果记录；
- 旧 Steward（大管家）Growth 路径生成了世界、故事和 OC；
- 只完成世界骨架，未执行成熟度和因果收敛；
- 只通过 Mock（模拟）、Fixture、Demo（演示）或本地确定性生成；
- 只生成了图片或世界包目录，但来源链、内容成熟度或发布门禁没有通过。

## 3. 权责链

| 角色 | 权威职责 | 明确禁止 |
| --- | --- | --- |
| Renderer（渲染层） | 展示持久状态、提交用户决定 | 推断完成、Canon、权限、工具结果或故事结果 |
| Steward / Runtime（大管家/运行时） | Provider、工具、权限、预算、持久化、取消、恢复、审计和图片队列 | 替代 Director 做编辑判断或在缺少候选时创造事实 |
| World Director | 选择因果前沿、编排工单、定义验收维度、编辑复审、识别创作者选择 | 写最终正文、直接调用项目工具、构造低层 Change Set、写数据库或调用图片 Provider |
| 专业作者 | 根据固定资料包生成有界候选 | 扩大 scope（范围）、提供权威 ID、直接写 Domain 或改变父 Goal |
| Graph Curator | 从候选中提取来源绑定的断言和因果候选 | 发明缺失事实、决定 Canon 或直接写图谱 |
| Checker | 检查冲突、来源、连续性、因果自洽和覆盖缺口 | 替原作者重写或自行提交 Canon |
| Domain Runtime | 验证类型、端点、来源、版本、因果政策和事务原子性 | 接受模型自报的身份、权限、完成或提交结果 |

Renderer 和模型都不拥有运行权威。正式事实只能沿 `候选 -> 检查 -> Change Set -> Checkpoint` 进入版本链。

## 4. 权威运行线路

```text
用户种子 / 规则 / 中途修订
  -> Provider、权限、范围、预算预检
  -> 建立 Goal，固定 branch / checkpoint / rule revision
  -> Main 编译 Director Packet
  -> World Director 选择最高价值因果前沿
  -> 持久化 Editorial Round + dependency DAG
  -> 派发 dependency-ready Work Orders
  -> 专业作者候选 Artifact（零 Domain 副作用）
  -> Graph Curator 提取断言、来源和因果候选
  -> 确定性 Domain / causal policy 校验
  -> Checker 审核
  -> World Director 编辑复审
       -> revise：同一 Work Order、同一 owner、新 attempt
       -> ask_user：持久化创作者选择边界
       -> accept：进入单一串行提交队列
  -> 针对最新 checkpoint 重新检索和 rebase（重定基线）
  -> 一个原子 Change Set：正文 + 断言 + 因果关系
  -> 新 checkpoint
  -> 重新计算世界尺度、节点成熟度、因果缺口与下游解锁
       -> 未闭合：编译下一轮 Director Packet
       -> 已闭合：进入发布门禁
  -> 稳定视觉目标异步进入图片队列
  -> 重启恢复 + 只读因果检索
  -> 导出不可变版本世界包
  -> 全部成功后原子更新 latest 指针
```

这条线路不是固定的 `World -> Story -> OC -> Closure` 四步流水线。它是由当前证据、因果缺口和节点成熟度驱动的收敛循环。World Director 每轮只选择当前价值最高的生长前沿；依赖顺序由 DAG 和检查点决定。

## 5. 三种不能混淆的依赖

### 5.1 内容因果依赖

内容因果描述世界事实如何通过机制产生另一个事实。例如：

```text
环形山脉与漫长冬季
  -> 冬季运输成本极高
  -> 粮食和铁器难以跨区流通
  -> 地方氏族控制粮仓和商路
  -> 王权无法直接征税和征兵
  -> 国家长期保持封建割据
```

每条正式因果关系至少必须记录：

- 原因端点；
- 结果端点；
- 方向；
- 传导机制；
- 生效条件；
- 时间范围；
- 精确来源与来源版本；
- 认识状态：已确认、推断、争议中或故意未知；
- 关系类型、极性或强度摘要；
- 所属 Change Set 和 Checkpoint。

`related_to`、共同出现、相似度或模型置信度不能替代因果机制。不能从“山脉”和“封建制度”直接跳出一条因果边；中间运输、资源控制、财政和军事机制必须可解释、可检索。

### 5.2 创作调度依赖

调度依赖规定什么内容必须等待什么内容正式提交：

```text
地理与气候
  -> 资源、交通与人口
  -> 生产、贸易与阶级
  -> 组织、信仰与制度
  -> 国家能力、军事与外交
  -> OC 的出身、创伤、欲望与选择
  -> 跨地区故事冲突与世界反馈
```

独立国家或区域可以从同一固定检查点并发生成候选；依赖某个国家制度的 OC 必须等待该国家审核和提交。候选并发不等于 Canon 并发，正式写入始终串行。

### 5.3 版本依赖

每个 Work Order 固定输入检查点、规则版本、scope、能力所有者和验收维度。前置工单提交后，下游工单必须读取新检查点并取得新的 Retrieval Receipt（检索回执）。

如果下游内容仍使用旧检查点，即使文本碰巧合理，也判定链路失败，因为系统没有证明因果信息真实传递。

## 6. 世界如何生长

### 6.1 世界骨架

默认大世界至少要求：

- 一个世界；
- 至少三个宏观区域；
- 至少四个政体或文明群体，分布在至少两个区域；
- 明确的山脉、海洋、河流、交通网络和资源分布；
- 四个历史时代；
- 三个历史转折；
- 至少四个有来源的跨系统因果机制。

骨架通过只代表可以进入深挖，不代表世界已经完成。

### 6.2 节点成熟度

成熟度是证据覆盖，不是段落长度、关键词或模型自评分：

- OC：14 个维度；
- 国家/文明：16 个维度；
- 组织：12 个维度；
- 地理：12 个维度；
- 物种/文化：14 个维度；
- 故事：8 个维度；
- 世界：8 个维度。

core（核心）和 major（主要）节点必须达到完整默认深度；supporting（支持）和 background（背景）节点可以较浅，但必须显示真实缺口。用户提升节点重要性后必须立即按更高标准重新计算，不能沿用旧完成标记。

### 6.3 因果收敛

每轮从持久投影中查找：

- 有结果但没有前因；
- 有原因但没有下游影响；
- 中间传导机制缺失；
- 来源、条件、时间或认识状态缺失；
- 核心节点无法通过因果路径连接到经济、组织、制度、OC 或故事；
- 两条因果链互相矛盾；
- 下游工单依赖未成熟或未提交节点。

缺口选择顺序为：重要性层级优先，其次是阻塞的下游数量，再其次是缺失链路数量，最后使用稳定身份打破平局。重复问题使用规范化指纹去重；没有进展时停止循环，不通过换一种问法制造进度。

只有互斥 Canon、冲突用户规则或不可逆世界前提需要询问用户。普通证据不足、内容太浅或机制缺失应由系统安排返修或调查，不把内部工作转嫁给创作者。

### 6.4 Closure 的正确含义

Closure 不能只统计对象数量、断言数量或因果边数量。它至少同时要求：

- 世界尺度骨架通过；
- 所有核心和主要节点达到成熟度；
- 关键节点存在有来源、可解释、可检索的跨系统因果路径；
- 因果路径能真实解锁或约束下游国家、组织、OC 和故事；
- Checker 和 World Director 接受；
- 没有未说明的阻塞、结果未知或创作者选择；
- 重启后仍能从固定检查点恢复并检索同一路径。

“Cycle 已提交”只说明一次变更成功，不等于“世界完成”。

## 7. 图片生成合同

### 7.1 当前稳定用途

当前 Growth 图片合同只有三种用途：

- `world_map`：世界或地图类视觉；
- `character_portrait`：OC 与 OC Variant 立绘；
- `scene`：故事、卷、章、地点、势力和当前未独立建模的细节图。

区域、国家、城市地图可以使用统一地图视觉政策和 `mapScale` 元数据表达，但不得把“支持尺度政策”描述成“所有层级已经自动生成”。封面、物品、徽记和独立 `detail` 用途属于尚未完整接通的产品能力，除非当前状态文档提供新的实现证据。

### 7.2 自动出图位置

理想自动目标包括：

- 世界骨架稳定后的世界地图；
- 重要区域稳定后的区域地图和地貌氛围；
- 成熟国家/文明的国家或城市地图、建筑和社会风貌；
- 重要地点、组织总部、遗迹、交通瓶颈和生态场景；
- 核心/主要 OC 的立绘与版本化形象；
- 故事结构稳定后的代表场景和章节背景；
- 用户明确要求且已有来源支持的重要物品、魔法、生物或建筑细节。

### 7.3 启动门禁

图片不得在 Director 规划、候选生成、检查或返修阶段启动。自动图片任务必须满足：

1. 目标来自已提交的 Change Set；
2. 目标版本与当前检查点一致；
3. 目标已经达到该用途要求的稳定或成熟条件；
4. Visual Director（视觉总监）只从已提交文本和图谱证据编译来源绑定 Visual Brief（视觉简报）；
5. 队列项先持久化，再调用图片 Provider；
6. 文本 Growth 不等待图片完成；
7. 来源修订后旧图标记 `stale`，不得静默冒充最新图；
8. 失败图片保留 `actualContent=false`，不显示占位结果。

“每个可视觉化资源一提交就自动出图”不再是充分条件。浅层中间提交必须等待成熟度门禁，避免过早消耗 Provider 时间和费用。

## 8. 外部副作用与写队列

Provider 网络调用不能持有项目写队列。正确顺序是：

```text
持久化 ProviderAttempt intent 和稳定身份
  -> 释放项目写队列
  -> 调用外部 Provider
  -> 持久化结果或 outcome_unknown
  -> 需要正式写入时重新取得单一提交通道
  -> 校验最新 checkpoint
  -> 提交一次原子 Change Set
```

队列等待时间和 Provider 执行时间必须分别记录，不能把排队误判成模型超时。Provider 已发送但结果未知时进入 `reconciliation_required`，不得自动重派、重复收费或制造第二份候选。

图片使用相同副作用原则，但图片失败不得回滚已提交文本。

## 9. 世界包发布合同

世界包只能从通过 Closure 的固定检查点构建，至少包含：

- 完整世界、地理、历史、系统、区域、政体、组织、文化、OC 和故事文档；
- Canonical Assertion（权威断言）与结构关系；
- 完整因果图、机制、条件、时间、来源和认识状态；
- 节点成熟度报告与仍未解决的缺口；
- Change Set、Checkpoint 和来源 manifest（清单）；
- 图片任务状态、来源版本和 `actualContent`；
- Creator / Player Lens（创作者/玩家视角）发布策略；
- 当前未完成、冻结和受信任边界。

发布采用不可变版本目录。只有构建、校验、重启恢复和只读检索全部成功后，才原子更新 `latest` 指针或最新目录。

失败运行必须写入独立失败证据区，保留脱敏日志、检查点、断链步骤和可恢复诊断；不得覆盖最近成功世界包，也不得删除唯一的取证数据库后只留下笼统错误。

## 10. 链路级验收表

真实运行必须逐项保存以下证据。缺失任一关键项即判定对应链路未通过：

| 步骤 | 必须看到的真实证据 | 不能替代它的证据 |
| --- | --- | --- |
| 入口 | 正式 Growth IPC/服务入口创建的 Goal 和生产调用记录 | 测试直接构造 repository 或 scheduler |
| 预检 | 脱敏 Provider/profile 身份、权限、范围、预算检查，且发生在副作用前 | 设置页显示模型名称 |
| Director Packet | 固定 branch/checkpoint/rule revision、packet hash、遗漏回执 | 手工构造 packet Fixture |
| Editorial Round | Provider receipt、Director 结果、先于工单运行的持久 Round | 单测中的 plan 对象 |
| Work Order | owner、scope、acceptance facets、dependencies、attempt 和状态历史 | 只有 UI 文案“已分派” |
| 专业候选 | 真实 ProviderAttempt、候选 Artifact hash、零 Domain 写入证明 | Mock 作者输出 |
| Graph Curator | 精确来源范围、断言和因果候选、缺证据分支 | 只统计 graph edge 数量 |
| Checker/Director | 独立审核记录、阻塞 finding、接受或同所有者返修谱系 | 一个模型自评“通过” |
| Change Set | 最新检查点 rebase、原子正文/断言/因果提交、唯一提交身份 | 数据库中存在部分对象 |
| 新检查点 | 下游 Retrieval Receipt 读取新 checkpoint 和新因果路径 | 沿用旧上下文生成合理文本 |
| 收敛 | 世界尺度、节点成熟度、因果缺口、下游解锁的重算结果 | 固定 Cycle 数或内容字数 |
| 图片 | 成熟目标、来源绑定 Brief、持久队列、真实 Provider/失败状态 | 占位图、Fixture 或仅有 prompt |
| 恢复 | 关闭重开后状态、检查点、attempt、队列和结果未知语义不变 | 同进程重新读取 |
| 研究检索 | 只读运行检索已提交因果路径且零 mutation | 直接查询测试数据库 |
| 世界包 | 固定检查点 manifest、成熟度、因果、真实资产和原子发布记录 | 目录存在或 README 生成成功 |

Live 证据中不得包含凭据、原始 Prompt、私密思维链、未脱敏 Provider 响应、内部 locator 或 Player Lens 隐藏事实。

## 11. 测试层级与完成声明

### 11.1 层级含义

1. 纯函数/合同测试：证明某个规则在隔离输入下工作。
2. Repository/SQLite 测试：证明持久化、事务、幂等和恢复语义。
3. 确定性生产调用链测试：证明正式入口真实调用 Director、Scheduler、Curator、Checker、Change Set、成熟度和图片 seam（接缝）。
4. Electron E2E（端到端测试）：证明 UI 只投影真实链路状态和错误。
5. Provider Live：证明真实文本/图片 Provider 在同一冻结候选上完成链路。
6. 重启、只读研究与世界包验收：证明结果可恢复、可检索、可发布。

低层证据不能向上替代高层证据。全量测试、typecheck（类型检查）、build（构建）和 package（打包）通过，也不能替代第 3–6 层。

### 11.2 Live 前置门禁

下一次昂贵 Live 之前，必须先用确定性生产调用链测试证明：

```text
Growth start
  -> Director Packet
  -> Editorial Round
  -> Work Orders
  -> Graph Curator
  -> Checker / Director review
  -> atomic Change Set
  -> new checkpoint retrieval
  -> maturity / causal recomputation
  -> stable illustration enqueue
```

如果生产入口仍进入旧 Steward Cycle，或 World Director Scheduler 只能被测试直接创建，Live 禁止开始。

### 11.3 Live 停止规则

真实运行发现第一个关键断链后必须停止继续消耗 Provider，保存证据并复盘调用链。尤其包括：

- Round 没有由正式入口创建；
- 专业作者没有通过工单调度；
- Graph Curator、Checker 或 Director review 被旁路；
- 下游没有读取新检查点；
- Closure 只统计数量；
- 图片在浅层内容阶段抢占运行；
- 失败包覆盖成功 `latest`；
- 运行长时间无进展而没有持久状态变化。

不得因为已经投入时间或费用而继续错误路线，也不得通过放宽验收、补测试 Fixture 或修改 UI 文案把断链包装成成功。

## 12. 每次链路审查必须回答的问题

每次真实运行、回归、修复或完成报告必须回答：

1. 本次正式入口最终调用的是旧 Steward Growth，还是 World Director Round？
2. Round 是否在任何专业候选前持久化？
3. 哪些工单并发，为什么它们没有依赖？
4. 哪些工单等待了前置提交，并从哪个新检查点重新检索？
5. 每个候选是否实际经过 Curator、Domain、Checker 和 Director？
6. 返修是否保持同一 owner、工单和 attempt 谱系？
7. 因果关系是否包含机制、条件、时间、来源和认识状态？
8. 关键因果链是否实际影响国家、组织、OC 或故事，而非只增加边数量？
9. core/major 节点是否达到成熟度，还是只有浅层段落？
10. 图片是否只从成熟的已提交目标启动，并且没有阻塞文本？
11. Provider 网络调用是否释放了项目写队列？
12. 重启、结果未知和取消是否没有重复副作用？
13. 世界包是否来自通过 Closure 的固定检查点，失败运行是否没有覆盖成功包？
14. 哪些结论来自真实 Provider，哪些只来自确定性测试？

任何问题无法回答时，必须标记“当前证据不足”或“对应链路未验证”，不能作完整闭环声明。

## 13. 题材与验收的关系

经典史诗魔幻、中土式大世界、科幻、现代都市或其他题材只是用户种子和创作规则。运行链、权责、因果记录、成熟度、图片门禁和 Live 验收不得针对某个题材硬编码或降低。

下一次原创经典史诗魔幻大世界 Live 应用于验证本合同，而不是用更丰富的题材掩盖链路缺失。内容可以不同，证据顺序和失败关闭标准必须相同。

## 14. 参考文件

- `docs/product/novelx-desktop-product-requirements.md`
- `docs/architecture/novelx-desktop-long-term-architecture.md`
- `docs/adr/2026-07-18-hackathon-world-director-work-orders.md`
- `docs/plans/2026-07-18-world-director-causal-growth-p0.md`
- `docs/project/current-state-and-routes.md`
- `src/agent-worker/growth/README.md`
- `src/main/growth/README.md`
