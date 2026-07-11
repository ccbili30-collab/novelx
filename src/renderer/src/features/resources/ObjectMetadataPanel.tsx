import { useEffect, useMemo, useState } from "react";
import { Link2, Plus, SlidersHorizontal, Trash2, X } from "lucide-react";
import type { CreativeWorkspaceMutation, WorkspaceSnapshot } from "../../../../shared/ipcContract";

type Resource = WorkspaceSnapshot["resources"][number];
type Profile = WorkspaceSnapshot["constraintProfiles"][number];
type ConstraintPayload = Profile["payload"];
type RelationMutation = Extract<CreativeWorkspaceMutation, { action: "create_relation" }>;

export function ObjectMetadataPanel(props: {
  workspace: WorkspaceSnapshot;
  resource: Resource;
  busy: boolean;
  onMutate(input: CreativeWorkspaceMutation): Promise<WorkspaceSnapshot | null>;
  onWorkspaceRefresh(): Promise<void>;
}) {
  const [relationOpen, setRelationOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | "new" | null>(null);
  const outgoing = props.workspace.relations.filter((relation) => relation.sourceResourceId === props.resource.id);
  const incoming = props.workspace.relations.filter((relation) => relation.targetResourceId === props.resource.id);
  const profiles = props.workspace.constraintProfiles.filter((profile) => profile.scopeResourceId === props.resource.id);
  const titles = new Map(props.workspace.resources.map((resource) => [resource.id, resource.title]));

  return (
    <section className="object-metadata-panel" aria-label="对象关系与约束">
      <div className="object-metadata-group">
        <header><Link2 size={13} aria-hidden="true" /><span>对象关联</span><button type="button" title="建立关联" onClick={() => setRelationOpen(true)}><Plus size={13} /></button></header>
        <div className="metadata-chip-row">
          {[...outgoing, ...incoming].map((relation) => {
            const otherId = relation.sourceResourceId === props.resource.id ? relation.targetResourceId : relation.sourceResourceId;
            return <span className="metadata-chip" key={relation.id}>{relationLabel(relation.kind)} · {titles.get(otherId) ?? "未知对象"}<button type="button" title="移除关联" onClick={() => void props.onMutate({ action: "delete_relation", relationId: relation.id })}><X size={11} /></button></span>;
          })}
          {outgoing.length + incoming.length === 0 ? <span className="metadata-empty">尚未关联其他对象</span> : null}
        </div>
      </div>
      <div className="object-metadata-group">
        <header><SlidersHorizontal size={13} aria-hidden="true" /><span>风格与约束</span><button type="button" title="创建约束" onClick={() => setEditingProfile("new")}><Plus size={13} /></button></header>
        <div className="metadata-chip-row">
          {profiles.map((profile) => <button className="metadata-chip metadata-chip--command" type="button" key={profile.profileId} onClick={() => setEditingProfile(profile)}>{profile.title}<span>{profile.payload.tone ?? "自定义"}</span></button>)}
          {profiles.length === 0 ? <span className="metadata-empty">使用项目默认约束</span> : null}
        </div>
      </div>
      {relationOpen ? <RelationDialog workspace={props.workspace} resource={props.resource} busy={props.busy} onClose={() => setRelationOpen(false)} onSubmit={async (input) => {
        if (await props.onMutate(input)) setRelationOpen(false);
      }} /> : null}
      {editingProfile ? <ConstraintDialog resource={props.resource} profile={editingProfile === "new" ? null : editingProfile} busy={props.busy} onPublished={props.onWorkspaceRefresh} onClose={() => setEditingProfile(null)} onDelete={editingProfile === "new" ? undefined : async () => {
        if (await props.onMutate({ action: "delete_constraint", profileId: editingProfile.profileId })) setEditingProfile(null);
      }} onSubmit={async (title, payload) => {
        const next = await props.onMutate(editingProfile === "new"
          ? { action: "create_constraint", scopeResourceId: props.resource.id, title, payload }
          : { action: "update_constraint", profileId: editingProfile.profileId, payload });
        if (next) setEditingProfile(null);
      }} /> : null}
    </section>
  );
}

function RelationDialog(props: {
  workspace: WorkspaceSnapshot;
  resource: Resource;
  busy: boolean;
  onSubmit(input: RelationMutation): Promise<void>;
  onClose(): void;
}) {
  const options = useMemo(() => relationOptions(props.workspace, props.resource), [props.workspace, props.resource]);
  const [selection, setSelection] = useState(options[0] ? `${options[0].kind}:${options[0].target.id}` : "");
  const selected = options.find((option) => `${option.kind}:${option.target.id}` === selection) ?? null;
  return <div className="dialog-backdrop"><section className="dialog creative-object-dialog" role="dialog" aria-modal="true" aria-label="建立对象关联">
    <header><div><strong>建立对象关联</strong><span>从《{props.resource.title}》出发</span></div><button type="button" onClick={props.onClose}><X size={16} /></button></header>
    <label><span>目标</span><select value={selection} onChange={(event) => setSelection(event.target.value)}>{options.map((option) => <option key={`${option.kind}:${option.target.id}`} value={`${option.kind}:${option.target.id}`}>{relationLabel(option.kind)} · {option.target.title}</option>)}</select></label>
    <footer><button type="button" onClick={props.onClose}>取消</button><button type="button" disabled={!selected || props.busy} onClick={() => selected && void props.onSubmit({ action: "create_relation", kind: selected.kind, sourceResourceId: props.resource.id, targetResourceId: selected.target.id })}>建立</button></footer>
  </section></div>;
}

function ConstraintDialog(props: {
  resource: Resource;
  profile: Profile | null;
  busy: boolean;
  onSubmit(title: string, payload: ConstraintPayload): Promise<void>;
  onDelete?: () => Promise<void>;
  onPublished(): Promise<void>;
  onClose(): void;
}) {
  const [title, setTitle] = useState(props.profile?.title ?? `${props.resource.title}写作约束`);
  const [payload, setPayload] = useState<ConstraintPayload>(props.profile?.payload ?? emptyConstraint());
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof window.novaxDesktop.constraintEditor.get>> | null>(null);
  const [editorBusy, setEditorBusy] = useState(Boolean(props.profile));
  const [editorError, setEditorError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.profile) return;
    let active = true;
    void window.novaxDesktop.constraintEditor.get({ profileId: props.profile.profileId }).then((next) => {
      if (!active) return;
      setSnapshot(next);
      setTitle(next.title);
      setPayload(next.payload);
    }).catch((error: unknown) => {
      if (active) setEditorError(error instanceof Error ? error.message : "写作约束载入失败。");
    }).finally(() => {
      if (active) setEditorBusy(false);
    });
    return () => { active = false; };
  }, [props.profile]);

  async function saveDraft() {
    if (!snapshot) return null;
    setEditorBusy(true);
    setEditorError(null);
    try {
      const next = await window.novaxDesktop.constraintEditor.saveWorking({
        profileId: snapshot.profileId,
        payload,
        expectedRevision: snapshot.workingRevision,
        expectedStableVersionId: snapshot.stableVersionId,
      });
      setSnapshot(next);
      setPayload(next.payload);
      return next;
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "写作约束草稿保存失败。");
      return null;
    } finally {
      setEditorBusy(false);
    }
  }

  async function publishStable() {
    const draft = await saveDraft();
    if (!draft?.dirty) return;
    setEditorBusy(true);
    try {
      const next = await window.novaxDesktop.constraintEditor.saveStable({ profileId: draft.profileId, expectedRevision: draft.workingRevision });
      setSnapshot(next);
      setPayload(next.payload);
      await props.onPublished();
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "写作约束发布失败。");
    } finally {
      setEditorBusy(false);
    }
  }

  async function discardDraft() {
    if (!snapshot?.dirty) return;
    setEditorBusy(true);
    try {
      const next = await window.novaxDesktop.constraintEditor.discardWorking({ profileId: snapshot.profileId, expectedRevision: snapshot.workingRevision });
      setSnapshot(next);
      setPayload(next.payload);
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "写作约束草稿恢复失败。");
    } finally {
      setEditorBusy(false);
    }
  }

  return <div className="dialog-backdrop"><section className="dialog constraint-dialog" role="dialog" aria-modal="true" aria-label="编辑写作约束">
    <header><div><strong>{props.profile ? "编辑写作约束" : "创建写作约束"}</strong><span>作用于《{props.resource.title}》</span></div><button type="button" onClick={props.onClose}><X size={16} /></button></header>
    <div className="constraint-grid">
      <label><span>名称</span><input value={title} disabled={Boolean(props.profile)} onChange={(event) => setTitle(event.target.value)} /></label>
      <label><span>叙事视角</span><select value={payload.narrativePerson ?? ""} onChange={(event) => setPayload({ ...payload, narrativePerson: event.target.value as ConstraintPayload["narrativePerson"] || null })}><option value="">继承</option><option value="first">第一人称</option><option value="second">第二人称</option><option value="third">第三人称</option></select></label>
      <label><span>时态</span><select value={payload.tense ?? ""} onChange={(event) => setPayload({ ...payload, tense: event.target.value as ConstraintPayload["tense"] || null })}><option value="">继承</option><option value="past">过去</option><option value="present">现在</option><option value="mixed">混合</option></select></label>
      <label><span>语气</span><input value={payload.tone ?? ""} onChange={(event) => setPayload({ ...payload, tone: event.target.value || null })} /></label>
      <label><span>节奏</span><input value={payload.pacing ?? ""} onChange={(event) => setPayload({ ...payload, pacing: event.target.value || null })} /></label>
      <label><span>幽默程度</span><input type="range" min="0" max="5" value={payload.humorLevel ?? 0} onChange={(event) => setPayload({ ...payload, humorLevel: Number(event.target.value) })} /><output>{payload.humorLevel ?? "继承"}</output></label>
      <label className="constraint-wide"><span>禁止内容（每行一条）</span><textarea value={payload.prohibitedContent.join("\n")} onChange={(event) => setPayload({ ...payload, prohibitedContent: lines(event.target.value) })} /></label>
      <label className="constraint-wide"><span>必须遵守（每行一条）</span><textarea value={payload.requiredContent.join("\n")} onChange={(event) => setPayload({ ...payload, requiredContent: lines(event.target.value) })} /></label>
      <label className="constraint-wide"><span>补充说明</span><textarea value={payload.notes} onChange={(event) => setPayload({ ...payload, notes: event.target.value })} /></label>
    </div>
    {editorError ? <div className="editor-error" role="alert">{editorError}</div> : null}
    {props.profile ? <div className="constraint-draft-state" role="status">{snapshot?.dirty ? "草稿已保存，尚未发布" : "稳定版本"}</div> : null}
    <footer>
      {props.onDelete ? <button className="danger-command" type="button" onClick={() => void props.onDelete?.()}><Trash2 size={14} />删除</button> : <span />}
      <button type="button" onClick={props.onClose}>取消</button>
      {props.profile ? <>
        <button type="button" disabled={editorBusy || !snapshot?.dirty} onClick={() => void discardDraft()}>放弃草稿</button>
        <button type="button" disabled={editorBusy || !snapshot} onClick={() => void saveDraft()}>保存草稿</button>
        <button type="button" disabled={editorBusy || !snapshot} onClick={() => void publishStable()}>发布稳定版本</button>
      </> : <button type="button" disabled={props.busy || !title.trim()} onClick={() => void props.onSubmit(title.trim(), payload)}>保存</button>}
    </footer>
  </section></div>;
}

