# 黑客松 Day 1：独立图片 Provider 配置批次

日期：2026-07-13

## 范围

本批只完成真实图片 Provider（模型服务）的独立配置、安全存储、连接测试与桌面设置入口。A2.2 Harness（智能体运行框架）继续冻结；本批没有进入图片资产、大管家工具、联合展台或玩家续写。

## 已实现

- 新增版本化图片 Provider 配置协议和四个独立 IPC（进程间通信）入口：读取状态、保存、清除凭据、真实生成测试。
- Electron `safeStorage` 单独加密图片 API Key（接口密钥）；文本 Provider 与图片 Provider 不共享凭据文件。
- Base URL（服务地址）强制 HTTPS，HTTP 只允许精确本机回环地址。
- 真实测试调用 `/v1/responses` 的 `image_generation` 工具，校验 Base64、大小、PNG/JPEG/WebP 文件头和像素，并只向界面返回脱敏元数据与 SHA-256。
- 设置页增加独立的图片模型表单、费用提示、保存、替换、清除和真实生成测试状态。
- 本机测试配置已写入 `%APPDATA%\\novelx-desktop\\image-provider-profile.v1.json`；凭据为系统加密值，工作区与配置文件均未发现明文密钥。

## 验收证据

- 真实代理探测：通过 `codex-imagen2` 的 OpenAI-compatible Responses 路径生成有效 PNG，耗时 27.8 秒，尺寸 1254×1254，字节数 1,098,438，SHA-256 为 `e42a9ee8a946ed7d22421ffeeca826bfd5310c7e0aacf7b1bc8663aa8dedf1d1`。
- 定向 Unit（单元测试）：37/37 通过，0 skipped；包括安全存储 4、连接协议 3、IPC 合同 30。
- Playwright 设置页 E2E（端到端测试）：1/1 通过；证明默认参数可见、凭据不进入 Renderer 或工作区、清除凭据生效。
- `npm run typecheck` 通过。
- `npm run build` 通过；Prompt publication gate（提示词发布门）均为 verified。
- 工作区明文密钥扫描无命中。

## 未完成与冻结边界

- 尚未建立持久化 Image Job（图片任务）和 Image Asset（图片资产）。
- 尚未把图片生成作为大管家领域工具接入真实 Agent 调用链。
- 尚未实现正文、角色、图片和事件图谱联合展示。
- 尚未执行本批合并后的全量 `npm test`；全量测试按黑客松最终冻结规则集中运行。
- `tests/e2e/change-set-ui.spec.ts` 中另有“提交后即时刷新”的红测试，属于下一项 P0，不纳入本批提交和完成声明。

## 测试窗口事故

一次本地凭据引导命令错误使用 Electron `-e`，导致内联脚本被当成应用路径并弹出 `Error launching app`。该错误不是安装版 NovelX 故障。错误工作区 Electron 进程与临时脚本已清理，安装版进程未被结束。后续禁止用 Electron `-e` 执行内联脚本。
