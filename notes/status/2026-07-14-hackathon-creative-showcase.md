# 黑客松：来源绑定联合创作展台

日期：2026-07-14

实现提交：`c5526d1 feat(showcase): add source-bound creative showcase`

前置图片工具提交：`0af8546 feat(image): connect source-bound steward generation`

## 已完成

- 新增 `showcase.get` 只读 IPC（进程间通信）查询；输入真实故事资源 ID，从当前活动分支聚合：
  - 故事及其卷、章节的稳定正文。
  - `uses_world` 与 `uses_oc` 关系绑定的世界和 OC 稳定文档。
  - 与上述资源或稳定版本存在来源交集的图片 Job（任务）与 Asset（资产）。
  - 仅属于上述资源范围的 Creator Lens（创作者视角）图谱节点和内部边。
- 查询不读取 working copy（工作副本），不复制或合并 Canon（正史），不暴露图片 Prompt、Provider、模型、磁盘路径、哈希或密钥。
- 图片状态保留 `queued / generating / ready / stale / failed / reconciliation_required`；只有 `ready / stale` 可返回 `novax-asset://` 受管 URL。
- 桌面端新增“作品预览”模式，同屏显示主视觉、稳定正文、OC 角色卡和可交互图谱；可切换多个故事，并可跳回真实资源或文档。
- 大管家返回 ready 图片 Artifact（产物）后，会根据图片来源绑定定位故事并自动打开展台；多个故事且来源无法唯一判定时不会猜测。
- 图谱检查器继续使用 Main（主进程）范围校验，Renderer（渲染层）不能扩大 Creator Lens 查询范围。

## 验收

- `npm test`
  - Unit（单元）：91 个文件，440/440 通过，0 skipped。
  - Integration（集成）：3 个文件，22/22 通过，0 skipped。
  - 合计：462/462 通过。
- `npm run typecheck`：通过。
- `npm run build`：Main、Preload（预加载桥）与 Renderer 生产构建通过；三组 Prompt 发布门通过。
- `npx playwright test tests/e2e/creative-showcase.spec.ts --workers=1`：2/2 通过。
  - 验证稳定正文、来源绑定图片、OC 与范围图谱同屏出现。
  - 验证 `novax-asset://` 图片可加载。
  - 验证未打开工作区时失败关闭。
- 1440×900 截图人工检查：四个区域可在同一屏看到。
- 已扫描已知测试密钥片段与 `sk-*` 形态：无源码命中。
- 测试结束后匹配当前工作区的 Electron 残留进程：0。

## 证据边界

- E2E 使用明确标注的 2×2 PNG Fixture（测试夹具）验证持久化资产和受管 URL，不是图片 Provider（模型服务）Live（真实运行）证据。
- 本批没有重新验证完整 `Steward → 真实图片 Provider → 持久化 → 展台` Live 链。旧图片安全存储密文无法由当前 Windows `safeStorage` 解密，用户需要在 NovelX 设置中重新保存图片 API Key 后才能进行该验收。
- 本批没有使用真实文本 Provider；真实文本 Prompt Eval 的既有证据仍是 11/11 通过，不等于本批 UI 的真实生图验收。

## 未完成与冻结项

- Task 7“从展台进入玩家续写”尚未实现：展台还不能一键建立 Story Profile（故事配置）并继续一回合。
- 玩家回合卡尚未显示已绑定场景图；完整 Creator Lens 不会进入玩家 UI，避免泄露玩家未知事实。
- 图片来源版本变化后的自动 stale 标记尚未验收；展台只忠实显示仓储中的现有状态。
- 未执行 Windows 安装包和更新链路验收。
- A2.2 Harness（智能体运行框架）、Hub、Coordinator、oh-my-pi 与底层权限保持冻结，未在本批修改。
- GitHub 推送仍受本机失效 GitHub 凭据阻塞；本地提交完整保留在 `codex/stage4-memory-stage5-6`。

## 后续入口

1. 在 NovelX 设置中重新保存图片 Provider 凭据，执行一次完整真实生图展台链并保存脱敏证据。
2. 进入 Task 7：从展台显式创建或选择 Story Profile，绑定 `uses_world / uses_oc`，使用现有真实 GM/Writer 链继续一个回合。
3. 最后集中执行三次完整演示脚本、故障场景和 Windows 安装包验收。