function relationOptions(workspace: WorkspaceSnapshot, resource: Resource): Array<{ kind: RelationMutation["kind"]; target: Resource }> {
  const candidates = workspace.resources.filter((item) => item.id !== resource.id && item.objectKind !== "domain_root");
  if (resource.objectKind === "story") return [
    ...candidates.filter((item) => item.objectKind === "world").map((target) => ({ kind: "uses_world" as const, target })),
    ...candidates.filter((item) => item.objectKind === "oc").map((target) => ({ kind: "uses_oc" as const, target })),
  ];
  if (resource.objectKind === "oc_variant") return candidates.filter((item) => item.objectKind === "oc").map((target) => ({ kind: "variant_of" as const, target }));
  return candidates.map((target) => ({ kind: "related_to" as const, target }));
}

function relationLabel(kind: WorkspaceSnapshot["relations"][number]["kind"]): string {
  if (kind === "uses_world") return "使用世界";
  if (kind === "uses_oc") return "使用角色";
  if (kind === "variant_of") return "基础角色";
  return "相关对象";
}

function emptyConstraint(): ConstraintPayload {
  return { narrativePerson: null, tense: null, tone: null, pacing: null, humorLevel: null, prohibitedContent: [], requiredContent: [], notes: "" };
}

function lines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
}
