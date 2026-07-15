# 2026-07-15 Growth Live 文本边界

## 当前权威边界

当前最高的真实 Provider（模型服务）Growth 文本加世界地图边界是
`growth-live-2026-07-15T11-01-14-808Z.json`（SHA-256：
`28574F302D4040E85312E2C07C050F35D2DEC5ACCC1A97C68297A1B8C3E2125F`）。该次使用
`openai-compatible / gpt-5.4` 与 `openai-compatible-image / gpt-image-2`，初始九类
Greenfield 计数均为 0、资格为 true，泄漏扫描通过。

- Cycle 1（世界）、Cycle 2（故事）和 Cycle 3（OC）均已 committed；每个 Cycle 都有独立
  Receipt、Change Set（变更集）和输出 checkpoint，且 checkpoint 链连续。
- 协调器 completed 后，三个已绑定 Run 的公开 `run.completed` 已全部排空，才进入持久化断言。
- Cycle 1 在其 Change Set 成功后仅调用一次 `generate_image`；公开安全活动按“世界地图排队中”→
  “生成世界地图”→“世界地图已生成”排空。Cycle 2/3 没有地图活动。
- 关闭并重开后，恰有一个 succeeded 的 `world_map` Job（图片任务）和一个 ready Asset（图片资产）；
  其来源是 Cycle 1 同一 Change Set 输出的正式 world 资源版本与当前 setting 文档版本，且受管 PNG
  文件已按哈希、MIME、尺寸和字节数验证，并在 CreativeShowcase（创作展台）投影可见。
- 关闭并重开后，正式对象计数为 resources=13、documents=9、assertions=3、relations=21。
- 独立 research Run（研究运行）已真实完成 `retrieve_graph_evidence`，没有
  `propose_change_set` 或 `generate_image`，并且 Change Set/checkpoint 数量未增加。

这证明文本 Growth 三 Cycle、一个来源绑定的真实世界地图和后续真实检索路径；Renderer（渲染层）视觉
验收、全量测试、打包和完整产品 UI 验收仍未完成，不能据此宣称完整 NovelX Live。

## 已验证能力与冻结范围

- Main（主进程）绑定 Cycle checkpoint、scope、规则、可信阶段与跨 Cycle anchor；Worker 不可自行
  选择这些权威字段。
- World Fragment（世界片段）、Story Fragment（故事片段）与 OC Fragment（角色片段）由模型提供
  创作语义，编译器只生成机械 ID、父子关系、依赖与来源占位；每次仍仅经由一个既有 Change Set。
- Story prose 只来自真实 Writer candidate；OC profile 创作字节由模型提供并原样保留，且不进入安全公开活动或证据。
- Receipt 仍是提案前置条件；空工作区 create-only 仅由 Main 授权；进入 ChangeSetService 后不重试。
- 本批不包含 Prompt 调整、Renderer、迁移、权限、Canon/Lens 变更或全量验收。

## 历史证据与恢复提示

`growth-live-2026-07-15T09-35-07-875Z.json` 是此前文本三 Cycle 加 research-only 成功边界，低于当前
11-01 文本加地图边界；`growth-live-2026-07-15T08-41-51-311Z.json` 是更早的 C1/C2 成功边界。

`growth-live-2026-07-15T09-26-32-172Z.json` 已证明三 Cycle 的持久化提交，却在 E2E
过早释放订阅后只观察到两个公开 `run.completed`，关闭 Electron 导致 C3 审计被中断；它不是
三 Cycle 业务失败。09-35 通过独立终态事件排空条件后，完成了此前缺失的公共事件、重开持久化与
research-only 验收；11-01 在此基础上完成了地图 Job/Asset、来源绑定、受管文件和展台投影验收。

后续恢复必须由产品/父线程单独授权；若继续，应从 Renderer 视觉验收、全量测试或产品 UI 边界开始，
而不是重跑本次真实 Provider 路径。
