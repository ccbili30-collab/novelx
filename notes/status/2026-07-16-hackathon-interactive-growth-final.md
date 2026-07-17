# 2026-07-16 交互式 Growth 最终验收边界

## 当前结论

阶段 6 尚未完成。冻结前的完整 `npm test` 为 795/795、0 skipped；`npm run typecheck`、三组 Prompt
publication（提示词发布门禁）、`npm run build`、`git diff --check` 和无 Provider（模型服务）Electron E2E
5/5 均通过，工作树关联残留进程为 0。

第一次真实 Live（真实运行）因 E2E Harness（验收脚本）定位旧按钮“保存到下一轮”而在模型回执前失败。
产品负责人随后明确授权：仅迁移到当前真实按钮“保存规则修订”，用无 Provider（模型服务）UI 3/3 验证，
再运行一次真实 Live。

第二次运行使用 `openai-compatible / gpt-5.4` 与 `openai-compatible-image / gpt-image-2`。
规则修订 #2 已从 UI 真实保存；Cycle 1 检索、Change Set（变更集）和世界地图均成功，Cycle 2 固定
revision 2 并重新检索，但随后以 `GROWTH_CHANGE_SET_NOT_COMMITTED` blocked，没有成功 proposal 或第二个
Change Set。Coordinator 的真实终态为 blocked；Renderer 保持 Agent 路由，未自动或手动进入 Showcase（创作展台）。
当次 E2E 表面首失败码为 `AUTO_SHOWCASE_NOT_OBSERVED`；只读复核确认旧 Harness 对所有无 watchdog 的终态都继续等待
Showcase，因此遮蔽了更早的 Cycle 2 blocked。Harness 现仅在权威 Coordinator `completed` 时执行原有视觉高潮断言；
blocked/failed 等终态直接交给既有 Coordinator 终态门槛报告。完成路径的视觉断言没有降低。

产品负责人随后明确授权第三次、且仅一次真实 Live。该运行再次从 UI 保存规则修订 #2；Cycle 1 committed 并生成
ready 世界地图。Cycle 2 固定 revision 2，Receipt 含 14 个 links，重新检索和 Inquiry（自询）选择均已持久化，
随后 `run.completed` 以 `tool_failed` blocked；没有成功 proposal、第二个 Change Set 或 output checkpoint。
新 Harness 正确以 `GROWTH_COORDINATOR_TERMINAL_NOT_COMPLETED` 报告真实 Coordinator blocked，没有再次等待
Showcase。证据因此排除空检索和 `user_confirmation_required`；失败位于 Inquiry 后、Change Set executor 前的
Revision Fragment（修订片段）/工具边界。当前安全审计没有记录私有编译错误码或尝试次数，不能继续猜测。

产品负责人随后授权确定性诊断和修复。上游 `pi-agent-core` 源码证明，工具抛错时只把 `Error.message`
作为 `toolResult` 返回模型；而 Revision 编译器原先把八类 allowlisted（白名单）失败全部折叠成同一句
`Growth revision Fragment is invalid.`。状态机虽然允许两次零副作用修正，但模型收不到 authority、impact、reference
或 relation 的具体修正方向，因此这条重试路径在实现上是盲重试。现已在 Revision 阶段内加入固定、无参数/正文的
分类修正指令，并在首次工具描述中写明跨字段不变量；没有放宽 Schema、领域策略、authority 或重试次数。
红色回归先稳定复现泛化消息，修复后证明第一次 impact mismatch 仍停留在同一 proposal 步骤，第二次合法 Fragment
只调用一次真实 executor。该修复解决了可确定复现的 Harness 缺陷，但不能追溯第三次 Live 的具体私有错误码，
也不能在没有新 Live 的情况下宣称 Revision 已真实提交。

产品负责人随后授权修复后的第四次、且仅一次真实 Live。该运行使用
`openai-compatible / gpt-5.4` 与 `openai-compatible-image / gpt-image-2`，再次从 UI 保存 revision 2。
Cycle 1 的文本 Change Set committed，但世界地图以 `IMAGE_GENERATION_FAILED` 结束：持久 Job 1、Asset 0；
正式文本对象和 checkpoint 仍保留。Cycle 2 固定 revision 2，Receipt 含 8 links，重新检索和 Inquiry 已完成；
与前三次不同，审计证明 `propose_change_set` 已 succeeded，说明分类修正已越过 Worker Fragment 编译边界。
但该 Free 提案只留下一个 `pending` Change Set，未绑定 Cycle、未产生 output checkpoint，Cycle 2 因
`GROWTH_CHANGE_SET_NOT_COMMITTED` blocked。因此本次 Live 证明盲重试修复有效，但暴露出下一层策略不一致。

