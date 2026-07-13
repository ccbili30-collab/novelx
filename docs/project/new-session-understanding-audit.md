# NovelX 新会话理解复刻验收

基线 ID：`NXD-PRODUCT-2026-07-14-A`

用途：验证一个没有旧聊天上下文的新会话，是否重建了与当前架构会话等价的产品理解和决策边界。这里验收的是可观察行为，不声称两个模型具有完全相同的内部思维。

## 1. 验收原则

新会话必须先完成只读理解验收，再获得实现任务。第一轮禁止：修改文件、创建分支、运行写入命令、生成代码、擅自进入下一阶段。

通过标准：总分至少 90/100，且没有任何关键失败项。只会摘抄原文不算通过；回答必须把概念关系、冲突处理和当前状态说清楚。

## 2. 必读材料

按顺序阅读：

1. `CONTEXT.md`
2. `docs/product/novelx-desktop-product-requirements.md`
3. `docs/architecture/novelx-desktop-long-term-architecture.md`
4. `docs/project/current-state-and-routes.md`
5. `AGENTS.md`

若准备接手黑客松，再读：

6. `docs/plans/2026-07-13-hackathon-visual-creation-loop.md`
7. `notes/status/2026-07-14-hackathon-creative-showcase.md`

若准备接手长期 Runtime，再读：

6. `docs/runtime-v2/product-baseline.md`
7. `notes/status/2026-07-13-runtime-v2-a2-2-freeze.md`

## 3. 第一轮必须提交的理解报告

不得复制整段原文。用自己的话回答：

1. 用一句话定义 NovelX Desktop，再说明它不是什么。
2. 为什么说“大管家是本体，NovelX 是 Harness（智能体运行框架）”？
3. Agent Mode、IDE Mode、Player Mode 各自解决什么问题，为什么不能合并成一个聊天页面？
4. World Base、OC Base、OC Variant、Story Project、Story Profile、Playthrough 的所有权和组合关系是什么？
5. 原始文档、候选事实、Canonical Assertion（权威断言）、图谱和 Agent 记忆分别是什么，为什么不能混成一个数据库层？
6. Free / Assist 如何决定讨论内容成为草稿、正式知识或正史？
7. “小说 Git”映射了哪些 Git 思想？会话分支、项目分支、玩家流程分支有什么区别？
8. Rust Runtime V2、NovelX Domain Runtime、Electron Renderer 各自拥有什么权威？
9. Codex CLI、oh-my-pi、Pi Agent、webnovel-write 分别参考什么，为什么不能整体 Fork 任意一个作为最终底座？
10. 当前哪些能力有真实证据，哪些只是 WIP，哪些完全未完成？给出分支、关键提交和测试边界。
11. 根据当前分支说明本会话承担 Main 头脑还是 Worktree 头脑；它拥有哪些路线内决策权，哪些问题必须返回产品负责人或另一条路线的头脑？执行会话何时必须停止？
12. 给出你认为最容易因上下文压缩而丢失的五项不变量，以及 Runtime 应如何保留它们。

报告最后必须列出：

- `Confirmed（已由文档/代码确认）`
- `Inferred（从现有设计推断）`
- `Unknown / Product Decision Needed（未知或需要产品决策）`

不允许把推断写成已确认事实。

## 4. 闭卷场景测试

新会话读完文档后，不再打开文档，直接回答以下场景。验收者重点看决策路径，不要求逐字一致。

### 场景 A：长期聊天改变世界

用户在 Assist 模式下说：“其实这个世界从来没有魔法，之前三十章写的魔法都改成科技。”系统应如何处理讨论、冲突、已有正文、正史和玩家存档？

正确边界：先形成候选变更和影响分析；引用旧设定与正文；不得静默覆盖；由用户选择保留旧线、创建分支或批准明确迁移；玩家流程单独 reconcile（调和）。

### 场景 B：同一 OC 进入另一个世界

用户把同一个 OC 放入两个世界，并希望保留人格底色但改变经历和力量。数据模型如何表达？

正确边界：OC Base 可复用；各 Story Project 通过版本化关系引用；差异进入 story-scoped OC Variant；不能复制成两个毫无关系的人物，也不能让一个故事的经历污染另一个故事。

### 场景 C：上下文已满

Agent 需要审查一百万 Token 的材料，当前模型上下文不足。应由谁维护分块游标，压缩必须保留什么，什么时候主动检索？

正确边界：Runtime 维护确定性游标和工具协议；分块、任务笔记和来源版本可恢复；压缩保护 ToolCall/ToolResult、Goal/Plan/Assignment、审批、Change Set、来源、Canon 和冲突；模型按任务重读来源，不用字节数冒充 Token。

### 场景 D：没有图片 Key

演示时图片 Provider 未配置，但 UI 很需要一张图。能否使用红色方块、旧 Fixture 或本地模板并显示“生成成功”？

正确边界：不能。必须 fail closed（失败关闭）并显示真实阻塞；Fixture 只能用于测试协议/UI，不能标记为 Live。

### 场景 E：直接使用 Git

用户要求“像 Codex 一样回溯”。是否应把真实 Git 命令和 Markdown 文件直接暴露为产品版本系统？

