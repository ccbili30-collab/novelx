import { BookOpen, GitFork, LoaderCircle, Plus, RotateCcw, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Playthrough, PublicPlayTurn, StartProfile, StoryProfile, WorkspaceSnapshot } from "../../../../shared/ipcContract";

export function PlayerWorkbench({ workspace }: { workspace: WorkspaceSnapshot | null }) {
  const [profiles, setProfiles] = useState<StoryProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [playthroughs, setPlaythroughs] = useState<Playthrough[]>([]);
  const [playthroughId, setPlaythroughId] = useState("");
  const [starts, setStarts] = useState<StartProfile[]>([]);
  const [startId, setStartId] = useState("");
  const [turns, setTurns] = useState<PublicPlayTurn[]>([]);
  const [action, setAction] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingConflict, setPendingConflict] = useState<{ action: string; playthroughId: string } | null>(null);
  const [newStoryId, setNewStoryId] = useState("");
  const [newWorldId, setNewWorldId] = useState("");
  const [busy, setBusy] = useState(false);
  const activeRunId = useRef<string | null>(null);
  const pendingActionRef = useRef("");
  const terminalRuns = useRef(new Set<string>());
  const streamRef = useRef<HTMLDivElement | null>(null);

  const stories = workspace?.resources.filter((item) => item.objectKind === "story") ?? [];
  const worlds = workspace?.resources.filter((item) => item.objectKind === "world") ?? [];
  const selectedPlaythrough = playthroughs.find((item) => item.id === playthroughId) ?? null;
  const publicState = useMemo(() => visibleState(turns.at(-1)?.stateSnapshot ?? selectedPlaythrough?.initialStateSnapshot ?? null), [turns, selectedPlaythrough]);

  useEffect(() => {
    if (!workspace) { setProfiles([]); setProfileId(""); return; }
    void loadProfiles();
  }, [workspace?.workspaceId]);

  useEffect(() => {
    if (!profileId) { setPlaythroughs([]); setStarts([]); setPlaythroughId(""); return; }
    void Promise.all([loadPlaythroughs(profileId), loadStarts(profileId)]);
  }, [profileId]);

  useEffect(() => {
    if (!playthroughId) { setTurns([]); return; }
    void loadTurns(playthroughId);
  }, [playthroughId]);

  useEffect(() => window.novaxDesktop.play.subscribeTurns((event) => {
    if (activeRunId.current && event.runId !== activeRunId.current) return;
    if (event.type === "started") { setRunning(true); setError(null); return; }
    setRunning(false); terminalRuns.current.add(event.runId); activeRunId.current = null;
    if (event.type === "failed") { setError(event.error.message); return; }
    setTurns((current) => current.some((turn) => turn.id === event.turn.id) ? current : [...current, { ...event.turn, playerAction: pendingActionRef.current }]);
    pendingActionRef.current = "";
    setAction("");
    queueMicrotask(() => streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" }));
  }), []);

  async function loadProfiles() {
    const result = await window.novaxDesktop.play.listStoryProfiles();
    if (!result.ok) { setError(result.error.message); return; }
    setProfiles(result.profiles);
    setProfileId((current) => result.profiles.some((item) => item.id === current) ? current : result.profiles.find((item) => item.status === "active")?.id ?? "");
  }
  async function loadPlaythroughs(nextProfileId: string) {
    const result = await window.novaxDesktop.play.listPlaythroughs({ storyProfileId: nextProfileId });
    if (!result.ok) { setError(result.error.message); return; }
    setPlaythroughs(result.playthroughs);
    setPlaythroughId((current) => result.playthroughs.some((item) => item.id === current) ? current : result.playthroughs.find((item) => item.status === "active")?.id ?? "");
  }
  async function loadStarts(nextProfileId: string) {
    const result = await window.novaxDesktop.play.listStartProfiles({ storyProfileId: nextProfileId });
    if (!result.ok) { setError(result.error.message); return; }
    const active = result.startProfiles.filter((item) => item.status === "active"); setStarts(active); setStartId(active[0]?.id ?? "");
  }
  async function loadTurns(nextPlaythroughId: string) {
    const result = await window.novaxDesktop.play.listTurns({ playthroughId: nextPlaythroughId });
    if (!result.ok) { setError(result.error.message); return; }
    setTurns(result.turns);
  }
  async function createProfile() {
    if (!newStoryId || !newWorldId) return;
    setBusy(true); setError(null);
    try {
      const story = stories.find((item) => item.id === newStoryId)!;
      const result = await window.novaxDesktop.play.createStoryProfile({ storyResourceId: newStoryId, worldResourceId: newWorldId, title: story.title, ocBindings: [] });
      if (!result.ok) { setError(result.error.message); return; }
      await loadProfiles(); setProfileId(result.profile.id);
    } finally { setBusy(false); }
  }
  async function createPlaythrough() {
    if (!profileId) return;
    setBusy(true); setError(null);
    try {
      const result = await window.novaxDesktop.play.createPlaythrough({ storyProfileId: profileId, startProfileId: startId || null });
      if (!result.ok) { setError(result.error.message); return; }
      await loadPlaythroughs(profileId); setPlaythroughId(result.playthrough.id);
    } finally { setBusy(false); }
  }
  async function submitAction() {
    const value = action.trim(); if (!value || !playthroughId || running) return;
    setError(null);
    const inspect = await window.novaxDesktop.play.inspect({ playthroughId });
    if (!inspect.ok) { setError(inspect.error.message); return; }
    if (inspect.reconciliation.state === "canon_diverged") { setPendingConflict({ action: value, playthroughId }); return; }
    await startTurn(playthroughId, value);
  }
  async function startTurn(targetPlaythroughId: string, value: string) {
    setRunning(true);
    pendingActionRef.current = value;
    const response = await window.novaxDesktop.play.runTurn({ playthroughId: targetPlaythroughId, playerAction: value });
    if (terminalRuns.current.has(response.runId)) terminalRuns.current.delete(response.runId);
    else activeRunId.current = response.runId;
  }
  async function resolveConflict(decision: "continue_pinned" | "fork_from_current") {
    if (!pendingConflict) return;
    const result = await window.novaxDesktop.play.resolve({ playthroughId: pendingConflict.playthroughId, decision });
    if (!result.ok) { setError(result.error.message); setPendingConflict(null); return; }
    const value = pendingConflict.action; setPendingConflict(null);
    if (result.playthrough.id !== playthroughId) { await loadPlaythroughs(result.playthrough.storyProfileId); setProfileId(result.playthrough.storyProfileId); setPlaythroughId(result.playthrough.id); }
    await startTurn(result.playthrough.id, value);
  }

  return <section className="player-workbench" aria-label="玩家模式">
    <aside className="player-library">
      <div className="player-section-heading"><BookOpen size={16} aria-hidden="true" /><strong>故事</strong></div>
      {profiles.length ? <select aria-label="故事配置" value={profileId} onChange={(event) => setProfileId(event.target.value)} disabled={running}>{profiles.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select> : <div className="player-profile-setup">
        <select aria-label="故事" value={newStoryId} onChange={(event) => setNewStoryId(event.target.value)}><option value="">选择故事</option>{stories.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
        <select aria-label="世界" value={newWorldId} onChange={(event) => setNewWorldId(event.target.value)}><option value="">选择世界</option>{worlds.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
        <button type="button" onClick={createProfile} disabled={busy || !newStoryId || !newWorldId}><Plus size={14} />建立配置</button>
      </div>}
      <div className="player-section-heading"><strong>存档</strong><button type="button" title="新建存档" onClick={createPlaythrough} disabled={running || busy || !profileId}><Plus size={15} /><span className="sr-only">新建存档</span></button></div>
      {starts.length ? <select aria-label="起始模板" value={startId} onChange={(event) => setStartId(event.target.value)} disabled={running}><option value="">不使用起始模板</option>{starts.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select> : null}
      <div className="player-save-list">{playthroughs.map((item, index) => <button key={item.id} type="button" aria-pressed={item.id === playthroughId} onClick={() => setPlaythroughId(item.id)} disabled={running}><span>存档 {index + 1}</span><small>{item.currentTurnId ? "继续" : "未开始"}</small></button>)}</div>
    </aside>

    <div className="player-reader">
      <div className="player-turn-stream" ref={streamRef} aria-live="polite">
        {turns.length ? turns.map((turn) => <article className="player-turn-card" key={turn.id}><p className="player-action-line">你选择：{turn.playerAction}</p><div className="player-prose">{turn.writerText.split("\n").map((line, index) => <p key={index}>{line || "\u00a0"}</p>)}</div></article>) : <div className="player-empty"><BookOpen size={28} strokeWidth={1.3} /><h1>{playthroughId ? "故事尚未开始" : "选择或建立一个存档"}</h1></div>}
      </div>
      <div className="player-composer">
        {error ? <div className="player-blocked" role="alert">{error}<button type="button" title="关闭" onClick={() => setError(null)}>×</button></div> : null}
        <textarea aria-label="玩家行动" value={action} onChange={(event) => setAction(event.target.value)} disabled={!playthroughId || running} rows={2} />
        <button className="player-send" type="button" title={running ? "正在处理" : "提交行动"} onClick={submitAction} disabled={!playthroughId || !action.trim() || running}>{running ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}<span className="sr-only">提交行动</span></button>
      </div>
    </div>

    <aside className="player-state-panel"><div className="player-section-heading"><strong>当前状态</strong></div>{publicState.length ? <dl>{publicState.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl> : <p>暂无公开状态</p>}</aside>

    {pendingConflict ? <div className="player-conflict-backdrop" role="presentation"><div className="player-conflict-dialog" role="dialog" aria-modal="true" aria-labelledby="player-conflict-title"><GitFork size={22} /><h2 id="player-conflict-title">当前正史已经变化</h2><p>旧存档不会被自动改写。请选择本次行动要沿用哪条时间线。</p><div><button type="button" onClick={() => resolveConflict("continue_pinned")}><RotateCcw size={16} />继续旧存档</button><button type="button" className="primary" onClick={() => resolveConflict("fork_from_current")}><GitFork size={16} />从当前正史新建分支</button></div></div></div> : null}
  </section>;
}

function visibleState(state: Record<string, unknown> | null) {
  if (!state) return [];
  const labels: Record<string, string> = { location: "位置", health: "生命", stamina: "体力", luck: "幸运", time: "时间", weather: "天气" };
  return Object.entries(labels).flatMap(([key, label]) => {
    const value = state[key];
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? [{ label, value: String(value) }] : [];
  });
}