只读代码检查显示：`ChangeSetService` 只会自动提交全部 `low` risk 的 Free Change Set；当前
`WorkspaceChangeSetPolicy` 将 `resource.put(create=false)` 固定评为 elevated，并会把同 identity 的
`assertion.put` 评为 warning/major 后 elevated，而 Revision 编译器和 Main authority 明确允许这两类更新。
这能确定存在“Revision 允许更新、Free Policy 要求人工审查、Coordinator 又只接受 committed”的合同冲突；
但本次安全证据不记录提案项目和 gate reason，不能断言该次具体由 resource update 还是 assertion update 触发。
产品负责人已在 2026-07-17 作出决定：Free 是用户直接放权，合法 Change Set 不再进入人工审查；风险等级保留用于审计，重大冲突、越权、过期 checkpoint、非法领域操作和事务失败仍须失败关闭。实现已删除 elevated 风险触发的 `FREE_REVIEW_REQUIRED` 新提案分支，没有修改重大冲突或领域校验。
确定性冻结证据：Change Set/Gateway/Growth 73/73；全量测试 129 files、799/799、0 skipped；`npm run typecheck`、三组 Prompt publication、`npm run build` 与 `git diff --check` 全部通过。该结果尚未使用新的 Provider，因此不能把历史 pending Revision 改称为 committed。

产品负责人随后授权一次新的真实复验。`openai-compatible / gpt-5.4` 与
`openai-compatible-image / gpt-image-2` 均真实启动；Cycle 1 文本 Change Set committed，世界地图 Job
`succeeded`、`requestSent=true`、`errorCode=null`，并持久化 1 个 Asset，故上一轮
`IMAGE_GENERATION_FAILED` 没有复现，不能归因为稳定地图设计缺陷。Cycle 2 固定 revision 2，Receipt 10 links，
retrieve 与 Inquiry 均完成，但没有 `propose_change_set` 审计调用，最终仍为
`GROWTH_CHANGE_SET_NOT_COMMITTED`。因此 Free 直接提交只取得确定性证据，本次 Live 未实际触发该提交边界。

## 副作用边界

- Cycle 1：committed；Receipt、文本 Change Set 和 output checkpoint 存在；世界地图 Job 1、Asset 0，图像终态为 `IMAGE_GENERATION_FAILED`。
- Cycle 2：blocked；rule revision 2、Receipt、重新检索和成功的 proposal executor 调用存在；另有 1 个未绑定 Cycle 的 pending Change Set，无 output checkpoint。
- 当前正式计数：资源 3、文档 1、断言 3、关系 1；Change Set 共 2 个（1 committed、1 pending），outputs 9，checkpoint 增量 1。
- Closure profile 0；Longform（长文）unavailable；默认/自选 Illustration Request 0。
- 没有 Cycle 3、Closure、万字 OC、默认/自由插图、重开一致性或 research-only 验收。
- 第三次运行结束后没有修改生产代码、Prompt 或验收门槛，也没有再次重跑 Provider。
- 第四次运行结束后没有修改生产代码、Policy、Prompt 或验收门槛，也没有再次重跑 Provider。

## 证据

- 第一次 Harness 失败：`notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-16T14-17-18-079Z.json`
- 第一次 SHA-256：`6C57EADD3E1DC53B9D71A4DC14F558AF44B0EEC19DC2D312006A05BACC87B2EF`
- 第二次交互式边界：`notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-16T15-07-02-921Z.json`
- 第二次 SHA-256：`D5307157EC41DDA10373060D0CA1568C28A099F0D42644A8B749741D77EAEF0E`
- 第三次编译前边界：`notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-16T15-41-18-710Z.json`
- 第三次 SHA-256：`C7F69602CF5833EC199484E6B3969757041DAE69FE7A6E028F39234AAB1E441E`
- 当前最高交互式边界：`notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-16T16-08-36-144Z.json`
- 当前 SHA-256：`11EF515F3F6F03955229F73F36374E746A782F3AF2B84704A9A7A3981B24A3B8`
- 最新 Free/地图复验：`notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-16T16-41-44-817Z.json`
- 最新 SHA-256：`2D238B25DA6FA2F695FDE4DF0D6561C84BA3A7E26F59B2724BE9436F0E049BDD`
- PowerShell UTF-8 `ConvertFrom-Json`：passed
- Node `JSON.parse`：passed
- leak scan：passed
- Electron/Playwright 残留：0

