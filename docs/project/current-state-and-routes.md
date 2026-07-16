# NovelX Desktop 当前状态与双轨路线

状态日期：2026-07-16
用途：区分已验证实现、进行中代码、长期计划和黑客松计划。每次可提交批次后更新。

## 0. 最新状态覆盖（优先于下方迁移历史）

- 黑客松分支：`codex/hackathon-10day`。
- 当前最新阶段实现头：`3a39df5`。Revision 实现只完成定向验收；全量测试与生产构建结论仍固定在模块化基线 `a666f07`，不得跨头沿用。
- 真实 Growth 最高视觉边界记录在 `notes/status/2026-07-15-hackathon-growth-live-text-boundary.md`：空工作区经真实 `gpt-5.4` 与 `gpt-image-2` 完成世界→故事→OC 三个 committed Cycle、世界地图、自动 Showcase 和后续 research-only 检索。
- 该 Live 不覆盖 Player/GM 回合、小说提取、导出、全量测试、安装包或升级链，不能称为完整 NovelX 闭环。
- Cycle 间用户指导的确定性 Revision 路径已接通：规则仅在安全边界进入新 Cycle，重新检索 pinned checkpoint，以模型 Impact Brief 和一个受 Main authority 二次验证的 Change Set 修改 world/story/OC，并只将受影响插图标记 stale。当前实现尚无真实 Provider Live，交互式 Growth 仍未闭环。
- Longform 已具备 outline/section 编译器、稳定身份、pinned progress resolver 和 Main→Worker authority 绑定的定向证据；自动 outline→section→recheck 协调尚未冻结。
- `story` 与 `volume` 的关系语义已集中到 `src/domain/workspace/creativeRelationPolicy.ts`：二者均可作为 `uses_world` / `uses_oc` 的叙事源，`chapter` 不可。
- Growth 计划工具序列与稳定 `GrowthPhaseHandler` seam 已位于 `src/agent-worker/growth/core/`；新增测试阶段不需要修改顶层 Steward 状态机主体。
- Longform 与 Closure/Repair 的 Worker 编译/工具展示分别位于 `src/agent-worker/growth/phases/longform/`、`phases/closure/`；对应 Main authority resolver 位于 `src/main/growth/phases/`。顶层仍保留跨阶段工具分派、副作用门禁、恢复和终态。
- Growth 的最短 AI 阅读路径为 `src/agent-worker/growth/README.md` 与 `src/main/growth/README.md`。维护目标是缩小上下文和修改半径，不是继续增加战术功能。
- 模块化基线 `a666f07` 已运行完整 `npm test`：Unit 728/728、Integration 22/22、e2e-support 6/6，零跳过；生产 `npm run build` 通过，并验证 3 组 active Prompt publication。其后的 Repair 与 Revision 阶段只运行定向测试、typecheck 与 Prompt gate；完整冻结验收留到执行计划阶段 6。

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
