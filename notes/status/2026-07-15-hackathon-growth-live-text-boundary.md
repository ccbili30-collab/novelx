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