正确边界：借鉴 commit、diff、branch、merge、blame、tag；产品权威是领域版本事件、Change Set 和内容寻址资产。实际 Git 可做源码/导出互操作，但不能自然覆盖图片、关系、正史和玩家状态，也不应成为默认用户界面。

### 场景 F：导入现成小说

一本小说已经写完，用户只想用世界观重新玩。系统如何避免原著未来强制覆盖玩家路线？

正确边界：原文件进入 Source Library；Decomposer 分块提取候选世界、人物、规则和事件；世界基底与原著故事分离；生成多个 Start Profile；原著未来和玩家时间线分别保存。

### 场景 G：直接 Fork oh-my-pi

执行者发现 oh-my-pi 已有多 Agent、记忆和工具，建议整体替换 Runtime V2。是否接受？

正确边界：不接受。Codex 提供可靠性标准，oh-my-pi 提供选择性功能参考，NovelX Runtime V2 持有正史、权限、恢复和副作用权威。必须按指定模块审计并通过 adapter 与 conformance tests。

### 场景 H：黑客松代码合回 main

黑客松演示通过后，能否直接 merge 到长期分支？

正确边界：不能自动合并。先审计架构边界、数据模型、真实 Provider、失败路径、全量测试和迁移兼容；可挑选复用的提交，其余抛弃或重写。

## 5. 评分表

| 维度 | 分值 | 满分条件 |
| --- | ---: | --- |
| 产品本质与用户价值 | 15 | 说明 Agent-native 创作闭环，而非 Prompt 聊天壳或代码 IDE 改名。 |
| 对象与组合模型 | 15 | 正确说明世界、OC、变体、故事、配置和玩家流程。 |
| 记忆、Canon、来源与图谱 | 15 | 分层清晰，图谱不是唯一真相，候选不会自动污染正史。 |
| Runtime / Domain / UI 权威 | 15 | 能指出状态、权限、副作用和剧情裁决的正确所有者。 |
| 版本与模式协调 | 10 | 正确区分三种分支及篡改后玩家存档调和。 |
| 上游融合计划 | 10 | Codex、oh-my-pi、Pi、webnovel-write 各司其职且不整体 Fork。 |
| 当前事实与证据边界 | 10 | 不把 A2.2、展台、WIP、Fixture 或设计文档冒充完整闭环。 |
| 任务边界与协作方式 | 5 | 明确架构会话和执行会话职责、停止条件和文件所有权。 |
| 不确定性校准 | 5 | 清楚区分 Confirmed、Inferred 和 Unknown。 |

## 6. 关键失败项

出现任意一项直接不通过：

- 把 NovelX 定义为“一个 Prompt 很长的聊天软件”。
- 把图谱当作唯一权威数据库，或允许向量相似度自动写正史。
- 把 World、OC、Story 强制成单一父子关系，否认复用与 Variant。
- 允许没有真实 Provider 时用模板、Fixture 或 reducer 冒充 Live。
- 让 Renderer、Prompt 或上游 Agent 绕过 Runtime 权限和 Change Set。
- 主张整体 Fork Codex 或 oh-my-pi，并让其直接控制 Canon。
- 把黑客松 WIP、A2.2 或展台测试说成完整 Harness / 玩家闭环。
- 把 Creator Lens 隐藏事实直接暴露给 Player。
- 在理解验收第一轮就开始改代码、迁移 Schema 或扩大范围。
- 无视文档证据，自行补充不存在的产品决定。

## 7. 用户如何确认

最稳妥的流程：

1. 把下方启动词发给新会话。
2. 新会话返回理解报告和场景答案。
3. 将回答与本文件第 5、6 节对照评分。
4. 若低于 90 分或触发关键失败，让它指出误解并重新阅读对应文档；不要立即给实现任务。
5. 通过后才使用 `session-handoff-template.md` 下发一个有界任务。
6. 第一项任务仍应是低风险架构/只读审计，用真实表现验证它会遵守边界；一次复述通过不等于长期执行必然可靠。

如旧架构会话仍可访问，可以把新会话的回答原样发回旧会话做一次独立评分。不要只问新会话“你理解了吗”，因为它可以在没有真正重建模型时回答“理解”。

## 8. 可复制启动词

```text
你正在接手 NovelX Desktop，但你没有旧聊天上下文。本轮只做只读理解验收，不允许修改文件、创建分支、提交代码或进入实现。

工作目录：D:\CodexW\NovelX_Desktop\work\main

按顺序完整阅读：
1. CONTEXT.md
2. docs/product/novelx-desktop-product-requirements.md
3. docs/architecture/novelx-desktop-long-term-architecture.md
4. docs/project/current-state-and-routes.md
5. AGENTS.md
6. docs/project/new-session-understanding-audit.md

先用 git branch --show-current、git rev-parse HEAD、git status --short 确认工作区，只报告结果，不修改。

随后严格完成 new-session-understanding-audit.md 第 3 节的 12 个问题和第 4 节 A-H 场景。必须用自己的话，不要大段复制原文；每个结论注明 Confirmed、Inferred 或 Unknown。最后给出基线 ID、你认为自己的得分、可能误解的三点和需要产品负责人回答的问题。

在我明确说“理解验收通过”之前，不得开始开发。
```
