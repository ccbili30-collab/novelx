# 基础项目文件工具回归测试

## 目标

覆盖用户报告的真实失败场景：当前项目没有 `README.md`，但根目录存在：

- `01-力量体系.md`
- `02-场景地图与世界观.md`
- `03-人物关系图.md`
- `04-物品大全.md`

用户要求“检查当前项目文件”时，Agent 必须先发现真实目录，再按真实路径读取；单个猜测路径不存在不能被解释成“没有授权”。

## 自动化覆盖

`tests/unit/project-basic-file-tools.test.ts` 直接通过 Main（主进程）文件工具网关验证：

- `read_project_file` 读取不存在的 `README.md` 返回 `PROJECT_FILE_NOT_FOUND`；
- `list_project_directory` 返回四个真实中文文件名；
- `glob_project_files` 可以发现全部 Markdown 文档；
- `stat_project_file` 返回真实文件元数据和 SHA-256；
- `search_project_files` 可以按正文检索；
- `read_project_file` 可以读取四个文档的完整正文。

`tests/e2e/real-provider-project-files.spec.ts` 使用保存的真实 Provider（模型服务）配置时验证完整 Agent 链路。没有本机 Provider 存储时明确跳过，不使用 Mock（模拟）结果冒充真实模型验收。

## Electron 清理边界

真实 Provider E2E 使用 `tests/e2e/support/electronCleanup.ts` 清理窗口。清理器只记录并处理该测试启动 PID 的进程树：

- 先请求 Playwright 正常关闭；
- 关闭超时后，只终止启动时记录的测试进程树；
- 不按 `NovelX` 应用名、安装路径或全部 `electron.exe` 批量结束进程。

这避免再次误关用户正式安装的 NovelX。

## 本次验证

```text
3 个单元测试文件通过，9 项测试通过。
真实 Provider E2E 在未提供 NOVAX_REAL_E2E_PROVIDER_STORE 时：2 项明确跳过，命令成功退出。
```

尚未完成：当前工作区没有可供本测试读取的真实 Provider 存储，因此本轮没有宣称真实模型场景已经通过；发布前仍必须在已配置 Provider 的机器上运行该 E2E。