## 恢复入口

Cycle 2 的安全分类已经由第三次真实 Live 触发：Receipt 14 links，排除 `missing_source`；Inquiry 已选中，排除
`user_confirmation_required`；最终 conflict code 为 `tool_failed`。Main 审计没有失败的 proposal invocation 或
error code，说明错误没有形成可持久的 Change Set executor 终态；当前证据只能定位到 Worker 内 Inquiry 后、proposal
提交前的 Revision Fragment/工具路径，不能安全得出具体私有校验码。

Revision 确定性修复回归 6 files / 71 passed / 0 skipped；`npm run typecheck`、三组 Prompt publication、
`npm run build`、`git diff --check` 与工作树 Electron 残留检查均通过。Harness 8/8 仍锁定：只有权威
`completed` 才等待 Showcase，非完成终态不会再被视觉二次错误遮蔽。第四次 Live 已证明模型利用分类修正越过
Fragment 编译曾在第四次 Live 到达真实 Change Set executor。产品负责人已经取消 Free 人工审查边界，本地确定性回归与全量测试通过；但第五次 Live 在 Inquiry 后、proposal 前停止，未实际验证 Free Revision committed。历史 pending 证据不得改写成 committed；只有后续真实 Live 越过 proposal 边界才能证明 Revision Cycle 提交。
在新的 Live 成功前，不得声称交互式 Growth、万字 OC、多图重开或 Windows 打包已经闭环。

### 2026-07-17 精确诊断复验与恢复入口

一次授权复验使用 `openai-compatible / gpt-5.4` 与 `openai-compatible-image / gpt-image-2`。Cycle 1
committed，地图 Job/Asset 均成功；Cycle 2 固定 revision 2 并完成九条 pinned evidence 检索，但在 Change Set
executor 前耗尽三次 Revision 编译纠正：impact mismatch 1/3、document owner reference invalid 2/3、relation
endpoint reference invalid 3/3。三次均无副作用，Cycle 2 没有 Change Set 或 output checkpoint。证据为
`growth-guidance-live-2026-07-16T18-48-26-415Z.json`，SHA-256
`C13A32BC4C3B1B3DDF40D8AEA4D819CE9423A5F4F7B81DE1ADFEBA87C75726DF`，leak scan passed。

根因不是已证实的“模型捏造不存在对象”，而是模型可见检索同时暴露多种真实 ID，而 Fragment 只允许其中一种
引用形式。确定性修复已将 existing targets 改为 `@resourceN/@documentN/@assertionN/@relationN` 别名，并移除
重复的 `impact.additions`。当前只有确定性测试，尚未再次运行 Provider；下一恢复入口是一轮冻结候选的唯一 Revision
Live 复验。

## Windows 打包边界

- `npm run package:dir`：passed。
- `npm run verify:package`：passed；真实启动/退出解包应用，并验证 packaged Worker、Preload、平台和失败关闭。
- `npm run package:win`：passed；生成 `novelx-Setup-0.2.7-x64.exe`。
- 安装包：121,009,169 bytes；SHA-256
  `62E45425D6BF449E6FFA36124B1E7372C83B45D210F344DCFCA091399CB86C64`；签名状态 `NotSigned`。
- 首次 `npm run verify:installer` 在任何测试安装前检测到用户正式安装并以 `PRODUCTION_INSTALL_DETECTED` 失败关闭。
- 产品负责人明确确认旧安装没有需保留的数据并授权覆盖；随后使用官方卸载器静默移除旧 `D:\NovelX`（exit 0）。
- `npm run verify:installer`：passed；隔离安装、两次启动、卸载、应用移除和用户数据保留均通过。
- 当前 0.2.7 已安装到 `D:\NovelX`；实际安装应用用隔离 userData 启动/退出通过。安装后打开已有 Growth
  workspace 未验证，因为旧安装没有可保留的正式 Growth 数据；工作树关联残留进程为 0。
