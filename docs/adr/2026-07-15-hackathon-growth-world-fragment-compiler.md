# ADR: Growth world Fragment compiler

世界 Growth Cycle 的模型可见 `propose_change_set` 输入改为严格的 World Fragment。模型只提供标题、正文、事实和 `related_to` 选择；Worker 只生成确定性 ID、初始化 root 下的父级、create/state、排序、Change Set item ID、依赖和同一 Change Set 文档来源占位符。

Fragment 不持久化、不产生中间领域写入，也不增加 Change Set 或 post-apply retry。编译完成后仍只调用一次既有 Main Gateway、Policy 和 ChangeSetService。失败发生在该调用前时保持零副作用，并仅使用固定错误码。

world 最低要求为一个 world、一个 setting 稳定文档和至少三个由模型提供、各自引用 Fragment 文档来源的 Assertion；location、faction、附加文档、更多事实及 `related_to` 均为开放数组。0、1、2 条 Assertion 会在调用执行器前以既有 `GROWTH_FRAGMENT_INVALID` 失败，并沿用既有有界纠正；不新增公开错误码。

编译器不得用模板、确定性规则或本地降级补足 Assertion。每条 Assertion 的 subject、predicate、object 和文档来源选择仍来自模型 Fragment；编译器只生成 Assertion ID、Change Set item ID、依赖和 `greenfield_document_output:` 来源占位符，保留接受的创作事实值。

story/oc、图片、公开 IPC、迁移、Canon/Lens/权限均不属于本 ADR 的实现范围。
