import { useEffect, useState } from "react";
import { AlertTriangle, Check, FileClock, LoaderCircle } from "lucide-react";
import type { SafeChangeSetDetail } from "../../../../shared/ipcContract";

export function ChangeSetWorkbench(props: {
  changeSetId: string;
  onChanged(): void;
}) {
  const [detail, setDetail] = useState<SafeChangeSetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState(false);

  useEffect(() => {
    let active = true;
    setDetail(null);
    setError(null);
    void window.novaxDesktop.changeSet.get({ changeSetId: props.changeSetId }).then((result) => {
      if (!active) return;
      if (result.ok) setDetail(result.changeSet);
      else setError(result.error.message);
    }).catch((cause: unknown) => {
      if (active) setError(readErrorMessage(cause));
    });
    return () => { active = false; };
  }, [props.changeSetId]);

  async function decide(itemId: string, decision: "accepted" | "rejected" | "draft") {
    setBusyItemId(itemId);
    setError(null);
    try {
      const result = await window.novaxDesktop.changeSet.decide({
        changeSetId: props.changeSetId,
        itemId,
        decision,
      });
      if (result.ok) {
        setDetail(result.changeSet);
        props.onChanged();
      } else {
        setError(result.error.message);
      }
    } catch (cause) {
      setError(readErrorMessage(cause));
    } finally {
      setBusyItemId(null);
    }
  }

  async function finalize() {
    if (!detail) return;
    setFinalizing(true);
    setError(null);
    try {
      const result = await window.novaxDesktop.changeSet.finalizeAssist({
        changeSetId: detail.id,
        label: detail.summary,
      });
      if (result.ok) {
        setDetail(result.changeSet);
        props.onChanged();
      } else {
        setError(result.error.message);
      }
    } catch (cause) {
      setError(readErrorMessage(cause));
    } finally {
      setFinalizing(false);
    }
  }

  if (!detail && !error) {
    return <div className="change-set-loading"><LoaderCircle size={18} aria-hidden="true" />正在载入变更</div>;
  }

  if (!detail) {
    return <div className="change-set-fatal" role="alert"><AlertTriangle size={18} aria-hidden="true" />{error}</div>;
  }

  const committed = detail.status === "committed";
  const blocked = detail.blockedReason === "MAJOR_CONFLICT";
  const acceptedCount = detail.items.filter((item) => item.decision === "accepted").length;

  return (
    <article className="change-set-workbench" aria-label="变更审查">
      <header className="change-set-header">
        <div>
          <span className="change-set-kicker">{detail.mode === "assist" ? "协助审查" : "自由模式"}</span>
          <h1>{detail.summary}</h1>
        </div>
        <span className={`change-set-status change-set-status--${detail.status}`}>
          {committed ? "已提交" : blocked ? "冲突阻塞" : `${detail.pendingCount} 项待决定`}
        </span>
      </header>

      {blocked ? (
        <div className="change-set-warning" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>这组修改涉及重大冲突，必须先调整方案。</span>
        </div>
      ) : null}
      {error ? <div className="change-set-warning" role="alert">{error}</div> : null}

      <div className="change-set-items">
        {detail.items.map((item) => (
          <section className="change-set-item" key={item.id}>
            <div className="change-set-item-heading">
              <span>{item.kindLabel}</span>
              <small>{item.risk === "elevated" ? "需谨慎" : "低风险"}</small>
            </div>
            <h2>{item.semanticSummary}</h2>
            {item.contentPreview ? <p>{item.contentPreview}</p> : null}
            {item.conflicts.some((conflict) => conflict.severity === "major") ? (
              <div className="change-set-item-conflict">存在重大冲突</div>
            ) : item.conflicts.length > 0 ? (
              <div className="change-set-item-conflict">存在需要注意的问题</div>
            ) : null}
            <div className="change-set-decisions" role="group" aria-label={`${item.semanticSummary}的决定`}>
              {(["accepted", "draft", "rejected"] as const).map((decision) => (
                <button
                  type="button"
                  key={decision}
                  data-selected={item.decision === decision}
                  disabled={committed || busyItemId === item.id}
                  onClick={() => void decide(item.id, decision)}
                >
                  {decisionLabel(decision)}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>

      <footer className="change-set-footer">
        <span><FileClock size={14} aria-hidden="true" />{
          committed ? "已形成稳定版本" : acceptedCount > 0 ? "提交后形成可回溯版本" : "不会写入正式内容"
        }</span>
        <button
          type="button"
          className="change-set-finalize"
          disabled={committed || blocked || detail.gateStatus !== "ready" || finalizing}
          onClick={() => void finalize()}
        >
          {finalizing ? <LoaderCircle size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
          {committed ? "已提交" : acceptedCount > 0 ? "提交已接受内容" : "完成审查"}
        </button>
      </footer>
    </article>
  );
}

function decisionLabel(decision: "accepted" | "rejected" | "draft"): string {
  if (decision === "accepted") return "接受";
  if (decision === "draft") return "保留草稿";
  return "拒绝";
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "变更审查暂时无法完成，请重试。";
}
