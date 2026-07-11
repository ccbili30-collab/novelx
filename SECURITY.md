# Security Policy

## 报告安全问题

请不要在公开 Issue 中提交 API Key、访问令牌、私人小说内容、未公开世界观资料或可复现的敏感数据。

发现安全问题时，请通过 GitHub 仓库所有者的私有联系方式报告，并提供：受影响版本、最小复现步骤、影响范围和建议修复方式。

## 密钥处理

- novelx 不要求把 Provider 密钥写入项目文件。
- 本地凭据通过 Electron `safeStorage` 加密保存。
- 测试和日志不得输出完整密钥。
- 没有可用 Provider 时，正式 Agent 路径必须失败关闭。
