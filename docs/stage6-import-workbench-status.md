# Stage 6 Import Workbench Status

Date: 2026-07-11

## Completed

- Source Library（来源库）在 Renderer（渲染进程）中仅展示公开投影，不暴露原始路径、数据库字段或内部调试信息。
- 用户可以声明资料权利状态，通过 Windows 原生文件选择器添加 TXT、Markdown、DOCX、EPUB 和图片资料。
- 已注册来源可以显式解析；解析失败通过稳定错误码映射为玩家可理解的信息。
- Decomposition Candidate（拆解候选）列表保留来源片段、结构化定位和内容哈希，可供人工核对。
- 待审核候选可以修改后保存为新的不可变用户修订，并可以接受或拒绝。
- Event Candidate（事件候选）的时间点、时间范围或事件顺序可以在审核界面中校正。
- 已接受候选可以被显式标记为起点依据、原著未来排除项或不使用。
- 用户可以为一个现有 Story Profile（故事配置）创建 Active Start Profile（启用的起始模板），成功后有可见确认。
- Decomposer（拆解器）已通过正式 Provider eval（模型提供方评测），入口连接真实子进程监督器，支持运行、取消、失败和候选刷新。

## Not Completed

- 已接受候选尚不能转换为带明确目标世界或故事的 Change Set（变更集）提案，因此不会写入 Canon（正史）。
- 原生文件选择器流程没有自动化点击覆盖；解析器、IPC 和已注入来源的可见审核流程已有覆盖。
- 大文件解析仍没有进度、取消和后台任务恢复界面。
- 图片导入仅记录可验证的格式和尺寸元数据，没有 OCR（光学字符识别）或视觉理解。
- 本批次尚未生成 Windows 安装包，也没有发布新版本。

## Functional Reduction Risks

- 当前 Source Library 是可审核导入工作台，不是自动反编译器。用户必须等待后续真实 Decomposer 运行边界完成。
- Start Profile 只消费人工接受的候选引用，不会自动把候选提升为世界事实；这是有意的 fail-closed（失败关闭）边界。
- 来源片段当前最多投影 2,000 字符，足够核对候选但不是完整文档阅读器；稳定定位和内容哈希用于回查与审计。
- 图片没有 OCR 时不能产出人物、世界规则或事件候选；任何此类内容都必须保持为空而不是猜测。

## Verification

- TypeScript typecheck（类型检查）：通过。
- Vitest：68 个测试文件、271 个测试通过。
- Production build（生产构建）：通过。
- Electron Playwright 全量基线：32 个通过，1 个真实 Provider 测试因没有外部测试凭据而跳过。
- Import Workbench（导入工作台）E2E 覆盖来源候选审核、事件时间修订、候选用途和 Start Profile 创建。
- `git diff --check`：通过。
- 明文 API key（应用程序接口密钥）扫描：无匹配。
