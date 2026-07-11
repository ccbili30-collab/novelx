import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  PlugZap,
  Save,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import type { ProviderStatusResult } from "../../../../shared/providerContract";
import type { ProviderTestResult } from "../../../../shared/providerContract";
import type { ContextBudgetAudit } from "../../../../shared/ipcContract";
import {
  createProviderSettingsForm,
  describeProviderStatus,
  parseProviderSettingsForm,
  type ProviderSettingsForm,
} from "../../../../shared/providerSettingsModel";
import type { NovaxTheme } from "../../../../shared/themePreference";
import { DesktopUpdatePanel } from "../update/DesktopUpdatePanel";

interface ProviderSettingsDialogProps {
  theme: NovaxTheme;
  onThemeChange(theme: NovaxTheme): void;
  onClose(): void;
}

type FieldErrors = Partial<Record<keyof ProviderSettingsForm | "apiKey", string>>;

export function ProviderSettingsDialog({ theme, onThemeChange, onClose }: ProviderSettingsDialogProps) {
  const [statusResult, setStatusResult] = useState<ProviderStatusResult | null>(null);
  const [form, setForm] = useState(() => createProviderSettingsForm(null));
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [operationError, setOperationError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
  const [runtimeBudget, setRuntimeBudget] = useState<ContextBudgetAudit | null>(null);
  const status = useMemo(() => describeProviderStatus(statusResult), [statusResult]);

  useEffect(() => {
    let active = true;
    void window.novaxDesktop.provider.getStatus().then((result) => {
      if (!active) return;
      setStatusResult(result);
      if (result.ok) setForm(createProviderSettingsForm(result.state.config));
    }).catch(() => {
      if (active) {
        setStatusResult({
          ok: false,
          error: { code: "PROVIDER_STORAGE_FAILED", message: "模型服务安全配置读取失败。" },
        });
      }
    });
    void window.novaxDesktop.workspace.getLatestContextBudget().then((budget) => {
      if (active) setRuntimeBudget(budget);
    }).catch(() => {
      if (active) setRuntimeBudget(null);
    });
    return () => {
      active = false;
      setApiKey("");
    };
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving && !clearing) closeDialog();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  });

  function updateField<K extends keyof ProviderSettingsForm>(field: K, value: ProviderSettingsForm[K]) {
    setForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setOperationError(null);
    setSavedMessage(null);
    setTestResult(null);
  }

  function closeDialog() {
    setApiKey("");
    onClose();
  }

  async function saveProvider(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOperationError(null);
    setSavedMessage(null);
    const parsed = parseProviderSettingsForm(form, apiKey, status.kind === "configured");
    if (!parsed.ok) {
      setFieldErrors(parsed.fieldErrors);
      return;
    }

    setSaving(true);
    try {
      const result = await window.novaxDesktop.provider.save(parsed.request);
      setStatusResult(result);
      if (!result.ok) {
        setOperationError(result.error.message);
        return;
      }
      setApiKey("");
      setShowApiKey(false);
      setFieldErrors({});
      setConfirmingClear(false);
      setSavedMessage("配置已安全保存，尚未验证服务连接。");
      setForm(createProviderSettingsForm(result.state.config));
    } catch {
      setOperationError("模型服务配置保存失败。凭据未被确认保存。");
    } finally {
      setSaving(false);
    }
  }

  async function clearCredential() {
    setClearing(true);
    setOperationError(null);
    setSavedMessage(null);
    try {
      const result = await window.novaxDesktop.provider.clearCredential();
      setStatusResult(result);
      if (!result.ok) {
        setOperationError(result.error.message);
        return;
      }
      setApiKey("");
      setShowApiKey(false);
      setConfirmingClear(false);
      setSavedMessage("凭据已清除。模型配置参数仍保留在本机。");
      setForm(createProviderSettingsForm(result.state.config));
    } catch {
      setOperationError("凭据清除失败，请重试。");
    } finally {
      setClearing(false);
    }
  }

  async function testConnection() {
    setOperationError(null);
    setSavedMessage(null);
    const parsed = parseProviderSettingsForm(form, apiKey, status.kind === "configured");
    if (!parsed.ok) {
      setFieldErrors(parsed.fieldErrors);
      return;
    }
    setTesting(true);
    try {
      const result = await window.novaxDesktop.provider.test(parsed.request);
      setTestResult(result);
      if (result.ok && result.contextWindowSource === "provider") {
        setForm((current) => ({ ...current, contextWindow: String(result.contextWindow) }));
      }
    } catch {
      setTestResult({
        ok: false,
        error: { code: "PROVIDER_CONNECTION_FAILED", message: "Provider（提供方）连接测试失败。" },
      });
    } finally {
      setTesting(false);
    }
  }

  const unavailable = status.kind === "unavailable";
  const busy = saving || clearing || testing;

  return (
    <div className="settings-backdrop" data-testid="provider-settings-backdrop">
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-settings-title">
        <header className="settings-header">
          <div>
            <span className="settings-kicker">SETTINGS（设置）</span>
            <h1 id="provider-settings-title">novelx 设置</h1>
          </div>
          <button className="icon-command" type="button" onClick={closeDialog} disabled={busy} title="关闭设置">
            <X size={17} aria-hidden="true" />
            <span className="sr-only">关闭设置</span>
          </button>
        </header>

        <div className="settings-scroll">
          <section className="appearance-settings" aria-labelledby="appearance-settings-title">
            <div>
              <strong id="appearance-settings-title">外观主题</strong>
              <span>界面选择会保存在当前设备。</span>
            </div>
            <div className="theme-options" role="radiogroup" aria-label="外观主题">
              {([
                ["white", "白色"],
                ["cloude", "cloude"],
                ["dark", "深色"],
                ["high-contrast", "高对比度"],
              ] as const).map(([value, label]) => (
                <button key={value} data-testid={`theme-${value}`} type="button" role="radio" aria-checked={theme === value} onClick={() => onThemeChange(value)}>
                  <span className={`theme-swatch theme-swatch--${value}`} aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
          </section>

          <DesktopUpdatePanel />

          <ProviderStatus state={status} />

          {operationError ? (
            <div className="settings-message settings-message--error" role="alert">
              <AlertTriangle size={15} aria-hidden="true" />
              <span>{operationError}</span>
            </div>
          ) : null}
          {savedMessage ? (
            <div className="settings-message settings-message--success" role="status">
              <CheckCircle2 size={15} aria-hidden="true" />
              <span>{savedMessage}</span>
            </div>
          ) : null}

          <form className="provider-form" onSubmit={(event) => void saveProvider(event)} noValidate>
            <div className="provider-form-grid">
              <ProviderTextField label="Provider ID（提供方标识）" error={fieldErrors.providerId}>
                <input
                  name="providerId"
                  value={form.providerId}
                  onChange={(event) => updateField("providerId", event.target.value)}
                  autoComplete="off"
                  disabled={unavailable || busy}
                  aria-invalid={Boolean(fieldErrors.providerId)}
                />
              </ProviderTextField>
              <ProviderTextField label="Display Name（显示名称）" error={fieldErrors.displayName}>
                <input
                  name="displayName"
                  value={form.displayName}
                  onChange={(event) => updateField("displayName", event.target.value)}
                  autoComplete="off"
                  disabled={unavailable || busy}
                  aria-invalid={Boolean(fieldErrors.displayName)}
                />
              </ProviderTextField>
              <ProviderTextField label="Base URL（服务地址）" error={fieldErrors.baseUrl} wide>
                <input
                  name="baseUrl"
                  type="url"
                  placeholder="https://provider.example/v1"
                  value={form.baseUrl}
                  onChange={(event) => updateField("baseUrl", event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={unavailable || busy}
                  aria-invalid={Boolean(fieldErrors.baseUrl)}
                />
              </ProviderTextField>
              <ProviderTextField label="Model ID（模型标识）" error={fieldErrors.modelId} wide>
                <input
                  name="modelId"
                  placeholder="例如：gpt-5"
                  value={form.modelId}
                  onChange={(event) => updateField("modelId", event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={unavailable || busy}
                  aria-invalid={Boolean(fieldErrors.modelId)}
                />
              </ProviderTextField>
              <ProviderTextField label="Context Window（上下文窗口）" error={fieldErrors.contextWindow}>
                <input
                  name="contextWindow"
                  type="number"
                  min="1"
                  step="1"
                  placeholder="128000"
                  value={form.contextWindow}
                  onChange={(event) => updateField("contextWindow", event.target.value)}
                  disabled={unavailable || busy}
                  aria-invalid={Boolean(fieldErrors.contextWindow)}
                />
              </ProviderTextField>
              <ProviderTextField label="Max Tokens（最大输出）" error={fieldErrors.maxTokens}>
                <input
                  name="maxTokens"
                  type="number"
                  min="1"
                  step="1"
                  placeholder="Auto（自动）"
                  value={form.maxTokens}
                  onChange={(event) => updateField("maxTokens", event.target.value)}
                  disabled={unavailable || busy}
                  aria-invalid={Boolean(fieldErrors.maxTokens)}
                />
              </ProviderTextField>
            </div>

            <ContextBudgetPreview form={form} runtimeBudget={runtimeBudget} />

            <fieldset className="provider-capabilities" disabled={unavailable || busy}>
              <legend>Capabilities（模型能力）</legend>
              <label>
                <input
                  type="checkbox"
                  checked={form.reasoning}
                  onChange={(event) => updateField("reasoning", event.target.checked)}
                />
                Reasoning（推理）
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.inputText}
                  onChange={(event) => updateField("inputText", event.target.checked)}
                />
                Text Input（文本输入）
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.inputImage}
                  onChange={(event) => updateField("inputImage", event.target.checked)}
                />
                Image Input（图像输入）
              </label>
              {fieldErrors.inputText ? <small className="field-error">{fieldErrors.inputText}</small> : null}
            </fieldset>

            <ProviderTextField label="API Key（接口密钥）" error={fieldErrors.apiKey} wide>
              <div className="secret-input">
                <KeyRound size={15} aria-hidden="true" />
                <input
                  data-testid="provider-api-key"
                  name="apiKey"
                  type={showApiKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    setFieldErrors((current) => ({ ...current, apiKey: undefined }));
                    setSavedMessage(null);
                  }}
                  placeholder={status.kind === "configured" ? "输入新密钥以替换现有凭据" : "输入模型服务密钥"}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={unavailable || busy}
                  aria-invalid={Boolean(fieldErrors.apiKey)}
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey((visible) => !visible)}
                  disabled={unavailable || busy || apiKey.length === 0}
                  title={showApiKey ? "隐藏密钥" : "显示密钥"}
                >
                  {showApiKey ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
                  <span className="sr-only">{showApiKey ? "隐藏密钥" : "显示密钥"}</span>
                </button>
              </div>
            </ProviderTextField>

            <div className="settings-actions">
              <div className="clear-credential">
                {confirmingClear ? (
                  <div className="clear-confirm" role="group" aria-label="确认清除凭据">
                    <span>确认清除已保存的凭据？</span>
                    <button type="button" onClick={() => void clearCredential()} disabled={busy}>确认清除</button>
                    <button type="button" onClick={() => setConfirmingClear(false)} disabled={busy}>取消</button>
                  </div>
                ) : (
                  <button
                    className="secondary-danger-command"
                    type="button"
                    onClick={() => setConfirmingClear(true)}
                    disabled={busy || status.kind !== "configured"}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    清除凭据
                  </button>
                )}
              </div>
              <button className="secondary-command" type="button" onClick={() => void testConnection()} disabled={unavailable || busy}>
                {testing ? <LoaderCircle size={15} aria-hidden="true" /> : <PlugZap size={15} aria-hidden="true" />}
                {testing ? "正在测试" : "连接并 ping"}
              </button>
              <button className="primary-command" type="submit" disabled={unavailable || busy || status.kind === "loading"}>
                {saving ? <LoaderCircle size={15} aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
                {saving ? "正在保存" : "安全保存"}
              </button>
            </div>
            {testResult ? (
              <div className={`settings-message ${testResult.ok ? "settings-message--success" : "settings-message--error"}`} role="status">
                {testResult.ok
                  ? `连接与 ping 成功，${testResult.latencyMs} ms；上下文 ${testResult.contextWindow.toLocaleString()} tokens（${testResult.contextWindowSource === "provider" ? "Provider 返回" : "使用配置值"}）。`
                  : testResult.error.message}
              </div>
            ) : null}
          </form>
        </div>
      </section>
    </div>
  );
}

function ContextBudgetPreview({ form, runtimeBudget }: { form: ProviderSettingsForm; runtimeBudget: ContextBudgetAudit | null }) {
  const configuredContextWindow = Number(form.contextWindow);
  const contextWindow = Number.isSafeInteger(configuredContextWindow) && configuredContextWindow > 0
    ? configuredContextWindow
    : runtimeBudget?.configuredContextWindow ?? 0;
  if (contextWindow <= 0) return null;
  const safetyReserve = Math.max(4_096, Math.ceil(contextWindow * 0.1));
  const explicitOutput = form.maxTokens.trim() === "" ? null : Number(form.maxTokens);
  const outputReserve = explicitOutput ?? Math.min(32_768, Math.max(1_024, Math.floor((contextWindow - safetyReserve) * 0.25)));
  const available = Math.max(0, contextWindow - safetyReserve - outputReserve);
  const runtimeRemaining = runtimeBudget
    ? Math.max(0, runtimeBudget.availableInputBudget - runtimeBudget.estimatedInputTokens)
    : null;
  return (
    <dl className="provider-budget" aria-label="上下文预算预览">
      <div><dt>模型上下文上限</dt><dd>{contextWindow.toLocaleString()} tokens</dd></div>
      <div><dt>系统提示词和工具协议占用</dt><dd>{runtimeBudget ? `${(runtimeBudget.systemPromptTokens + runtimeBudget.toolProtocolTokens).toLocaleString()} tokens` : "尚无真实请求记录"}</dd></div>
      <div><dt>会话历史占用</dt><dd>{runtimeBudget ? `${runtimeBudget.sessionHistoryTokens.toLocaleString()} tokens` : "尚无真实请求记录"}</dd></div>
      <div><dt>检索资料占用</dt><dd>{runtimeBudget ? `${runtimeBudget.retrievalTokens.toLocaleString()} tokens` : "尚无真实请求记录"}</dd></div>
      <div><dt>输出预留</dt><dd>{explicitOutput === null ? `Auto（自动，当前约 ${outputReserve.toLocaleString()}）` : outputReserve.toLocaleString()}</dd></div>
      <div><dt>当前可用输入预算</dt><dd>{runtimeBudget ? `${runtimeBudget.availableInputBudget.toLocaleString()} tokens；本次装载后剩余 ${runtimeRemaining?.toLocaleString()}` : `最多约 ${available.toLocaleString()} tokens；实际值在请求前审计`}</dd></div>
      {runtimeBudget ? <>
        <div><dt>协作记忆与交接占用</dt><dd>{runtimeBudget.collaborationTokens.toLocaleString()} tokens</dd></div>
        <div><dt>本轮消息与工具过程占用</dt><dd>{runtimeBudget.runtimeConversationTokens.toLocaleString()} tokens</dd></div>
        <div><dt>最近审计记录</dt><dd>{new Date(runtimeBudget.recordedAt).toLocaleString()} · {runtimeBudget.contextPolicyVersion}</dd></div>
      </> : null}
    </dl>
  );
}

function ProviderStatus({ state }: { state: ReturnType<typeof describeProviderStatus> }) {
  if (state.kind === "loading") {
    return <div className="provider-status"><LoaderCircle size={18} aria-hidden="true" /><div><strong>正在读取配置</strong><span>等待系统安全存储状态</span></div></div>;
  }
  if (state.kind === "configured") {
    return <div className="provider-status provider-status--ready"><ShieldCheck size={18} aria-hidden="true" /><div><strong>凭据已配置</strong><span>{state.displayName} · {state.modelId} · 仅表示已安全保存</span></div></div>;
  }
  if (state.kind === "unavailable") {
    return <div className="provider-status provider-status--blocked" role="alert"><ShieldAlert size={18} aria-hidden="true" /><div><strong>系统安全存储不可用</strong><span>当前设备无法安全保存模型凭据，配置已阻塞。</span></div></div>;
  }
  if (state.kind === "error") {
    return <div className="provider-status provider-status--blocked" role="alert"><ShieldAlert size={18} aria-hidden="true" /><div><strong>配置读取失败</strong><span>{state.message}</span></div></div>;
  }
  return <div className="provider-status"><KeyRound size={18} aria-hidden="true" /><div><strong>尚未配置凭据</strong><span>保存后只确认本机安全存储，不代表服务连接成功。</span></div></div>;
}

function ProviderTextField({
  label,
  error,
  wide = false,
  children,
}: {
  label: string;
  error?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="provider-field" data-wide={wide || undefined}>
      <span>{label}</span>
      {children}
      {error ? <small className="field-error">{error}</small> : null}
    </label>
  );
}
