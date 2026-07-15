# 2026-07-15 Growth Live 文本边界

## 当前权威边界

当前最高的真实 Provider（模型服务）文本 Growth 边界是
`growth-live-2026-07-15T09-35-07-875Z.json`（SHA-256：
`E7995B53E2B43D55FF5537FC555EFE46C9C7780F10F2674DC9DF028D5ED06642`）。该次使用
`openai-compatible / gpt-5.4`，初始九类 Greenfield 计数均为 0、资格为 true，泄漏扫描通过。

- Cycle 1（世界）、Cycle 2（故事）和 Cycle 3（OC）均已 committed；每个 Cycle 都有独立
  Receipt、Change Set（变更集）和输出 checkpoint，且 checkpoint 链连续。
- 协调器 completed 后，三个已绑定 Run 的公开 `run.completed` 已全部排空，才进入持久化断言。
- 关闭并重开后，正式对象计数为 resources=12、documents=7、assertions=3、relations=17。
- 独立 research Run（研究运行）已真实完成 `retrieve_graph_evidence`，没有
  `propose_change_set` 或 `generate_image`，并且 Change Set/checkpoint 数量未增加。

这只证明文本 Growth 三 Cycle 加后续真实检索的路径；图片生成、地图、图片 Provider、全量测试和
产品 UI 验收均未完成，不能据此宣称完整 NovelX Live。

## 已验证能力与冻结范围

- Main（主进程）绑定 Cycle checkpoint、scope、规则、可信阶段与跨 Cycle anchor；Worker 不可自行
  选择这些权威字段。
- World Fragment（世界片段）、Story Fragment（故事片段）与 OC Fragment（角色片段）由模型提供
  创作语义，编译器只生成机械 ID、父子关系、依赖与来源占位；每次仍仅经由一个既有 Change Set。
- Story prose 只来自真实 Writer candidate；OC profile 创作字节由模型提供并原样保留，且不进入安全公开活动或证据。
- Receipt 仍是提案前置条件；空工作区 create-only 仅由 Main 授权；进入 ChangeSetService 后不重试。
- 本批不包含 Prompt 调整、图片、Renderer、迁移、权限、Canon/Lens 变更或全量验收。

## 历史证据与恢复提示

`growth-live-2026-07-15T08-41-51-311Z.json` 是此前 C1/C2 成功边界，低于当前 09-35
边界。

`growth-live-2026-07-15T09-26-32-172Z.json` 已证明三 Cycle 的持久化提交，却在 E2E
过早释放订阅后只观察到两个公开 `run.completed`，关闭 Electron 导致 C3 审计被中断；它不是
三 Cycle 业务失败。09-35 通过独立终态事件排空条件后，完成了此前缺失的公共事件、重开持久化与
research-only 验收。

后续恢复必须由产品/父线程单独授权；若继续，应从图片/地图的真实 Provider 路径或相应产品验收
边界开始，而不是重跑本次文本三 Cycle。
