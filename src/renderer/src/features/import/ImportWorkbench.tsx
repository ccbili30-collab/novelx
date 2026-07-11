import { Check, FilePlus2, FileSearch, LoaderCircle, Save, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { DecompositionCandidateReview, SourceLibraryEntry, StoryProfile, WorkspaceSnapshot } from "../../../../shared/ipcContract";

type CandidateUse = "seed" | "future" | "omit";
type CandidatePayload = DecompositionCandidateReview["payload"];

export function ImportWorkbench({ workspace }: { workspace: WorkspaceSnapshot | null }) {
  const [sources, setSources] = useState<SourceLibraryEntry[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [candidates, setCandidates] = useState<DecompositionCandidateReview[]>([]);
  const [rights, setRights] = useState<SourceLibraryEntry["rightsAttestation"]>("user_owned");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<StoryProfile[]>([]);
  const [startProfileId, setStartProfileId] = useState("");
  const [startTitle, setStartTitle] = useState("");
  const [opening, setOpening] = useState("");
  const [location, setLocation] = useState("");
  const [candidateUse, setCandidateUse] = useState<Record<string, CandidateUse>>({});
  const selected = sources.find((item) => item.id === sourceId) ?? null;
  const accepted = useMemo(() => candidates.filter((item) => item.status === "accepted"), [candidates]);

  useEffect(() => { if (workspace) void Promise.all([loadSources(), loadProfiles()]); else { setSources([]); setCandidates([]); } }, [workspace?.workspaceId]);
  useEffect(() => { if (sourceId) void loadCandidates(sourceId); else setCandidates([]); }, [sourceId]);

  async function loadSources() {
    const result = await window.novaxDesktop.sourceLibrary.list();
    if (!result.ok) { setError(result.error.message); return; }
    setSources(result.sources); setSourceId((current) => result.sources.some((item) => item.id === current) ? current : result.sources[0]?.id ?? "");
  }
  async function loadProfiles() {
    const result = await window.novaxDesktop.play.listStoryProfiles();
    if (!result.ok) return;
    const active = result.profiles.filter((item) => item.status === "active"); setProfiles(active); setStartProfileId(active[0]?.id ?? "");
  }
  async function loadCandidates(nextSourceId: string) {
    const result = await window.novaxDesktop.sourceLibrary.listCandidates({ sourceId: nextSourceId });
    if (!result.ok) { setError(result.error.message); return; }
    setCandidates(result.candidates);
    setCandidateUse((current) => Object.fromEntries(result.candidates.filter((item) => item.status === "accepted").map((item) => [item.id, current[item.id] ?? "omit"])));
  }
  async function addSource() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await window.novaxDesktop.sourceLibrary.add({ rightsAttestation: rights });
      if (result.status === "failed") { setError(result.error.message); return; }
      if (result.status === "added") { await loadSources(); setSourceId(result.source.id); }
    } finally { setBusy(false); }
  }
  async function parseSource() {
    if (!selected) return; setBusy(true); setError(null); setNotice(null);
    try {
      const result = await window.novaxDesktop.sourceLibrary.parse({ sourceId: selected.id });
      if (!result.ok) { setError(result.error.message); return; }
      await loadSources(); await loadCandidates(selected.id);
    } finally { setBusy(false); }
  }
  async function revise(candidateId: string, payload: CandidatePayload) {
    setNotice(null);
    const result = await window.novaxDesktop.sourceLibrary.reviseCandidate({ candidateId, payload });
    if (!result.ok) { setError(result.error.message); return; } setCandidates(result.candidates);
  }
  async function decide(candidateId: string, decision: "accepted" | "rejected") {
    setNotice(null);
    const result = await window.novaxDesktop.sourceLibrary.decideCandidate({ candidateId, decision });
    if (!result.ok) { setError(result.error.message); return; } setCandidates(result.candidates);
  }
  async function createStartProfile() {
    if (!selected || !startProfileId || !startTitle.trim() || !opening.trim()) return;
    const sourceCandidateIds = accepted.filter((item) => candidateUse[item.id] === "seed").map((item) => item.id);
    const excludedFutureEventCandidateIds = accepted.filter((item) => item.kind === "event" && candidateUse[item.id] === "future").map((item) => item.id);
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await window.novaxDesktop.play.createStartProfile({ storyProfileId: startProfileId, sourceId: selected.id, title: startTitle.trim(), status: "active", startState: {
        openingSituation: opening.trim(), initialState: location.trim() ? { location: location.trim() } : {}, sourceCandidateIds, excludedFutureEventCandidateIds,
      } });
      if (!result.ok) { setError(result.error.message); return; }
      setStartTitle(""); setOpening(""); setLocation("");
      setNotice(`已创建起始模板“${result.startProfile.title}”。`);
    } finally { setBusy(false); }
  }

  return <section className="import-workbench" aria-label="来源导入">
    <aside className="source-rail">
      <div className="import-heading"><strong>来源库</strong><button type="button" title="添加来源" onClick={addSource} disabled={busy}><FilePlus2 size={16} /><span className="sr-only">添加来源</span></button></div>
      <select aria-label="资料使用权" value={rights} onChange={(event) => setRights(event.target.value as typeof rights)} disabled={busy}>
        <option value="user_owned">本人拥有</option><option value="licensed">已获授权</option><option value="public_domain">公共领域</option><option value="unknown">尚未确认</option>
      </select>
      <div className="source-list">{sources.map((source) => <button key={source.id} type="button" aria-pressed={source.id === sourceId} onClick={() => setSourceId(source.id)}><span>{source.displayName}</span><small>{formatLabel(source.format)} · {stateLabel(source.state)}</small></button>)}</div>
    </aside>

    <div className="source-canvas">
      {selected ? <>
        <header className="source-summary"><div><FileSearch size={20} /><div><h1>{selected.displayName}</h1><p>{formatLabel(selected.format)} · {formatBytes(selected.byteSize)} · {rightsLabel(selected.rightsAttestation)}</p></div></div><button type="button" onClick={parseSource} disabled={busy || selected.state === "parsed"}>{busy ? <LoaderCircle className="spin" size={16} /> : <FileSearch size={16} />}{selected.state === "parsed" ? "已解析" : "解析"}</button></header>
        <section className="decomposer-status"><div><strong>Decomposer（拆解器）</strong><span>提示词尚未通过真实模型评测</span></div><button type="button" disabled>开始拆解</button></section>
        <section className="start-profile-builder">
          <h2>起始模板</h2>
          <div className="start-profile-fields"><select aria-label="目标故事配置" value={startProfileId} onChange={(event) => setStartProfileId(event.target.value)}><option value="">选择故事配置</option>{profiles.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select><input aria-label="起始模板名称" value={startTitle} onChange={(event) => setStartTitle(event.target.value)} /><input aria-label="初始位置" value={location} onChange={(event) => setLocation(event.target.value)} /><textarea aria-label="开场情境" rows={3} value={opening} onChange={(event) => setOpening(event.target.value)} /></div>
          {accepted.length ? <div className="candidate-use-list">{accepted.map((item) => <label key={item.id}><span>{candidateTitle(item)}</span><select value={candidateUse[item.id] ?? "omit"} onChange={(event) => setCandidateUse((current) => ({ ...current, [item.id]: event.target.value as CandidateUse }))}><option value="omit">不使用</option><option value="seed">作为起点依据</option>{item.kind === "event" ? <option value="future">排除为原著未来</option> : null}</select></label>)}</div> : null}
          <button className="start-profile-create" type="button" onClick={createStartProfile} disabled={busy || !startProfileId || !startTitle.trim() || !opening.trim()}><Save size={16} />创建起始模板</button>
        </section>
      </> : <div className="import-empty"><FilePlus2 size={28} /><h1>来源库为空</h1></div>}
      {error ? <div className="import-error" role="alert">{error}<button type="button" onClick={() => setError(null)}>×</button></div> : null}
      {notice ? <div className="import-notice" role="status">{notice}<button type="button" onClick={() => setNotice(null)}>×</button></div> : null}
    </div>

    <aside className="candidate-review-panel"><div className="import-heading"><strong>拆解候选</strong><span>{candidates.length}</span></div>{candidates.length ? <div className="candidate-review-list">{candidates.map((candidate) => <CandidateReview key={candidate.id} candidate={candidate} onRevise={revise} onDecide={decide} />)}</div> : <div className="candidate-empty">尚无拆解候选</div>}</aside>
  </section>;
}

