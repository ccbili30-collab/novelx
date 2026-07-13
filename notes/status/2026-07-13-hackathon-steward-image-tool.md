# 黑客松 Day 1：大管家来源绑定生图工具

日期：2026-07-13

实现提交：`0af8546 feat(image): connect source-bound steward generation`

## 范围

本批把已存在的独立图片 Provider（模型服务）、持久化 Image Job（图片任务）和 Image Asset（图片资产）接入 Steward（大管家）的真实工具协议。A2.2 Harness（智能体运行框架）继续冻结；没有进入联合展台、玩家续写、Hub、Coordinator 或 Rust Runtime V2（第二版运行时）重构。

## 已实现

- 新增严格的 `generate_image` 工具协议、Worker Bridge（工作进程桥接）、Main Process（主进程）调度和 180 秒图片专用超时。
- 生图计划必须先调用 `retrieve_graph_evidence`，图片只能绑定本次计划范围和已经检索到的稳定来源版本，且必须是计划最后一个业务步骤。
- Main Process 在发送可能收费的图片请求前复核真实审计 ToolCall（工具调用）；Worker 不持有图片 API Key（接口密钥）。
- 使用持久化幂等键和项目写入队列；结果未知进入 `reconciliation_required`，禁止自动重试和重复收费。
- 图片成功后形成结构化 Artifact（产物），包含 Job、Asset、用途、来源版本、尺寸、MIME 和 SHA-256，不暴露磁盘路径或凭据。
- 注册 `novax-asset:` 受管协议；只按不透明 Asset ID 读取当前工作区已提交图片，并在返回前复核路径、大小与 SHA-256。
- 工作区启动时恢复未完成图片 Job，并清理受管临时文件；已发送但结果未知的任务只隔离，不重新收费。
- 新增可复现的正式 Electron 图片 Live Smoke（真实冒烟测试）入口。它从 Windows `safeStorage` 读取配置，在隔离工作区创建来源文档、调用正式图片服务并验证落盘资产，不接受源码内密钥。

## Harness P0 修复

- 长文档压缩不再删除 ToolCall / ToolResult（工具调用/工具结果）后插入普通用户消息；现在保留严格配对，只压缩已经由持久化任务笔记覆盖的正文和参数。
- Provider 返回 `stopReason=error/aborted/length` 后不再执行最多六次无意义纠正请求。
- 业务步骤到达最终提交时先结束当前工具轮，再进入有界的契约纠正回合。
- 最终提交工具被状态机拒绝后结束当前轮，避免 Pi 在单次 `agent.prompt()` 内无限强制重试。
- 修正 Steward 提交工具 TypeBox（工具参数协议）漏掉 `generate_image` 的错误。该漏项曾导致图片已经生成，但最终工具参数在进入状态机前被无限拒绝。

## Prompt 发布证据

- 正式 OpenAI-compatible DeepSeek Provider 评测最终 11/11 通过，0 个运行错误。
- 报告：`notes/evidence/novax-desktop-prompt-evals/prompt-eval-2026-07-13T16-36-31-476Z.json`
- 报告 SHA-256：`c898144f914ed93713084227ac561a9d3348ce42cc07f05bb3df10dd7ab2ee0e`
- 发布门：`ready_for_manual_review`，随后人工激活并通过 `verify:prompt-publication`。
- 当前 Active Prompt（已激活提示词）：Steward 1.12.0、Writer 1.7.0、Checker 1.8.0。
- 评测中的图片执行器是受控 Fixture（测试夹具），只验证真实文本 Provider 的计划、来源绑定、工具状态机和结构化收尾，不冒充真实图片 Provider Live。

## 全量验收

- `npm test`：通过。
  - Unit（单元测试）：90 文件，437/437 通过，0 skipped。
  - Integration（集成测试）：3 文件，22/22 通过，0 skipped。
- `npm run typecheck`：通过。
- `npm run verify:prompt-publication`：通过，3 个 Active Prompt。
- `npm run build`：通过，Main、Preload 和 Renderer 生产构建完成。
- 工作区密钥片段扫描：0 个文件命中。
- 测试结束后，命令行中包含当前工作区的 `electron.exe` 残留为 0；没有结束安装版 NovelX。

## 真实图片验收阻塞

- `npm run eval:image-provider:saved-profile` 在创建工作区和发送网络请求前失败关闭，最终本地错误为 `IMAGE_PROVIDER_STORAGE_FAILED`。
- `%APPDATA%\\novelx-desktop\\image-provider-profile.v1.json` 中存在配置与加密凭据字段，但当前 Electron/Windows `safeStorage` 无法解密该旧密文。
- 这次失败没有调用图片 Provider、没有创建 Job、没有产生可能未知的收费结果。
- 恢复方式：用户在 NovelX「设置 → 图片模型」中重新输入并保存 API Key，然后重新运行同一 Live Smoke。不得把聊天中的明文 Key 写入源码、脚本、Git 或命令日志。

## 未完成与冻结边界

- 尚未取得“真实图片 HTTP 响应 → 受管文件 → SQLite Asset → `novax-asset:` 读取”的本批 Live 通过报告。
- 尚未用一个真实 Steward 会话同时调用文本 Provider、图检索和真实图片 Provider；当前只有文本 Agent 11/11 真实评测与历史图片连接探测两组分离证据。
- 尚未实现正文、图片、角色和事件图谱的联合展台。
- 尚未实现从联合展台继续一个真实玩家回合。
- 图片 `reconciliation_required` 尚无用户处理界面。
- 本批不能宣称 10 天黑客松闭环完成，也不能宣称 Day 1 的图片 Live 已完成。
