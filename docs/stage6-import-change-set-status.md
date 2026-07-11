# Stage 6 Import Change Set Status

Date: 2026-07-11

## Completed

- 用户必须显式选择目标 World（世界）、Story（故事）或 OC（原创角色），并勾选已接受候选。
- ambiguity（歧义）候选不能进入自动提案，必须先由用户裁定。
- World Rule（世界规则）和 Event（事件）转换为 draft Canonical Assertion（草稿权威断言），范围类型与目标资源一致。
- Character（人物）、Location（地点）和 Faction（势力）转换为资源、资料文档定义和文档内容三个有依赖关系的 Change Set item（变更集项目）。
- Style（风格）转换为目标范围内的 Constraint Profile（约束配置）。
- 所有导入提案固定使用 Assist（协助）模式，进入现有逐项审核门，不会自动提交 Canon（正史）。
- Schema 18 新增不可变候选修订到 Change Set item 的来源关联。
- assertion.put 的策略和提交路径识别已接受导入候选，提交后来源类型记录为 `import_candidate`，不伪装成普通文档版本。
- 可见导入工作台支持目标选择、候选勾选和生成待审核变更集。

## Not Completed

- 尚未在导入工作台内嵌完整 Change Set 审核器；生成后使用现有全局审核面板。
- 尚未增加批量目标分配，例如不同候选分别进入不同世界、故事或 OC。
- 尚未执行 Windows 安装包和升级包验收。

## Functional Reduction Risks

- 同一次提案当前只有一个目标资源；需要跨世界分配时应分多次提案，不能隐式猜测目标。
- 导入对象使用确定性 ID 保证重试幂等，但用户需要在审核面板决定是否接受、拒绝或保留草稿。
- 候选到 Change Set 的关联在提案后写入；数据库严重故障可能留下没有完整关联的 pending Change Set，后续应增加一致性 Doctor（检查器）。

## Verification

- 领域测试覆盖已接受规则与地点候选、Assist 审核状态、四类 Change Set item 和四条不可变来源关联。
- 可见 E2E 覆盖目标选择、候选勾选、生成两项待审核 Change Set，并确认没有自动提交。
