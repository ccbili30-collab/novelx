import { Check, History, LoaderCircle, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { CheckpointHistoryEntry, WorkspaceSnapshot } from "../../../../shared/ipcContract";

interface CheckpointHistoryDialogProps {
  workspaceId: string;
  onClose(): void;
  onRestored(workspace: WorkspaceSnapshot): void;
}

export function CheckpointHistoryDialog({ workspaceId, onClose, onRestored }: CheckpointHistoryDialogProps) {
  const [items, setItems] = useState<CheckpointHistoryEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void window.novaxDesktop.workspace.listHistory().then((result) => {
      if (!current) return;
      if (result.ok) setItems(result.checkpoints);
      else setError(result.error.message);
      setLoading(false);
    });
    return () => { current = false; };
  }, [workspaceId]);

  async function restore() {
    if (!selectedId || restoring) return;
    setRestoring(true);
    setError(null);
    const result = await window.novaxDesktop.workspace.restore({ checkpointId: selectedId });
    if (result.ok) {
      onRestored(result.workspace);
      onClose();
      return;
    }
    setError(result.error.message);
    setRestoring(false);
  }

  return (
    <div className="settings-backdrop" data-testid="checkpoint-history-backdrop">
      <section className="settings-dialog history-dialog" role="dialog" aria-modal="true" aria-labelledby="checkpoint-history-title">
        <header className="settings-header">
          <div>
            <span className="settings-kicker">PROJECT VERSIONS（项目版本）</span>
            <h1 id="checkpoint-history-title">版本与分支</h1>
          </div>
          <button className="icon-command" type="button" onClick={onClose} disabled={restoring} title="关闭版本与分支">
            <X size={17} aria-hidden="true" />
            <span className="sr-only">关闭版本与分支</span>
          </button>
        </header>
        <div className="history-body">
          {loading ? (
            <div className="history-state" role="status"><LoaderCircle size={16} aria-hidden="true" />正在载入项目版本</div>
          ) : items.length === 0 ? (
            <div className="history-state"><History size={18} aria-hidden="true" />暂无项目版本</div>
          ) : (
            <div className="history-list" role="listbox" aria-label="项目版本历史">
              {items.map((item) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={selectedId === item.id}
                  className="history-row"
                  data-head={item.isHead}
                  key={item.id}
                  disabled={item.isHead || restoring}
                  onClick={() => setSelectedId(item.id)}
                >
                  <span className="history-marker">{item.isHead ? <Check size={14} aria-hidden="true" /> : null}</span>
                  <span>
                    <strong>{item.label}</strong>
                    <small>{new Date(item.createdAt).toLocaleString("zh-CN")}</small>
                  </span>
                  {item.isHead ? <em>当前</em> : null}
                </button>
              ))}
            </div>
          )}
          {error ? <div className="history-error" role="alert">{error}</div> : null}
        </div>
        <footer className="history-footer">
          <span>恢复旧版本会保留当前内容，并从所选版本创建新的创作分支。</span>
          <button type="button" onClick={() => void restore()} disabled={!selectedId || restoring}>
            {restoring ? <LoaderCircle size={14} aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
            从所选版本继续创作
          </button>
        </footer>
      </section>
    </div>
  );
}
