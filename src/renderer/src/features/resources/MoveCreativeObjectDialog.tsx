import { useMemo, useState } from "react";
import { X } from "lucide-react";
import type { WorkspaceSnapshot } from "../../../../shared/ipcContract";

type Resource = WorkspaceSnapshot["resources"][number];

export function MoveCreativeObjectDialog(props: {
  resource: Resource;
  resources: Resource[];
  busy: boolean;
  onSubmit(parentId: string): Promise<void>;
  onClose(): void;
}) {
  const choices = useMemo(() => moveTargets(props.resource, props.resources), [props.resource, props.resources]);
  const [parentId, setParentId] = useState(choices[0]?.id ?? "");
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog creative-object-dialog" role="dialog" aria-modal="true" aria-label="移动创作对象">
        <header><div><strong>移动创作对象</strong><span>将《{props.resource.title}》移动到新的归属位置</span></div><button type="button" onClick={props.onClose} title="关闭"><X size={16} /></button></header>
        <label><span>新的上级对象</span><select value={parentId} onChange={(event) => setParentId(event.target.value)}>{choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.title} · {kindLabel(choice.objectKind)}</option>)}</select></label>
        {choices.length === 0 ? <p className="dialog-empty">当前没有合法的移动目标。</p> : null}
        <footer><button type="button" onClick={props.onClose}>取消</button><button type="button" disabled={props.busy || !parentId} onClick={() => void props.onSubmit(parentId)}>移动</button></footer>
      </section>
    </div>
  );
}

function moveTargets(resource: Resource, resources: Resource[]): Resource[] {
  const descendants = new Set<string>();
  const collect = (id: string) => resources.filter((item) => item.parentId === id).forEach((item) => { descendants.add(item.id); collect(item.id); });
  collect(resource.id);
  const allowed: Partial<Record<Resource["objectKind"], Resource["objectKind"][]>> = {
    volume: ["story"], chapter: ["story", "volume"], location: ["world", "location"], faction: ["world", "faction"], oc_variant: ["story"],
  };
  const kinds = allowed[resource.objectKind] ?? [];
  return resources.filter((candidate) => candidate.id !== resource.parentId && candidate.id !== resource.id && !descendants.has(candidate.id) && kinds.includes(candidate.objectKind));
}

function kindLabel(kind: Resource["objectKind"]): string {
  return ({ story: "故事", volume: "卷", world: "世界", location: "地点", faction: "势力" } as Partial<Record<Resource["objectKind"], string>>)[kind] ?? kind;
}
