# 黑客松：图片 Job 与资产领域层

日期：2026-07-13

## 范围

本批实现真实图片生成所需的持久化 Job（任务）、受管图片文件与提交服务。没有接入大管家工具、桌面 Artifact（产物）或联合展台；A2.2 Harness（智能体运行框架）继续冻结。

## 已实现

- Workspace Schema（工作区数据库结构）从 v20 升级到 v21，新增图片 Job 与图片 Asset（资产）表、状态与索引。
- 幂等请求哈希覆盖 Provider（模型服务）、模型、Prompt（提示词）、生成参数和来源版本；同键不同请求失败关闭。
- 收费前验证来源资源与来源版本存在。
- 记录请求是否可能已经发送；崩溃恢复只重新排队确定未发送的任务，可能收费的任务进入 `reconciliation_required`。
- Responses API（响应接口）的真实 `image_generation` 客户端从连接测试中抽出，连接测试和资产服务共享同一协议实现。
- 受管文件写入执行大小、MIME、像素、SHA-256、路径逃逸和临时文件校验；写入使用临时文件、`fsync` 与原子移动。
- 同一工作区的多个服务实例共享串行队列；同幂等请求并发时只调用一次客户端。
- Provider 调用前取消不会调用客户端；明确拒绝进入 `failed`，网络结果未知进入人工核对，不能自动重试。

## 验收

- 定向 Unit（单元测试）最终覆盖：
  - v20 → v21 迁移和旧 v3 连续迁移；
  - Job 幂等冲突、来源验证、发送前/发送后恢复；
  - 文件 MIME、大小、路径逃逸、原子写入、去重和临时文件恢复；
  - 成功提交、并发单次调用、取消零调用、明确失败和结果未知。
- `tests/unit/image-generation-service.test.ts`：5/5 通过。
- 相关六文件合并定向测试：26/26 通过，0 skipped。
- `npm run typecheck`：通过。
- `npm run build`：通过；Steward、Decomposer、GM Prompt publication gate（提示词发布门）均为 verified。
- 本批没有使用真实 Provider 运行完整“HTTP → 文件 → SQLite”链路；现有真实代理只在上一批完成过连接和图片结果探测。因此本批不能标记为 Asset Live（资产真实运行）验收。
- 未运行全量 `npm test`；按黑客松冻结计划集中运行。

## 未完成与风险

- 图片生成服务尚未在 Main Process 注册，也未从大管家工具调用。
- `recoverInterruptedJobs()` 尚未接入工作区启动流程。
- `reconciliation_required` 尚无用户处理界面。
- 跨进程同时写同一工作区未支持；当前可靠边界是单 NovelX 主进程。
- 图片 Artifact、来源跳转、过期检测和联合展台未实现。
