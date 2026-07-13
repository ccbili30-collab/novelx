# NovelX Desktop 项目入口

> 本文件是新会话的最小必读入口，不是完整产品需求，也不是完成声明。
> 新会话先读本文件，再按任务读取下方对应文档，禁止先扫描全仓或依赖旧聊天记录猜测项目状态。

## 1. 一句话定义

NovelX Desktop 是一个面向小说、世界观、OC（原创角色）与可游玩故事的 Agent-native（智能体原生）创作工作台。用户主要与 Steward（大管家）对话；大管家使用真实模型、项目工具、长期记忆、图谱、版本系统和专业 Agent，把讨论转化为可审查、可追溯、可继续游玩的作品。

它的长期目标不是“给聊天模型塞一段世界观 Prompt（提示词）”，而是建立小说创作领域自己的 Harness（智能体运行框架）：模型在证据不足时主动检索，在上下文压缩后仍能恢复任务和来源，在修改世界或正文时形成版本化 Change Set（变更集），在生成图片时绑定角色、场景与故事版本，在玩家模式中由真实 GM、Writer 和 Validator 共同完成一回合。

## 2. 产品灵魂

1. **大管家是产品本体。** NovelX 是它的 Harness。用户可以让它讨论、整理、写作、检索、安排专业 Agent、生成图片、检查冲突、管理项目与推动游玩。
2. **创作对象不是附件。** 世界、OC、故事、卷、章节、地点、势力、物品、力量体系、规则、历史、文化、事件、图片和玩家存档都是一等对象，彼此通过版本化关系组合。
3. **讨论必须沉淀。** 用户与大管家聊海岸线、精灵成因、国家历史或写作风格，都可以转成有来源的候选事实；只有经 Free / Assist 规则与 Checker 处理后才进入正式知识或 Canon（正史）。
4. **图谱不是唯一数据库。** 文档和原始来源保存完整表达；Canonical Assertion（权威断言）保存可核验事实；图谱是可视化、关系导航与检索投影。三者互相引用，不互相冒充。
5. **版本系统借鉴 Git，但服务创作。** 正文、设定、图片、关系和玩家时间线都可检查点、分支与回溯；恢复默认创建新头或新分支，不破坏后来历史。
6. **创作模式与玩家模式共享世界，不共享泄密视图。** Creator Lens（创作者视角）可以看到完整设定与冲突；Player Lens（玩家视角）只看到角色当下应知内容、正文和公开状态。
7. **没有真实 Provider 就阻塞。** 不允许本地模板、Fixture（测试夹具）、关键词分支或确定性 reducer 冒充真实 Agent、GM、Writer、生图或 Live（真实运行）。
8. **视觉表现属于核心能力。** 正文、角色、图片、地图、事件图谱与状态应形成同屏、可探索、可游玩的可视书，而不是把一切退化成 Markdown 文件列表。

## 3. 两条开发路线

### 长远开发线

- 目录：迁移后为 `D:\CodexW\NovelX_Desktop\work\main`。
- 目标：以 Rust Runtime V2（第二版运行时）为可靠地基，逐步完成恢复、权限、工具、上下文、长期记忆、多 Agent、小说领域链、桌面端和发布生态。
- 基线：A2.2 已冻结；未完成债务必须保留，不允许为了演示绕过地基规则。
- 主要参考：Codex CLI 的可靠性标准、oh-my-pi 的成熟 Agent 功能、Pi Agent 的现有兼容与迁移经验、webnovel-write 的网文创作结构。

### 黑客松线

- 目录：迁移后为 `D:\CodexW\NovelX_Desktop\work\worktree`。
- 目标：真实完成“大管家讨论世界/OC → 结构化记录 → 生成故事 → 生成角色或场景图片 → 正文、图片、角色和事件图谱联合展示 → 进入玩家模式继续一回合”。
- 只修阻塞该链路的 P0；不继续扩建 A2.2 Harness、Hub、Coordinator、oh-my-pi 集成或低层权限系统。
- 演示可以小，但不能假：真实 Provider、真实持久化、真实来源绑定、真实错误状态。

