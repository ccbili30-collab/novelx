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
- 已创建并公开 Git tag `v0.2.0` 与 GitHub Release：`https://github.com/ccbili30-collab/novelx/releases/tag/v0.2.0`。
- GitHub Release 已上传 NSIS 安装包、blockmap（增量更新块映射）和 `latest.yml`；远端资产摘要与本地产物一致。
- 真实安装旧版 `0.1.0` 后，通过旧客户端自身的 Update API（更新接口）检查公开更新源，返回 `kind: available`、`availableVersion: 0.2.0`、`canDownload: true`。
- 旧版更新检查已固化为可重复执行的 `npm run verify:update-from-old-client`，证据写入 `test-results/novax-update-0.1.0-to-0.2.0.json`。

## Artifacts

- `release/novelx-Setup-0.2.0-x64.exe`
  - Size: `120726535` bytes
  - SHA-256: `a6cc93e9254f7c383f5b15d08b950ee46fdd03c2fac8766cac3f50c6dd84f299`
- `release/novelx-Setup-0.2.0-x64.exe.blockmap`
  - Size: `127591` bytes
  - SHA-256: `69ec8cd4b9bfc5b33af17697ca077632e783f1180a09e85720ba4018addd7a01`
- `release/latest.yml`
  - Size: `349` bytes
  - SHA-256: `88ed683101f44860aa502936315a517e182a32d2cb003715e0f8006b2e7babd8`

## Not Completed

- 安装包和应用的 Authenticode 状态均为 `NotSigned`。Windows SmartScreen 可能显示未知发布者警告。
- 没有可用的 Windows 代码签名证书，不能把代码签名标记为完成。

## Verification

- Package verification（包验证）：通过；ASAR 17849 个条目，禁止测试/凭据/数据库文件未打包。
- Installer verification（安装器验证）：对 GitHub Release 实际公开的安装包执行并通过；安装两次、卸载应用、保留用户数据。
- Old-client update verification（旧客户端更新验证）：通过；`0.1.0` 从公开 GitHub 更新源发现 `0.2.0`，并进入可下载状态。
- Signature status（签名状态）：`NotSigned`，已如实记录。
