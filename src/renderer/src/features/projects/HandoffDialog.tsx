import { ArrowRightLeft, X } from "lucide-react";
import { useState } from "react";
import type { SessionSummary } from "../../../../shared/ipcContract";

interface HandoffDialogProps {
  recipients: SessionSummary[];
  scopeLabel: string | null;
  busy: boolean;
  onSubmit(input: { recipientSessionId: string; title: string; instructions: string }): Promise<void>;
  onClose(): void;
}

export function HandoffDialog(props: HandoffDialogProps) {
  const [recipientSessionId, setRecipientSessionId] = useState(props.recipients[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const valid = Boolean(recipientSessionId && title.trim() && instructions.trim());

  return (
    <div className="settings-backdrop" role="presentation">
      <section className="handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
        <header>
          <div><small>Agent 协作</small><h1 id="handoff-title">创建任务交接</h1></div>
          <button type="button" onClick={props.onClose} disabled={props.busy} title="关闭">
            <X size={16} aria-hidden="true" /><span className="sr-only">关闭</span>
          </button>
        </header>
        <div className="handoff-body">
          <ArrowRightLeft size={20} aria-hidden="true" />
          <div className="handoff-fields">
            <label>接收 Agent
              <select value={recipientSessionId} onChange={(event) => setRecipientSessionId(event.target.value)}>
                {props.recipients.map((session) => <option value={session.id} key={session.id}>{session.title}</option>)}
              </select>
            </label>
            <label>交接标题
              <input value={title} maxLength={240} onChange={(event) => setTitle(event.target.value)} placeholder="例如：继续核验港口章节" />
            </label>
            <label>任务说明
              <textarea value={instructions} maxLength={8_000} onChange={(event) => setInstructions(event.target.value)} placeholder="说明目标、已完成内容、仍需核验的问题和期望产物" />
            </label>
            <span className="handoff-scope">适用范围：{props.scopeLabel ?? "项目级（接收方仍需检索正式资料）"}</span>
          </div>
        </div>
        <footer>
          <button type="button" className="secondary-command" onClick={props.onClose} disabled={props.busy}>取消</button>
          <button type="button" className="primary-command" disabled={!valid || props.busy} onClick={() => void props.onSubmit({ recipientSessionId, title: title.trim(), instructions: instructions.trim() })}>创建交接</button>
        </footer>
      </section>
    </div>
  );
}
