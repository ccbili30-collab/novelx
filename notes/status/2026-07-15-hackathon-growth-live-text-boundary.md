# 2026-07-15 Growth Live text boundary

## 当前权威边界

本状态只以 `growth-live-2026-07-15T06-14-35-856Z.json` 为当前 Live 证据。该文件经过 UTF-8 全文 PowerShell 与 Node JSON 解析；SHA-256 为 `E96B4FB0F3A4FB47B9FE2E7FE3DB09E501B172E988E38B51893BC885DBF6E98A`。

- 真实 Provider 请求身份为 `openai-compatible / gpt-5.4`；泄漏扫描通过。
- 初始 Greenfield 预检的九类计数均为 0，`initialGreenfieldEligible=true`。
- Cycle 1 真实完成 pinned retrieval、Receipt、一次 Free Change Set 提交与输出 checkpoint；没有本地模板或直接 Domain 写入。
- 持久化计数：resources=3、documents=3、assertions=3、relations=1；Change Sets 总计 2（committed=1、failed=1），outputs=13，checkpoint delta=1。
- Cycle 2 的 retrieval 与 Writer 成功；`propose_change_set` 以 `RELATION_TARGET_KIND_INVALID` 失败，Cycle 以 `GROWTH_CHANGE_SET_NOT_COMMITTED` 阻塞。
- 未进入 Cycle 3；没有独立 research Run、图片、地图或三 Cycle Live 成功声明。

## 历史边界

`growth-live-2026-07-15T05-37-45-176Z.json` 仅是 Fragment 编译器之前的历史失败边界：当时 Change Set 应用以 `RESOURCE_PARENT_REQUIRED` 失败。它不是当前权威状态，也不应覆盖上述 06-14 结果。

## 已冻结能力与限制

- Main 绑定 Cycle 的 checkpoint、scope、规则与可信阶段；Worker 不能自选这些权威字段。
- world 阶段的高层 Fragment 由模型提供创作语义，编译器仅构造合法 ID、父子关系、依赖和文档来源占位符，并只走一次既有 Change Set 路径。
- Receipt 仍是提案前置条件；空工作区 create-only 仍仅由 Main 授权；进入 ChangeSetService 后不进行重试。
- 本批不包含 story/OC Fragment、Prompt 调整、图片、Renderer、迁移、权限/Cannon/Lens 改动或全量验收。

下一恢复入口：设计 story Fragment；不得将当前 world Cycle 成功误称为完整三 Cycle Growth Live 闭环。
