# Runtime V2 Actor Drain Foundation（运行时 Actor 排空地基）

日期：2026-07-13

## 本批完成

- `RuntimeActor`（运行时 Actor）停止流程由“先写 `runtime.stopped`、再 `abort_all`”改为显式两阶段状态机：

```text
Running（运行中）
  -> BeginDrain（开始排空）
  -> Draining（正在排空）
  -> Drained（已排空）
  -> FinishStop（完成停止）
  -> flush runtime.stopped
  -> 退出
```

- `BeginDrain` 只建立停止边界，不写 `runtime.stopped`：
  - 拒绝随后到达的 `StartTask`（启动任务）。
  - 保留已接受任务，不调用 `abort_all`，等待任务自己的终态输出完成。
  - 继续接受 `Emit`（输出）命令，避免丢失排空期间的控制面或审计输出。
- 只有 `JoinSet` 已空时才从 `Draining` 进入 `Drained`；这意味着所有正常返回的任务终态已经由单写入者写入并 flush。
- `RuntimeDrain::finish_stop`（完成停止）必须先观察 `Drained`，再把 `FinishStop` 作为一条新的 mailbox（邮箱）命令排队。排在它前面的 `Emit` 必须先写出，之后才允许写入并 flush `runtime.stopped`。
- 所有 `StartTask` 现在都有 oneshot acknowledgement（一次性确认）：调用方只有在 Actor 写出 accepted 输出、注册取消句柄并真正接纳任务后才返回成功；排空后的启动返回明确的 `RuntimeActorError::Draining`。
- command mailbox（命令邮箱）异常关闭不会合成 `runtime.stopped`，也不会中止仍在运行的任务；已有任务可自然结束，邮箱关闭且任务清空后 Actor 无停止事件退出。
- stdout（标准输出）在任务终态或停止输出期间失败时，Actor 返回真实 I/O 错误，不继续伪造 `runtime.stopped`。

## 验证证据

- `cargo test -p novelx-runtime --test runtime_actor -- --test-threads=1`：10/10 通过。
- `cargo clippy -p novelx-runtime --test runtime_actor -- -D warnings`：通过。
- 定向覆盖：
  - 已接纳任务的终态严格先于 `runtime.stopped`。
  - `BeginDrain` 后的新任务被明确拒绝。
  - `Drained` 后、`FinishStop` 前排队的 `Emit` 严格先于 `runtime.stopped`。
  - 无任务时立即完成两阶段排空。
  - mailbox 异常关闭不写 `runtime.stopped`。
  - 任务终态 stdout 写入失败后不尝试写 `runtime.stopped`。

## 明确未完成

- 本批没有修改 `main.rs`，没有把 Host shutdown（宿主关闭）、EOF（输入结束）或 Runtime cancellation hub（运行时取消中心）接到 `BeginDrain`。
- 本批没有实现 Host command pump（宿主命令泵）或 shutdown signal -> task terminal -> Drained 的完整控制面；实机中永久不返回的任务仍会使 drain 一直等待。这是拒绝假“优雅停止”的有意 fail-closed（失败关闭）行为，但还不是完整关闭闭环。
- task panic（任务恐慌）仍由既有 `TaskJoin` 错误路径终止 Actor，不会伪造任务终态或 `runtime.stopped`；后续需要在任务执行契约层决定是否允许把可证明的 panic 转换为正式失败终态。
- `Emit` 当前没有独立 acknowledgement；本批只给会产生新异步工作的 `StartTask` 增加了接纳确认。`FinishStop` 通过 mailbox 顺序保证其前置输出已被 Actor 处理。
- 因此，本批只是 ADR-0016 的 Actor 排空地基，不能宣称 shutdown / EOF / Run cancel（任务取消）已经形成实机闭环。