function CandidateReview({ candidate, onRevise, onDecide }: { candidate: DecompositionCandidateReview; onRevise(id: string, payload: CandidatePayload): Promise<void>; onDecide(id: string, decision: "accepted" | "rejected"): Promise<void> }) {
  const [payload, setPayload] = useState<CandidatePayload>(candidate.payload);
  useEffect(() => setPayload(candidate.payload), [candidate.revision]);
  return <article className="candidate-review" data-status={candidate.status}><header><div><strong>{candidateTitle(candidate)}</strong><span>{kindLabel(candidate.kind)} · {Math.round(candidate.confidence * 100)}%</span></div><small>{statusLabel(candidate.status)}</small></header><CandidateFields kind={candidate.kind} payload={payload} onChange={setPayload} /><details><summary>来源片段</summary>{candidate.sources.map((source) => <blockquote key={source.chunkId}>{source.excerpt}</blockquote>)}</details>{candidate.status === "pending" ? <footer><button type="button" title="保存修改" onClick={() => onRevise(candidate.id, payload)}><Save size={15} /></button><button type="button" title="拒绝" onClick={() => onDecide(candidate.id, "rejected")}><X size={15} /></button><button type="button" className="accept" title="接受" onClick={() => onDecide(candidate.id, "accepted")}><Check size={15} /></button></footer> : null}</article>;
}

