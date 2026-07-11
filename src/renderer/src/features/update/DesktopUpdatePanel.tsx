import { CheckCircle2, Download, LoaderCircle, RefreshCw, RotateCw, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { DesktopUpdateState } from "../../../../shared/desktopUpdateContract";

export function DesktopUpdatePanel() {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void window.novaxDesktop.update.getStatus().then((value) => {
      if (active) setState(value);
    });
    const unsubscribe = window.novaxDesktop.update.subscribe(setState);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function run(operation: "check" | "download") {
    if (busy) return;
    setBusy(true);
    const next = operation === "check"
      ? await window.novaxDesktop.update.check()
      : await window.novaxDesktop.update.download();
    setState(next);
    setBusy(false);
  }

  if (!state) return <section className="desktop-update-panel"><LoaderCircle size={16} aria-hidden="true" /><span>正在读取软件版本</span></section>;
  const working = busy || state.kind === "checking" || state.kind === "downloading";
  const StatusIcon = state.kind === "error" || state.kind === "not_configured"
    ? TriangleAlert
    : state.kind === "downloaded" || state.kind === "up_to_date" ? CheckCircle2 : RefreshCw;

  return (
    <section className="desktop-update-panel" aria-labelledby="desktop-update-title" data-state={state.kind}>
      <header>
        <div>
          <span className="settings-kicker">NOVELX UPDATE（软件更新）</span>
          <h2 id="desktop-update-title">当前版本 {state.currentVersion}</h2>
        </div>
        <StatusIcon size={18} aria-hidden="true" />
      </header>
      <p>{state.message}</p>
      {state.kind === "downloading" && state.progress !== null ? <progress max={100} value={state.progress}>{Math.round(state.progress)}%</progress> : null}
      <div className="desktop-update-actions">
        <button className="secondary-command" type="button" disabled={!state.canCheck || working} onClick={() => void run("check")}>
          {state.kind === "checking" ? <LoaderCircle size={14} aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
          检查更新
        </button>
        {state.canDownload ? <button className="primary-command" type="button" disabled={working} onClick={() => void run("download")}>
          <Download size={14} aria-hidden="true" />下载更新
        </button> : null}
        {state.canInstall ? <button className="primary-command" type="button" onClick={() => void window.novaxDesktop.update.install()}>
          <RotateCw size={14} aria-hidden="true" />重启并更新
        </button> : null}
      </div>
      <small>公开发布前仍需配置 Windows 代码签名；未签名版本可能触发 SmartScreen 警告。</small>
    </section>
  );
}
