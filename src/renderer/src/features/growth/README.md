# Growth Renderer 路由

本目录只展示 Main（主进程）投影的安全 Growth（生长）状态，并收集 Creator（创作者）的配图意图。它不判断 Canon（正式事实）、checkpoint（检查点）、权限、工具结果或图片是否成功。

## 最短阅读路径

| 任务 | 先读 | 定向测试 |
| --- | --- | --- |
| 修改规则/影响/闭环摘要 | `growthPresentationViews.ts` | `growth-guidance-status.test.ts`、`growth-illustration-gallery.test.ts` |
| 修改中央安全摘要 UI | `GrowthGuidanceStatus.tsx`、`GrowthImpactSummary.tsx` | 上述纯投影测试、`growth-presentation-ui.spec.ts` |
| 修改资源/图谱节点/文本自由配图 | `GrowthIllustrationGallery.tsx` | `growth-illustration-gallery.test.ts`、Main 配图投影/协调器测试 |
| 修改持久状态来源 | 不在 Renderer 修改 | `src/main/growth/growthPresentationProjector.ts` |

## 不变量

- 只有 `status=ready` 且同时具有受管 `assetId` 与 `novax-asset://image/...` 缩略图的 Item 才能显示为可打开成品。
- failed、cancelled、stale、reconciliation_required 均保留真实状态，不伪装为 ready。
- 影响计数只汇总 committed/evaluated Cycle；运行中的候选不能显示为已提交。
- 自询只显示 `safeSummary`，Checker 只显示安全 Finding；不展示原始思维链、Prompt、工具参数、locator、hash 或路径。
- 每页最多显示 100 个 Item，但用户可继续翻页、重复请求或为每个节点创建配图。
- 画风不填时由已冻结的默认漫画感手绘策略决定；用户显式填写时才覆盖。

## 定向验收

```powershell
npx --no-install vitest run --config vitest.config.ts tests/unit/growth-guidance-status.test.ts tests/unit/growth-illustration-gallery.test.ts tests/unit/growth-presentation.test.ts
npm run typecheck
npm run build
npx --no-install playwright test tests/e2e/growth-presentation-ui.spec.ts --workers=1
git diff --check
```

上述桌面 E2E 是无 Provider 的失败关闭证据，不是图片 Live（真实运行）。
