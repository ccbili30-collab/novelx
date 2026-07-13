import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  ImagePlus,
  KeyRound,
  LoaderCircle,
  PlugZap,
  Save,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type {
  ImageProviderStatusResult,
  ImageProviderTestResult,
} from "../../../../shared/imageProviderContract";
import {
  createImageProviderSettingsForm,
  describeImageProviderStatus,
  parseImageProviderSettingsForm,
  type ImageProviderSettingsForm,
} from "../../../../shared/imageProviderSettingsModel";

type FieldErrors = Partial<Record<keyof ImageProviderSettingsForm | "apiKey", string>>;

export function ImageProviderSettingsSection() {
  const [statusResult, setStatusResult] = useState<ImageProviderStatusResult | null>(null);
  const [form, setForm] = useState(() => createImageProviderSettingsForm(null));
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [testResult, setTestResult] = useState<ImageProviderTestResult | null>(null);
  const status = useMemo(() => describeImageProviderStatus(statusResult), [statusResult]);

  useEffect(() => {
    let active = true;
    void window.novaxDesktop.imageProvider.getStatus().then((result) => {
      if (!active) return;
      setStatusResult(result);
      if (result.ok) setForm(createImageProviderSettingsForm(result.state.config));
    }).catch(() => {
      if (active) setStatusResult({
        ok: false,
        error: { code: "IMAGE_PROVIDER_STORAGE_FAILED", message: "图片模型安全配置读取失败。" },
      });
    });
    return () => {
      active = false;
      setApiKey("");
    };
  }, []);

  function updateField<K extends keyof ImageProviderSettingsForm>(field: K, value: ImageProviderSettingsForm[K]) {
    setForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setMessage(null);
    setTestResult(null);
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseImageProviderSettingsForm(form, apiKey, status.kind === "configured");
    if (!parsed.ok) { setFieldErrors(parsed.fieldErrors); return; }
    setSaving(true);
    setMessage(null);
    try {
      const result = await window.novaxDesktop.imageProvider.save(parsed.request);
      setStatusResult(result);
      if (!result.ok) { setMessage({ kind: "error", text: result.error.message }); return; }
      setApiKey("");
      setShowApiKey(false);
      setFieldErrors({});
      setConfirmingClear(false);
      setForm(createImageProviderSettingsForm(result.state.config));
      setMessage({ kind: "success", text: "图片模型配置已安全保存，尚未执行真实生成测试。" });
    } catch {
      setMessage({ kind: "error", text: "图片模型配置保存失败。" });
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    const parsed = parseImageProviderSettingsForm(form, apiKey, status.kind === "configured");
    if (!parsed.ok) { setFieldErrors(parsed.fieldErrors); return; }
    setTesting(true);
    setMessage(null);
    setTestResult(null);
    try {
      setTestResult(await window.novaxDesktop.imageProvider.test(parsed.request));
    } catch {
      setTestResult({
        ok: false,
        error: { code: "IMAGE_PROVIDER_CONNECTION_FAILED", message: "图片模型真实生成测试失败。" },
      });
    } finally {
      setTesting(false);
    }
  }

  async function clearCredential() {
    setClearing(true);
    setMessage(null);
    try {
      const result = await window.novaxDesktop.imageProvider.clearCredential();
      setStatusResult(result);
      if (!result.ok) { setMessage({ kind: "error", text: result.error.message }); return; }
      setApiKey("");
      setShowApiKey(false);
      setConfirmingClear(false);
      setForm(createImageProviderSettingsForm(result.state.config));
      setMessage({ kind: "success", text: "图片模型凭据已清除，非敏感参数仍保留。" });
    } catch {
      setMessage({ kind: "error", text: "图片模型凭据清除失败。" });
    } finally {
      setClearing(false);
    }
  }

  const unavailable = status.kind === "unavailable";
  const busy = saving || testing || clearing;

  return (
    <section className="image-provider-settings" aria-labelledby="image-provider-settings-title">
      <header>
        <div><ImagePlus size={16} aria-hidden="true" /><h2 id="image-provider-settings-title">图片模型</h2></div>
        <span>通过 Responses API 调用真实生图；文本模型和图片模型凭据彼此独立。</span>
      </header>

      <ImageProviderStatus state={status} />
      {message ? <div className={`settings-message settings-message--${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>
        {message.kind === "error" ? <AlertTriangle size={15} aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}
        <span>{message.text}</span>
      </div> : null}

      <form className="provider-form" onSubmit={(event) => void save(event)} noValidate>
        <div className="provider-form-grid">
          <Field label="Provider ID（提供方标识）" error={fieldErrors.providerId}>
            <input aria-label="图片 Provider ID（提供方标识）" value={form.providerId} onChange={(event) => updateField("providerId", event.target.value)} disabled={unavailable || busy} />
          </Field>
          <Field label="Display Name（显示名称）" error={fieldErrors.displayName}>
            <input aria-label="图片 Display Name（显示名称）" value={form.displayName} onChange={(event) => updateField("displayName", event.target.value)} disabled={unavailable || busy} />
          </Field>
          <Field label="Base URL（图片服务地址）" error={fieldErrors.baseUrl} wide>
            <input aria-label="Base URL（图片服务地址）" type="url" value={form.baseUrl} onChange={(event) => updateField("baseUrl", event.target.value)} disabled={unavailable || busy} spellCheck={false} />
          </Field>
          <Field label="Model ID（生图模型标识）" error={fieldErrors.modelId} wide>
            <input aria-label="Model ID（生图模型标识）" value={form.modelId} onChange={(event) => updateField("modelId", event.target.value)} disabled={unavailable || busy} spellCheck={false} />
          </Field>
          <Field label="默认尺寸" error={fieldErrors.defaultSize}>
            <input aria-label="图片默认尺寸" value={form.defaultSize} onChange={(event) => updateField("defaultSize", event.target.value)} disabled={unavailable || busy} placeholder="1024x1024" />
          </Field>
          <Field label="默认质量">
            <select aria-label="图片默认质量" value={form.defaultQuality} onChange={(event) => updateField("defaultQuality", event.target.value as ImageProviderSettingsForm["defaultQuality"])} disabled={unavailable || busy}>
              <option value="auto">Auto（自动）</option><option value="low">Low（低）</option><option value="medium">Medium（中）</option><option value="high">High（高）</option>
            </select>
          </Field>
          <Field label="默认背景">
            <select aria-label="图片默认背景" value={form.defaultBackground} onChange={(event) => updateField("defaultBackground", event.target.value as ImageProviderSettingsForm["defaultBackground"])} disabled={unavailable || busy}>
              <option value="auto">Auto（自动）</option><option value="opaque">Opaque（不透明）</option><option value="transparent">Transparent（透明）</option>
            </select>
          </Field>
          <Field label="API Key（图片接口密钥）" error={fieldErrors.apiKey} wide>
            <div className="secret-input">
              <KeyRound size={15} aria-hidden="true" />
              <input
                data-testid="image-provider-api-key"
                aria-label="API Key（图片接口密钥）"
                type={showApiKey ? "text" : "password"}
                value={apiKey}
                onChange={(event) => { setApiKey(event.target.value); setFieldErrors((current) => ({ ...current, apiKey: undefined })); setMessage(null); }}
                placeholder={status.kind === "configured" ? "输入新密钥以替换现有凭据" : "输入图片模型服务密钥"}
                autoComplete="off"
                spellCheck={false}
                disabled={unavailable || busy}
              />
              <button type="button" onClick={() => setShowApiKey((value) => !value)} disabled={!apiKey || busy} title={showApiKey ? "隐藏图片密钥" : "显示图片密钥"}>
                {showApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </Field>
        </div>

        <div className="image-provider-cost-note">“真实生成测试”会生成一张最小测试图，可能产生一次图片调用费用。</div>
        <div className="settings-actions">
          <div className="clear-credential">
            {confirmingClear ? <div className="clear-confirm" role="group" aria-label="确认清除图片凭据">
              <span>确认清除图片凭据？</span>
              <button type="button" onClick={() => void clearCredential()} disabled={busy}>确认清除</button>
              <button type="button" onClick={() => setConfirmingClear(false)} disabled={busy}>取消</button>
            </div> : <button className="secondary-danger-command" type="button" onClick={() => setConfirmingClear(true)} disabled={busy || status.kind !== "configured"}>
              <Trash2 size={14} />清除图片凭据
            </button>}
          </div>
          <button className="secondary-command" type="button" onClick={() => void testConnection()} disabled={unavailable || busy}>
            {testing ? <LoaderCircle size={15} /> : <PlugZap size={15} />}{testing ? "正在真实生成" : "真实生成测试"}
          </button>
          <button className="primary-command" type="submit" disabled={unavailable || busy || status.kind === "loading"}>
            {saving ? <LoaderCircle size={15} /> : <Save size={15} />}{saving ? "正在保存" : "保存图片模型"}
          </button>
        </div>
        {testResult ? <div className={`settings-message ${testResult.ok ? "settings-message--success" : "settings-message--error"}`} role="status">
          {testResult.ok
            ? `真实生图成功，${testResult.latencyMs} ms；${testResult.width}×${testResult.height} ${testResult.mimeType}，${formatBytes(testResult.byteLength)}。`
            : testResult.error.message}
        </div> : null}
      </form>
    </section>
  );
}

function ImageProviderStatus({ state }: { state: ReturnType<typeof describeImageProviderStatus> }) {
  if (state.kind === "loading") return <div className="provider-status"><LoaderCircle size={18} /><div><strong>正在读取图片模型配置</strong></div></div>;
  if (state.kind === "configured") return <div className="provider-status provider-status--ready"><ShieldCheck size={18} /><div><strong>图片凭据已配置</strong><span>{state.displayName} · {state.modelId} · 仅表示已安全保存</span></div></div>;
  if (state.kind === "unavailable") return <div className="provider-status provider-status--blocked" role="alert"><ShieldAlert size={18} /><div><strong>系统安全存储不可用</strong><span>无法安全保存图片模型凭据。</span></div></div>;
  if (state.kind === "error") return <div className="provider-status provider-status--blocked" role="alert"><ShieldAlert size={18} /><div><strong>图片配置读取失败</strong><span>{state.message}</span></div></div>;
  return <div className="provider-status"><ImagePlus size={18} /><div><strong>尚未配置图片凭据</strong><span>保存后可执行一次真实生成测试。</span></div></div>;
}

function Field({ label, error, wide = false, children }: { label: string; error?: string; wide?: boolean; children: React.ReactNode }) {
  return <label className="provider-field" data-wide={wide || undefined}><span>{label}</span>{children}{error ? <small className="field-error">{error}</small> : null}</label>;
}

function formatBytes(value: number) {
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`;
}
