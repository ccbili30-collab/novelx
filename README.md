<p align="center">
  <img src="./build/icon.png" width="160" alt="NovelX 应用图标" />
</p>

# novelx

novelx 是一个面向小说、世界观与原创角色创作的 Windows 桌面工作台。它使用 Electron（桌面运行壳）、React（界面框架）与 TypeScript（类型化 JavaScript），通过真实模型 Provider（模型服务商）运行大管家、Writer（写手）和 Checker（检查器）。

> 当前版本仍处于早期开发阶段。没有配置真实 Provider 时，Agent 会按设计阻塞，不会用本地规则或假内容冒充模型结果。

## 产品与开发文档

- 新会话从 [`CONTEXT.md`](CONTEXT.md) 开始，不需要重读历史聊天。
- 完整长期产品需求见 [`docs/product/novelx-desktop-product-requirements.md`](docs/product/novelx-desktop-product-requirements.md)。
- 长期架构与上游融合计划见 [`docs/architecture/novelx-desktop-long-term-architecture.md`](docs/architecture/novelx-desktop-long-term-architecture.md)。
- 当前真实完成度与双轨开发路线见 [`docs/project/current-state-and-routes.md`](docs/project/current-state-and-routes.md)。

## 当前能力

- Agent Mode（Agent 模式）与 IDE Mode（编辑工作台模式）。
- 多项目、多会话和独立 Agent 会话历史。
- 世界、OC（原创角色）、故事、卷、章节、地点、势力与知识文档。
- Change Set（变更集）审查、版本与分支、图谱检索和来源定位。
- Markdown / GFM、Mermaid（结构图）与结构化 Agent Artifact（产物）展示。
- OpenAI-compatible Provider（OpenAI 兼容模型服务）配置和本地加密凭据存储。
- Windows 安装包与应用内自动更新客户端。

## 安装

前往 [Releases](https://github.com/ccbili30-collab/novelx/releases) 下载最新的 `novelx-Setup-*-x64.exe`。

当前安装包尚未进行 Windows 代码签名，因此首次安装可能出现 SmartScreen（智能屏幕）警告。请只从本仓库 Releases 下载。

## 本地开发

环境要求：

- Windows 10/11
- Node.js 22 或更新版本
- npm

```powershell
npm ci
npm run typecheck
npm test
npm run dev
```

构建 Windows 安装包：

```powershell
npm run package:win
```

构建带自动更新元数据的安装包：

```powershell
$env:NOVAX_UPDATE_URL = "https://github.com/ccbili30-collab/novelx/releases/latest/download"
npm run package:update
```

## Provider 配置

API Key（接口密钥）只应通过软件设置页输入。不要把密钥写入源码、Issue、日志或提交记录。

## 验证

```powershell
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run verify:package
```

真实 Provider E2E（端到端测试）只有在显式注入测试凭据时运行；缺少凭据时会跳过，不会伪造通过结果。

## 开源许可证

本项目使用 [GNU Affero General Public License v3.0](LICENSE)。通过网络向用户提供修改版本时，也必须向对应用户提供该修改版本的完整源代码。