function CandidateFields({ kind, payload, onChange }: { kind: DecompositionCandidateReview["kind"]; payload: CandidatePayload; onChange(value: CandidatePayload): void }) {
  const fields = fieldNames(kind);
  return <div className="candidate-fields">
    {fields.map(([key, label, multiline]) => <label key={key}><span>{label}</span>{multiline ? <textarea value={stringValue(payload[key])} onChange={(event) => onChange({ ...payload, [key]: key === "alternatives" ? event.target.value.split("\n").filter(Boolean) : event.target.value })} rows={3} /> : <input value={stringValue(payload[key])} onChange={(event) => onChange({ ...payload, [key]: event.target.value })} />}</label>)}
    {kind === "event" ? <TemporalFields payload={payload} onChange={onChange} /> : null}
  </div>;
}

function TemporalFields({ payload, onChange }: { payload: CandidatePayload; onChange(value: CandidatePayload): void }) {
  const temporal = isTemporal(payload.temporal) ? payload.temporal : null;
  const setTemporal = (value: CandidatePayload[string]) => onChange({ ...payload, temporal: value });
  return <fieldset className="candidate-temporal-fields">
    <legend>时间定位</legend>
    <label><span>类型</span><select value={temporal?.kind ?? "none"} onChange={(event) => setTemporal(event.target.value === "none" ? null : { kind: event.target.value })}><option value="none">未确定</option><option value="instant">时间点</option><option value="range">时间范围</option><option value="sequence">事件顺序</option></select></label>
    {temporal?.kind === "instant" ? <label><span>时间</span><input value={stringValue(temporal.value)} onChange={(event) => setTemporal({ ...temporal, value: event.target.value })} /></label> : null}
    {temporal?.kind === "range" ? <><label><span>开始</span><input value={stringValue(temporal.start)} onChange={(event) => setTemporal({ ...temporal, start: event.target.value })} /></label><label><span>结束</span><input value={stringValue(temporal.end)} onChange={(event) => setTemporal({ ...temporal, end: event.target.value })} /></label></> : null}
    {temporal?.kind === "sequence" ? <label><span>顺序</span><input type="number" step="1" value={typeof temporal.order === "number" ? temporal.order : ""} onChange={(event) => setTemporal(event.target.value === "" ? { kind: temporal.kind } : { ...temporal, order: Number(event.target.value) })} /></label> : null}
  </fieldset>;
}

function isTemporal(value: unknown): value is { kind: "instant" | "range" | "sequence"; value?: string; start?: string; end?: string; order?: number } {
  return Boolean(value && typeof value === "object" && "kind" in value && ["instant", "range", "sequence"].includes(String((value as { kind: unknown }).kind)));
}

function fieldNames(kind: DecompositionCandidateReview["kind"]): Array<[string, string, boolean]> {
  if (kind === "character") return [["name", "名称", false], ["summary", "概要", true]];
  if (kind === "world_rule") return [["subject", "主体", false], ["predicate", "规则", false], ["value", "内容", true]];
  if (kind === "location" || kind === "faction") return [["name", "名称", false], ["description", "描述", true]];
  if (kind === "event") return [["subject", "主体", false], ["description", "事件", true]];
  if (kind === "style") return [["description", "风格", true]];
  return [["question", "待确认问题", true], ["alternatives", "备选答案", true]];
}
function stringValue(value: unknown) { return Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : ""; }
function candidateTitle(item: DecompositionCandidateReview) { const payload = item.payload; return String(payload.name ?? payload.subject ?? payload.question ?? payload.description ?? kindLabel(item.kind)); }
function kindLabel(kind: DecompositionCandidateReview["kind"]) { return ({ character: "人物", world_rule: "世界规则", location: "地点", faction: "势力", event: "事件", style: "风格", ambiguity: "歧义" } as const)[kind]; }
function statusLabel(status: DecompositionCandidateReview["status"]) { return status === "pending" ? "待审核" : status === "accepted" ? "已接受" : "已拒绝"; }
function formatLabel(format: SourceLibraryEntry["format"]) { return ({ txt: "TXT", markdown: "Markdown", docx: "Word", epub: "EPUB", image: "图片" } as const)[format]; }
function stateLabel(state: SourceLibraryEntry["state"]) { return ({ registered: "待解析", parsed: "已解析", failed: "解析失败", missing: "文件缺失" } as const)[state]; }
function rightsLabel(value: SourceLibraryEntry["rightsAttestation"]) { return ({ user_owned: "本人拥有", licensed: "已获授权", public_domain: "公共领域", unknown: "权利未确认" } as const)[value]; }
function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
