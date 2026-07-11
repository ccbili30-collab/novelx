# Stage 5-6 Release 0.2.0 Status

Date: 2026-07-11

## Completed

- Desktop version（桌面版本）从 `0.1.1` 提升为 `0.2.0`。
- 更新源固定为公开 GitHub Release：`https://github.com/ccbili30-collab/novelx/releases/latest/download`。
- 生成 Windows x64 NSIS 安装包、blockmap（增量更新块映射）和 `latest.yml`。
- Packaged App Verification（打包应用验证）确认主进程、Agent Worker、Preload（预加载层）、Renderer（渲染层）和 Pi Runtime 均包含且可启动。
- 打包应用在隔离用户目录启动，窗口标题、平台、Preload API 和无工作区初始状态验证通过。
- Installer Lifecycle（安装器生命周期）完成静默安装、首次启动、二次启动、用户数据保留、卸载及卸载后用户数据保留。
- 安装包与应用均未发现 Provider credential（模型提供方凭据）泄露。

## Artifacts

- `release/novelx-Setup-0.2.0-x64.exe`
  - Size: `120726513` bytes
  - SHA-256: `b9218c96ba2ab69beae5c7ee65d70e0292941c5cae8a6b860c9a55926ded5b05`
- `release/novelx-Setup-0.2.0-x64.exe.blockmap`
  - Size: `127414` bytes
  - SHA-256: `a1a8a0257c5f5c2c0ebb2a9db95ca17ef47676e5346427b5d74ad5be37bf811e`
- `release/latest.yml`
  - Size: `349` bytes
  - SHA-256: `89c5474e7e7b143019574bfc1ac3a75fa4ca3910b5935c5e1185dfd3b42e4628`

## Not Completed

- 安装包和应用的 Authenticode 状态均为 `NotSigned`。Windows SmartScreen 可能显示未知发布者警告。
- 尚未创建 Git tag、GitHub Release 或上传 `0.2.0` 资产，因此已安装应用当前还不能从 GitHub 下载该版本。
- 没有可用的 Windows 代码签名证书，不能把代码签名标记为完成。

## Verification

- Package verification（包验证）：通过；ASAR 17849 个条目，禁止测试/凭据/数据库文件未打包。
- Installer verification（安装器验证）：通过；安装两次、卸载应用、保留用户数据。
- Signature status（签名状态）：`NotSigned`，已如实记录。