两条路线共享产品文档，但代码提交必须分支隔离。黑客松代码是否合回长远线，要在赛后按架构、测试和数据兼容性重新审查，不能自动合并。

## 4. 技术权威边界

```text
Electron + React + TypeScript
  桌面工作台、领域编辑器、对话、图谱、图片、玩家视图

Rust Runtime V2
  Run、Goal、Plan、工具协议、Provider、副作用授权、恢复、审计、调度

NovelX Domain Runtime
  世界、OC、故事、文档、关系、正史、图谱、版本、GM、Writer、Checker

SQLite + Artifact Store
  事件日志、项目对象、版本、来源、图谱、记忆、图片与其他产物
```

- Rust Runtime V2 是运行状态、恢复、权限和外部副作用的权威。
- Domain Runtime 是小说对象、正史和创作规则的权威。
- Renderer（渲染层）只显示结构化投影和提交用户决定，不能自行裁决剧情、权限、正史或完成状态。
- 上游项目只能通过适配层引入；不得让上游 Agent 直接写 Canon、绕过 Change Set 或控制项目权限。

## 5. 新会话阅读路由

| 任务 | 必读文档 |
| --- | --- |
| 理解完整产品 | `docs/product/novelx-desktop-product-requirements.md` |
| 做架构或拆任务 | 上述 PRD + `docs/architecture/novelx-desktop-long-term-architecture.md` |
| 判断当前完成度 | `docs/project/current-state-and-routes.md` + 对应 `notes/status/` |
| 接手长远 Runtime | `docs/runtime-v2/product-baseline.md` + `notes/status/2026-07-13-runtime-v2-a2-2-freeze.md` |
| 接手黑客松 | `docs/plans/2026-07-13-hackathon-visual-creation-loop.md` + `notes/status/2026-07-14-hackathon-creative-showcase.md` |
| 新会话交接 | `docs/project/session-handoff-template.md` |

## 6. 当前事实（2026-07-14）

- 桌面端版本：`0.2.7`。
- 产品与架构基线：`a119da8`，标签 `novelx-desktop-baseline-2026-07-14`；其中最后一个完成全量验收的代码头为 `8bb1695`，联合创作展台实现提交为 `c5526d1`。
- 长远开发目录：`D:\CodexW\NovelX_Desktop\work\main`，分支 `codex/long-term-main`。
- 黑客松目录：`D:\CodexW\NovelX_Desktop\work\worktree`，分支 `codex/hackathon-10day`；玩家入口 WIP 保存在 `cc17aab`。
- Runtime V2 A2.2 冻结标签：`runtime-v2-a2.2-freeze`，对应冻结文档记录的提交 `284d742`。
- 已完成的展台仅证明稳定正文、来源绑定图片资产、OC 与范围图谱可同屏展示。
- 真实图片 Provider 的完整 Live 链尚未重新验收；测试图片是 Fixture，不是生图成功证据。
- “从展台进入玩家模式”的界面 WIP 通过 typecheck 和定向 E2E 4/4，但没有全量测试、真实 GM / Writer 回合和图片 Live 验收，不能宣称闭环完成。
- GitHub 推送曾因本机凭据失效而阻塞；本地提交不能等同于远端已发布。

## 7. 不可违反的红线

- 不扫描或提交聊天中的 API Key；凭据只从应用设置、安全存储或测试环境注入。
- 不用 Prompt 驱动确定性的偏移量、工具配对、重试、恢复和写入事务。
- 不把会话摘要、向量相似度或模型置信度直接升级成正史。
- 不让多个 Agent 同时修改同一文件、状态机、协议或数据库迁移。
- 不用全量测试的历史结果证明新提交；每个提交按风险重新验证。
- 不把产品愿景、设计文档、Mock、Fixture 或静态 UI 描述成已经实现。

## 8. 本项目的会话协作方式

用户已决定：后续本会话主要负责产品架构、路线、任务拆分、验收标准和代码审查，不直接承担大规模实现。执行任务由用户转发给其他会话。每个任务包必须包含目标、允许文件、禁止文件、验收命令、完成条件和停止条件；执行会话不得自行进入下一阶段。
