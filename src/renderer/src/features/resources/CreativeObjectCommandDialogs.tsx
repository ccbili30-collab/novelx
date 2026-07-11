import { useState } from "react";
import { Trash2, X } from "lucide-react";
import type { WorkspaceSnapshot } from "../../../../shared/ipcContract";

type Resource = WorkspaceSnapshot["resources"][number];

export function RenameCreativeObjectDialog(props: { resource: Resource; busy: boolean; onSubmit(title: string): Promise<void>; onClose(): void }) {
  const [title, setTitle] = useState(props.resource.title);
  return <div className="dialog-backdrop" role="presentation"><section className="dialog creative-object-dialog" role="dialog" aria-modal="true" aria-label="重命名创作对象">
    <header><div><strong>重命名创作对象</strong><span>{props.resource.title}</span></div><button type="button" title="关闭" onClick={props.onClose}><X size={16} /></button></header>
    <label><span>新的名称</span><input autoFocus maxLength={240} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <footer><button type="button" onClick={props.onClose}>取消</button><button type="button" disabled={props.busy || !title.trim() || title.trim() === props.resource.title} onClick={() => void props.onSubmit(title.trim())}>保存</button></footer>
  </section></div>;
}

export function DeleteCreativeObjectDialog(props: { resource: Resource; busy: boolean; onConfirm(): Promise<void>; onClose(): void }) {
  return <div className="dialog-backdrop" role="presentation"><section className="dialog creative-object-dialog" role="alertdialog" aria-modal="true" aria-label="删除创作对象">
    <header><div><strong>删除《{props.resource.title}》</strong><span>删除会形成项目版本，可以在“版本与分支”中恢复。</span></div><button type="button" title="关闭" onClick={props.onClose}><X size={16} /></button></header>
    <p className="dialog-warning"><Trash2 size={16} />存在下级对象或活动关联时，系统会阻止删除并说明原因。</p>
    <footer><button type="button" onClick={props.onClose}>取消</button><button className="danger-command" type="button" disabled={props.busy} onClick={() => void props.onConfirm()}>确认删除</button></footer>
  </section></div>;
}
