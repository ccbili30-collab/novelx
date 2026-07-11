import { useEffect, useState } from "react";
import { AlertTriangle, CheckSquare2, ChevronRight } from "lucide-react";
import type { SafeChangeSetSummary } from "../../../../shared/ipcContract";

export function PendingChangeSets(props: {
  workspaceId: string;
  refreshKey: number;
  selectedId: string | null;
  onOpen(changeSetId: string): Promise<void>;
}) {
  const [items, setItems] = useState<SafeChangeSetSummary[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    void window.novaxDesktop.changeSet.listPending().then((result) => {
      if (!active) return;
      if (result.ok) setItems(result.changeSets);
      else setFailed(true);
    }).catch(() => {
      if (active) setFailed(true);
    });
    return () => { active = false; };
  }, [props.workspaceId, props.refreshKey]);

  return (
    <section className="pending-changes" aria-label="待审查变更">
      <div className="pending-changes-heading">
        <span>待审查</span>
        <span>{items.length}</span>
      </div>
      {failed ? (
        <div className="pending-changes-empty"><AlertTriangle size={14} aria-hidden="true" />载入失败</div>
      ) : items.length === 0 ? (
        <div className="pending-changes-empty"><CheckSquare2 size={14} aria-hidden="true" />暂无待审查变更</div>
      ) : (
        <div className="pending-change-list">
          {items.map((item) => (
            <button
              type="button"
              className="pending-change-row"
              data-selected={props.selectedId === item.id}
              key={item.id}
              onClick={() => void props.onOpen(item.id)}
            >
              <span className="pending-change-copy">
                <strong>{item.summary}</strong>
                <small>{item.blockedReason === "MAJOR_CONFLICT" ? "重大冲突" : `${item.pendingCount} 项待决定`}</small>
              </span>
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
