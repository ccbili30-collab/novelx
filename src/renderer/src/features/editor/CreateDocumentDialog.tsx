import { useState } from "react";
import { X } from "lucide-react";
import type { CreativeWorkspaceMutation, WorkspaceSnapshot } from "../../../../shared/ipcContract";

type Resource = WorkspaceSnapshot["resources"][number];
type CreateDocumentMutation = Extract<CreativeWorkspaceMutation, { action: "create_document" }>;

export function CreateDocumentDialog(props: {
  resource: Resource;
  busy: boolean;
  onSubmit(input: CreateDocumentMutation): Promise<void>;
  onClose(): void;
}) {
  const choices = documentChoices(props.resource.objectKind);
  const [kind, setKind] = useState<CreateDocumentMutation["kind"]>(choices[0]?.kind ?? "knowledge_note");
  const [title, setTitle] = useState("");
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog creative-object-dialog" role="dialog" aria-modal="true" aria-label="创建文档">
        <header><div><strong>创建文档</strong><span>归属于《{props.resource.title}》</span></div><button type="button" onClick={props.onClose} title="关闭"><X size={16} /></button></header>
        <label><span>文档种类</span><select value={kind} onChange={(event) => setKind(event.target.value as CreateDocumentMutation["kind"])}>{choices.map((choice) => <option key={choice.kind} value={choice.kind}>{choice.label}</option>)}</select></label>
        <label><span>标题</span><input autoFocus value={title} maxLength={240} onChange={(event) => setTitle(event.target.value)} /></label>
        <footer><button type="button" onClick={props.onClose}>取消</button><button type="button" disabled={props.busy || !title.trim()} onClick={() => void props.onSubmit({ action: "create_document", resourceId: props.resource.id, kind, title: title.trim() })}>创建</button></footer>
      </section>
    </div>
  );
}

function documentChoices(kind: Resource["objectKind"]): Array<{ kind: CreateDocumentMutation["kind"]; label: string }> {
  const common = [
    { kind: "knowledge_note" as const, label: "知识文档" },
    { kind: "style_guide" as const, label: "风格指南" },
    { kind: "writing_constraints" as const, label: "写作约束" },
  ];
  if (["story", "volume", "chapter"].includes(kind)) return [{ kind: "prose", label: "正文" }, ...common];
  if (["oc", "oc_variant"].includes(kind)) return [{ kind: "character_profile", label: "角色资料" }, ...common];
  if (kind === "location") return [{ kind: "location_profile", label: "地点资料" }, ...common];
  if (kind === "faction") return [{ kind: "faction_profile", label: "势力资料" }, ...common];
  if (["world", "story"].includes(kind)) return [{ kind: "setting", label: "设定文档" }, ...common];
  return common;
}
