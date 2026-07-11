import { useMemo, useState } from "react";
import { X } from "lucide-react";
import type { CreativeWorkspaceMutation, WorkspaceSnapshot } from "../../../../shared/ipcContract";

type Resource = WorkspaceSnapshot["resources"][number];
type CreateResourceMutation = Extract<CreativeWorkspaceMutation, { action: "create_resource" }>;

export function CreateCreativeObjectDialog(props: {
  domain: Resource["type"];
  parent: Resource | null;
  busy: boolean;
  onSubmit(input: CreateResourceMutation): Promise<void>;
  onClose(): void;
}) {
  const choices = useMemo(() => objectChoices(props.domain, props.parent?.objectKind ?? null), [props.domain, props.parent]);
  const [objectKind, setObjectKind] = useState<CreateResourceMutation["objectKind"]>(choices[0]?.kind ?? "world");
  const [title, setTitle] = useState("");

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog creative-object-dialog" role="dialog" aria-modal="true" aria-label="创建创作对象">
        <header>
          <div><strong>创建创作对象</strong><span>{props.parent ? `位于《${props.parent.title}》下` : "创建领域根对象"}</span></div>
          <button type="button" onClick={props.onClose} title="关闭"><X size={16} aria-hidden="true" /></button>
        </header>
        <label>
          <span>对象种类</span>
          <select value={objectKind} onChange={(event) => setObjectKind(event.target.value as CreateResourceMutation["objectKind"])}>
            {choices.map((choice) => <option key={choice.kind} value={choice.kind}>{choice.label}</option>)}
          </select>
        </label>
        <label>
          <span>名称</span>
          <input autoFocus value={title} maxLength={240} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <footer>
          <button type="button" onClick={props.onClose}>取消</button>
          <button
            type="button"
            disabled={props.busy || !title.trim() || choices.length === 0}
            onClick={() => void props.onSubmit({
              action: "create_resource",
              domain: props.domain,
              objectKind,
              title: title.trim(),
              parentId: props.parent?.id ?? null,
            })}
          >创建</button>
        </footer>
      </section>
    </div>
  );
}

function objectChoices(domain: Resource["type"], parentKind: Resource["objectKind"] | null) {
  if (parentKind === null) {
    if (domain === "world") return [{ kind: "world", label: "世界" }] as const;
    if (domain === "oc") return [{ kind: "oc", label: "原创角色" }] as const;
    if (domain === "story") return [{ kind: "story", label: "故事" }] as const;
    if (domain === "graph") return [{ kind: "graph_view", label: "图谱视图" }] as const;
    if (domain === "timeline") return [{ kind: "timeline_view", label: "时间线视图" }] as const;
    return [{ kind: "asset_collection", label: "资产集合" }] as const;
  }
  if (parentKind === "world") return [
    { kind: "location", label: "地点" },
    { kind: "faction", label: "势力" },
  ] as const;
  if (parentKind === "location") return [{ kind: "location", label: "下级地点" }] as const;
  if (parentKind === "faction") return [{ kind: "faction", label: "下级势力" }] as const;
  if (parentKind === "story") return [
    { kind: "volume", label: "卷" },
    { kind: "chapter", label: "章节" },
    { kind: "oc_variant", label: "角色变体" },
  ] as const;
  if (parentKind === "volume") return [{ kind: "chapter", label: "章节" }] as const;
  return [] as const;
}
