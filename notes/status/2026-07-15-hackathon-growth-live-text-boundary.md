# 2026-07-15 Growth 真实视觉 Live 冻结

## 当前最高边界

当前最高的真实 Provider（模型服务）Growth（生长）视觉 Live（真实运行）证据为
`notes/evidence/novax-desktop-growth/growth-live-2026-07-15T13-23-33-522Z.json`，
SHA-256 为 `1E22F82FF310BCA2A5B7F8BCE1A9C005371CF44513CEE4D7EE6D14B1584CA05E`。
该次使用 `openai-compatible / gpt-5.4` 与
`openai-compatible-image / gpt-image-2`，严格 Playwright 单文件验收 1/1 通过。

- 从空工作区只经 UI（用户界面）的“生长”模式提交一次请求；Cycle 1/2/3 均为
  `committed`，三个独立 Run、Receipt、Change Set（变更集）与连续 checkpoint（检查点）链均通过断言。
- 三行时间线可见，世界地图公开安全活动完整经历 `queued → generating → ready`；Agent（智能体）
  右栏地图达到 `ready`，CreativeShowcase（创作展台）自动打开恰好一次，没有派发人工点击，终态路由为展台。
- 展台包含 1 张 ready 世界地图、1 份正文、4 张角色卡、8 个图谱节点，没有失败横幅；Agent 阶段和展台
  截图均已生成并通过文件存在性与哈希核验。
- 关闭并重开后，来源绑定的 `gpt-image-2` 世界地图 Job（图片任务）/Asset（图片资产）仍可见；PNG 为
  1536×1024、3176342 字节，SHA-256 为
  `f3862392138fe418476bfe67e23b593db575cd56c5405bd39cefbb95e902a862`。正式对象计数为
  resources=10、documents=6、assertions=4、relations=14。
- 后续独立 research-only Run（仅研究运行）真实完成 `retrieve_graph_evidence`；没有
  `propose_change_set` 或 `generate_image`，且没有新增 Change Set、checkpoint、Job 或 Asset。

最终 JSON 已经 PowerShell UTF-8 `ConvertFrom-Json` 与 Node `JSON.parse` 双解析；凭证及原始
Prompt（提示词）/工具参数标记扫描为 0，`leakScan=passed`。证据中的两份截图路径存在，文件哈希分别为
`e713988f5a1411ff53e1c951b5e39777267a0d8df11f8e9bd4810f1ec7b8d400` 与
`b6f0d7ed7c03a9000e559e662b934fbe428ac4793847b61c14739a1efa81bdcc`；该次测试结束后的 Electron 残留为 0。

此前 11-39、12-00、12-18、12-46、13-04 五份 failure-only（仅失败）视觉证据均已被 13-23 成功证据取代并删除。

## 冻结范围与未完成边界

本批只冻结 E2E（端到端测试）、脱敏证据和状态说明；没有修改生产代码、Prompt、公开协议、Domain（领域层）、
Renderer（渲染层）、配置、权限、Canon（正史）或数据模型，也没有重新调用真实 Provider。

当前证据不覆盖 Player（玩家）/GM（游戏主持人）回合、小说提取、移动端或导出、全量测试、生产构建、安装打包与更新链路；
不能据此宣称完整 NovelX 产品闭环或发布闭环已经完成。

## 16-43 Cycle 间用户指导真实验收（失败，不改变最高边界）

`HX-I-INTERACTIVE-GROWTH-LIVE-068` 在 HEAD
`218f84b5dd3a329faa019ff9755cd1ac94d68730` 上以未提交实验扩展
`tests/e2e/real-provider-growth-three-cycle.spec.ts`，验证一次 Growth 内 C1 → C2 的可见用户指导边界；
没有进入 Player、Cycle 4、A2.2、Canon（正史）或权限扩展，也没有修改生产代码、Prompt（提示词）、协议、
Domain（领域层）、Renderer（渲染层）或配置。

Task 0 已将该实验原样隔离为 `tests/e2e/real-provider-interactive-growth.spec.ts`，并把基础 spec 恢复到
HEAD 语义。本次基线整理没有重跑独立 guidance E2E、Provider（模型服务）或 Playwright。

启动前 `npm run typecheck`、`git diff --check`、`npm run build` 均通过；build 的三个 Prompt 发布门为
`activePrompts=3`，Main（主进程）、Preload（预加载桥）与 Renderer 生产构建成功。文本与图片安全存储及
`Local State` 均存在，匹配本工作树的 Electron 残留为 0；已按既定结果复用 UI Mock（模拟）3/3，没有重跑。

随后只执行一次
`NODE_USE_ENV_PROXY=1 npx playwright test tests/e2e/real-provider-growth-three-cycle.spec.ts --workers=1 --retries=0`；
1/1 失败，耗时 474 秒，未修复、未重试。C1 运行中，指导表单可用；保存前没有成功 acknowledgement（确认回执）。
一次可见 UI 保存成功形成 revision 2，中央安全简卡与右栏均显示 C1 当前使用 #1、最新保存 #2、待第 2 轮故事边界
生效，没有显示为已应用。该状态截图 SHA-256 为
`5840F6028970ACB5F519F37C2233537CB3E9D8EC45F0BFFF3B9476F636715690`。

三个 Cycle 最终均为 `committed`，`ruleRevision=[1,2,2]`；每轮均有独立 Run、Receipt、Change Set（变更集）、
output checkpoint（输出检查点）与成功 `retrieve_graph_evidence`，C1 世界地图生成成功。公开 UI 的三行时间线、
地图 `queued → generating → ready`、右栏 ready 地图、自动打开展台恰好一次和 completed 终态均通过。
终态计数为 resources=13、documents=11、assertions=5、relations=17，Change Set=3、checkpoint=4。

失败发生在自动 Showcase（创作展台）验收：图谱节点数和边数都大于 0，但本次 Story scope 的图谱节点不存在，
`storyNodePresent=false`，因此没有继续检查 OC scope 节点/关联边，也没有进入后续 repository（仓储）精确规则列表、
revision 2 原文、Story/`character_profile` 规则落实、关闭重开持久化或 research-only（仅研究运行）验收。
这些条件不能从三轮 committed 或全库计数推断为通过，当前最高成功边界不变。

本次 failure-only（仅失败）安全证据为
`notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-15T16-43-43-913Z.json`，SHA-256 为
`30031D848A9B6748933584F02AD40DED10AC7B39BB5BF32FB6C74FC1CC81EE60`。JSON 已通过 PowerShell
`ConvertFrom-Json` 与 Node `JSON.parse` 双解析；规则原文、正文、Prompt、工具参数、locator（定位信息）、路径和
凭证扫描均为 0，`leakScan=passed`。结束后匹配本工作树的 Playwright / Electron 残留为 0。16-43 运行批次未运行
full suite（全量测试）或安装包，当时没有暂存、提交或推送；Task 0 只隔离测试并保留这份失败边界。五份既有
Player failure evidence 均未修改或删除。
