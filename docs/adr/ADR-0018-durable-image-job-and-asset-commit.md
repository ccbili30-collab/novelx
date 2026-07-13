# ADR-0018：持久化图片 Job 与资产提交边界

日期：2026-07-13

状态：Accepted（已接受）

## 背景

真实图片生成会产生费用，不能像普通只读请求一样盲目重试。NovelX 还必须证明图片来自哪个世界、OC 或故事版本，并确保数据库记录与 `.novax` 文件不会互相失配。

## 决策

1. Workspace Schema（工作区数据库结构）升级到 v21，增加 `image_generation_jobs` 与 `image_assets`。
2. Job（任务）以用户范围内的幂等键唯一标识；请求哈希覆盖 Provider、模型、Prompt（提示词）、尺寸、质量、背景、来源资源和来源版本。同一键不同请求必须拒绝。
3. 来源资源和来源版本在收费前验证真实存在；第一版允许引用历史版本，但不允许不存在的字符串作为来源。
4. Job 状态固定为：`queued → running → succeeded|failed|reconciliation_required`。
5. 发起 HTTP 前先持久化 `request_sent_at`。进程中断后：
   - 未记录发送的 `running` Job 可以回到 `queued`；
   - 已记录发送的 Job 必须进入 `reconciliation_required`，禁止自动重试和潜在重复收费。
6. 图片先写 `.novax/assets/tmp`，完成 MIME、字节数、像素和 SHA-256 校验后原子移动到 `.novax/assets/images/<sha256>.<ext>`。
7. 数据库只接受与 MIME 和 SHA-256 精确对应的受管相对路径，不能写入任意路径。
8. 同一工作区的图片生成在桌面主进程内共享串行队列。第一版不支持多个 NovelX 进程同时写同一工作区。
9. Provider 返回明确 HTTP 拒绝或非法结果时 Job 进入 `failed`；连接中断、取消或无法判断请求是否到达 Provider 时进入 `reconciliation_required`。

## 后果

- 大管家工具接线时可以复用同一真实 Responses API（响应接口）客户端、安全文件存储和持久化状态机。
- `reconciliation_required` 需要后续 UI 提供“查看详情/人工确认后重试”，不能被普通“重试”按钮绕过。
- v21 只建立领域能力；在图片服务接入 Main Process（主进程）之前，启动恢复方法不会自动运行。
- 当前只验证单桌面主进程内并发；跨进程文件锁属于明确技术债，不得宣称已经支持。
