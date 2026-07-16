import { useEffect, useRef, useState } from "react";
import {
  Check,
  CircleStop,
  Copy,
  GitFork,
  LoaderCircle,
  Pencil,
  Send,
} from "lucide-react";
import type { AgentArtifact, SessionMessage, SessionSummary, WorkspaceSnapshot } from "../../../../shared/ipcContract";
import type { GrowthPresentationSnapshot } from "../../../../shared/growthPresentationContract";
import { GrowthGuidanceStatus } from "../growth/GrowthGuidanceStatus";
import { GrowthImpactSummary } from "../growth/GrowthImpactSummary";
import { PendingChangeSets } from "../change-set/PendingChangeSets";
import { AgentArtifactList } from "./AgentArtifactList";
import { AgentMessageContent } from "./AgentMessageContent";
import { RunActivityTimeline } from "./RunActivityTimeline";
import {
  appendGrowthAgentEvent,
  advanceGrowthVisualClimax,
  createGrowthPresentation,
  getGrowthGuidanceAvailability,
  isGrowthBoundRun,
  mergeGrowthArtifacts,
  mergeGrowthEvent,
  mergeGrowthSnapshot,
  recordGrowthGuidanceResponse,
  settleGrowthVisualClimax,
  type GrowthVisualClimaxState,
  type GrowthPresentation,
} from "./growthPresentation";
import "./agentMessage.css";

interface StewardRuntimePanelProps {
  workspace: WorkspaceSnapshot | null;
  projectId: string | null;
  session: SessionSummary | null;
  scopeResourceIds: string[];
  changeSetRefreshKey: number;
  messageRefreshKey: number;
  selectedChangeSetId: string | null;
  onOpenChangeSet(changeSetId: string): Promise<void>;
  onCommittedChangeSet(): Promise<void>;
  onOpenDocumentReference?(reference: Extract<AgentArtifact, { kind: "document_reference" }>): Promise<void> | void;
  onReadyImage?(image: Extract<AgentArtifact, { kind: "image" }>): Promise<boolean> | boolean;
  onActivityChange(activity: { label: string; domains: string[] } | null): void;
  onGrowthPresentationChange(presentation: GrowthPresentation | null): void;
  onGrowthArtifactsChange(artifacts: AgentArtifact[]): void;
  growthDetails: GrowthPresentationSnapshot | null;
}

interface FeedEntry {
  id: number | string;
  kind: "user" | "assistant" | "error";
  text: string;
  outcome?: "completed" | "blocked" | "awaiting_confirmation";
  artifacts: AgentArtifact[];
}

export interface GrowthRequestToken {
  generation: number;
  scopeKey: string | null;
}

export function advanceGrowthRequestToken(
  current: GrowthRequestToken,
  scopeKey: string | null,
): GrowthRequestToken {
  return { generation: current.generation + 1, scopeKey };
}

export function isCurrentGrowthRequest(
  current: GrowthRequestToken,
  candidate: GrowthRequestToken,
): boolean {
  return current.generation === candidate.generation && current.scopeKey === candidate.scopeKey;
}

export function StewardRuntimePanel({
  workspace,
  projectId,
  session,
  scopeResourceIds,
  changeSetRefreshKey,
  messageRefreshKey,
  selectedChangeSetId,
  onOpenChangeSet,
  onCommittedChangeSet,
  onOpenDocumentReference,
  onReadyImage,
  onActivityChange,
  onGrowthPresentationChange,
  onGrowthArtifactsChange,
  growthDetails,
}: StewardRuntimePanelProps) {
  const [mode, setMode] = useState<"assist" | "free" | "growth">("assist");
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [copiedEntryId, setCopiedEntryId] = useState<FeedEntry["id"] | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [growthPresentation, setGrowthPresentation] = useState<GrowthPresentation | null>(null);
  const [growthArtifacts, setGrowthArtifacts] = useState<AgentArtifact[]>([]);
  const [guidanceDraft, setGuidanceDraft] = useState("");
  const [guidanceSaving, setGuidanceSaving] = useState(false);
  const [guidanceNotice, setGuidanceNotice] = useState<string | null>(null);
  const [guidanceError, setGuidanceError] = useState<string | null>(null);
  const nextEntryId = useRef(1);
  const terminalRunIds = useRef(new Set<string>());
  const growthRef = useRef<GrowthPresentation | null>(null);
  const growthArtifactsRef = useRef<AgentArtifact[]>([]);
  const committedGrowthChangeSets = useRef(new Set<string>());
  const growthVisualClimax = useRef<GrowthVisualClimaxState>({
    observedRunningGoalIds: [],
    inFlightGoalAssetKeys: [],
    openedGoalAssetKeys: [],
  });
  const callbacks = useRef({
    onActivityChange,
    onCommittedChangeSet,
    onGrowthArtifactsChange,
    onGrowthPresentationChange,
    onReadyImage,
  });
  callbacks.current = {
    onActivityChange,
    onCommittedChangeSet,
    onGrowthArtifactsChange,
    onGrowthPresentationChange,
    onReadyImage,
  };

  const growthStorageKey = projectId && session ? `novelx:growth-goal:${projectId}:${session.id}` : null;
  const growthLoadRequestToken = useRef<GrowthRequestToken>({ generation: 0, scopeKey: null });
  const growthGuidanceRequestToken = useRef<GrowthRequestToken>({ generation: 0, scopeKey: null });
  if (growthLoadRequestToken.current.scopeKey !== growthStorageKey) {
    growthLoadRequestToken.current = advanceGrowthRequestToken(growthLoadRequestToken.current, growthStorageKey);
  }
  if (growthGuidanceRequestToken.current.scopeKey !== growthStorageKey) {
    growthGuidanceRequestToken.current = advanceGrowthRequestToken(growthGuidanceRequestToken.current, growthStorageKey);
  }

  function beginGrowthLoadRequest() {
    const next = advanceGrowthRequestToken(growthLoadRequestToken.current, growthStorageKey);
    growthLoadRequestToken.current = next;
    return next;
  }

  function beginGrowthGuidanceRequest() {
    const next = advanceGrowthRequestToken(growthGuidanceRequestToken.current, growthStorageKey);
    growthGuidanceRequestToken.current = next;
    return next;
  }

  function publishGrowth(next: GrowthPresentation | null) {
    if (next && growthRef.current && growthRef.current.goalId !== next.goalId) resetGrowthVisualState();
    growthRef.current = next;
    setGrowthPresentation(next);
    callbacks.current.onGrowthPresentationChange(next);
    maybeOpenGrowthVisualClimax(next, growthArtifactsRef.current);
  }

  function publishGrowthArtifacts(next: AgentArtifact[]) {
    growthArtifactsRef.current = next;
    setGrowthArtifacts(next);
    callbacks.current.onGrowthArtifactsChange(next);
    maybeOpenGrowthVisualClimax(growthRef.current, next);
  }

  function resetGrowthVisualState() {
    growthArtifactsRef.current = [];
    setGrowthArtifacts([]);
    callbacks.current.onGrowthArtifactsChange([]);
    growthVisualClimax.current = {
      observedRunningGoalIds: [],
      inFlightGoalAssetKeys: [],
      openedGoalAssetKeys: [],
    };
  }

  function maybeOpenGrowthVisualClimax(presentation: GrowthPresentation | null, artifacts: AgentArtifact[]) {
    const decision = advanceGrowthVisualClimax(growthVisualClimax.current, presentation, artifacts);
    growthVisualClimax.current = decision.state;
    if (!decision.artifact || !decision.key) return;
    const callback = callbacks.current.onReadyImage;
    if (!callback) {
      growthVisualClimax.current = settleGrowthVisualClimax(growthVisualClimax.current, decision.key, false);
      return;
    }
    const key = decision.key;
    void Promise.resolve().then(() => callback(decision.artifact!)).then(
      (opened) => {
        growthVisualClimax.current = settleGrowthVisualClimax(growthVisualClimax.current, key, opened);
      },
      () => {
        growthVisualClimax.current = settleGrowthVisualClimax(growthVisualClimax.current, key, false);
      },
    );
  }

  function clearStoredGrowth() {
    if (growthStorageKey) window.localStorage.removeItem(growthStorageKey);
    resetGrowthVisualState();
    publishGrowth(null);
  }

  function addGrowthArtifacts(artifacts: AgentArtifact[]) {
    if (artifacts.length === 0) return;
    publishGrowthArtifacts(mergeGrowthArtifacts(growthArtifactsRef.current, artifacts));
  }

  useEffect(() => {
    const subscriptionScopeKey = growthStorageKey;
    return window.novaxDesktop.agent.subscribe((event) => {
      if (!session || event.sessionId !== session.id) return;
      const growth = growthRef.current;
      const isGrowthRun = isGrowthBoundRun(growth, event.runId);
      if (isGrowthRun && growthLoadRequestToken.current.scopeKey !== subscriptionScopeKey) return;
      if (event.type === "run.started") {
        if (!terminalRunIds.current.has(event.runId)) setActiveRunId(event.runId);
        return;
      }
      if (event.type === "run.activity") {
        if (isGrowthRun && growth) publishGrowth(appendGrowthAgentEvent(growth, event));
        if (event.phase === "started") {
          setActivity(event.label);
          callbacks.current.onActivityChange({ label: event.label, domains: event.domains ?? [] });
        } else if (event.phase === "failed") {
          setActivity(`${event.label}失败`);
          callbacks.current.onActivityChange({ label: `${event.label}失败`, domains: event.domains ?? [] });
        } else {
          setActivity(null);
          callbacks.current.onActivityChange(null);
        }
        return;
      }

      terminalRunIds.current.add(event.runId);
      setActiveRunId((current) => current === event.runId ? null : current);
      setActivity(null);
      callbacks.current.onActivityChange(null);
      if (isGrowthRun) {
        addGrowthArtifacts(event.artifacts);
        return;
      }
      setStarting(false);
      if (event.type === "run.completed") {
        appendEntry({ kind: "assistant", text: event.message, outcome: event.outcome, artifacts: event.artifacts });
        for (const artifact of event.artifacts) {
          if (artifact.kind === "image" && artifact.status === "ready") void callbacks.current.onReadyImage?.(artifact);
        }
        if (event.changeSetState === "committed" && event.artifacts.some((artifact) => (
          artifact.kind === "change_set" && artifact.state === "committed"
        ))) void callbacks.current.onCommittedChangeSet();
      } else {
        appendEntry({ kind: "error", text: event.message, artifacts: event.artifacts });
      }
    });
  }, [growthStorageKey, session?.id]);

  useEffect(() => {
    if (!session) return;
    const subscriptionScopeKey = growthStorageKey;
    return window.novaxDesktop.growth.subscribe((live) => {
      const current = growthRef.current;
      if (growthLoadRequestToken.current.scopeKey !== subscriptionScopeKey
        || live.sessionId !== session.id || !current || live.event.goalId !== current.goalId) return;
      const next = mergeGrowthEvent(current, live.event);
      publishGrowth(next);
      if (live.event.runId && live.event.durableState === "running" && !terminalRunIds.current.has(live.event.runId)) {
        setActiveRunId(live.event.runId);
      }
      if (live.event.phase === "change_set_committed" && live.event.durableState === "committed"
        && !committedGrowthChangeSets.current.has(live.event.targetId)) {
        committedGrowthChangeSets.current.add(live.event.targetId);
        void callbacks.current.onCommittedChangeSet();
      }
      void restoreGrowth(current.goalId);
    });
  }, [growthStorageKey, session?.id]);

  useEffect(() => () => {
    growthGuidanceRequestToken.current = advanceGrowthRequestToken(growthGuidanceRequestToken.current, null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setEntries([]);
    setDraft("");
    setActiveRunId(null);
    setStarting(false);
    setActivity(null);
    setCopiedEntryId(null);
    setActionNotice(null);
    setGuidanceDraft("");
    setGuidanceSaving(false);
    setGuidanceNotice(null);
    setGuidanceError(null);
    resetGrowthVisualState();
    growthRef.current = null;
    setGrowthPresentation(null);
    callbacks.current.onGrowthPresentationChange(null);
    committedGrowthChangeSets.current.clear();
    callbacks.current.onActivityChange(null);
    terminalRunIds.current.clear();
    if (session) {
      void window.novaxDesktop.session.messages({ sessionId: session.id }).then((result) => {
        if (cancelled) return;
        setEntries(toFeedEntries(result.messages));
      });
    }
    return () => { cancelled = true; };
  }, [projectId, session?.id, messageRefreshKey]);

  useEffect(() => {
    if (!growthStorageKey || !projectId || !session) return;
    const goalId = window.localStorage.getItem(growthStorageKey);
    if (goalId) void restoreGrowth(goalId);
  }, [growthStorageKey, projectId, session?.id]);

  function appendEntry(entry: Omit<FeedEntry, "id">) {
    setEntries((current) => [...current, { ...entry, id: nextEntryId.current++ }]);
  }

  async function restoreGrowth(goalId: string) {
    const restoreProjectId = projectId;
    const restoreSessionId = session?.id;
    if (!restoreProjectId || !restoreSessionId) return;
    const request = beginGrowthLoadRequest();
    try {
      const snapshot = await window.novaxDesktop.growth.get({ projectId: restoreProjectId, sessionId: restoreSessionId, goalId });
      if (!isCurrentGrowthRequest(growthLoadRequestToken.current, request)) return;
      const next = mergeGrowthSnapshot(growthRef.current, snapshot);
      publishGrowth(next);
      const runId = snapshot.cycles.find((cycle) => cycle.status === "running")?.runId ?? null;
      setActiveRunId(runId);
      setStarting(false);
    } catch {
      if (!isCurrentGrowthRequest(growthLoadRequestToken.current, request)) return;
      clearStoredGrowth();
      setActiveRunId(null);
      setStarting(false);
    }
  }

  async function sendMessage() {
    const userInput = draft.trim();
    if (!workspace || !projectId || !session || !userInput || starting || activeRunId || growthPresentation?.running) return;
    setStarting(true);
    setDraft("");
    setActionNotice(null);
    appendEntry({ kind: "user", text: userInput, artifacts: [] });
    if (mode === "growth") {
      const startProjectId = projectId;
      const startSessionId = session.id;
      const startStorageKey = growthStorageKey;
      const request = beginGrowthLoadRequest();
      try {
        const snapshot = await window.novaxDesktop.growth.start({
          requestId: crypto.randomUUID(),
          projectId: startProjectId,
          sessionId: startSessionId,
          seed: { kind: "text", text: userInput },
          initialRuleText: userInput,
          strategy: "grow_world_story_oc_closure_v4",
        });
        if (!isCurrentGrowthRequest(growthLoadRequestToken.current, request)) return;
        if (startStorageKey) window.localStorage.setItem(startStorageKey, snapshot.goal.id);
        committedGrowthChangeSets.current.clear();
        resetGrowthVisualState();
        publishGrowth(createGrowthPresentation(snapshot));
        const runId = snapshot.cycles.find((cycle) => cycle.status === "running")?.runId ?? null;
        setActiveRunId(runId);
        setStarting(false);
      } catch {
        if (!isCurrentGrowthRequest(growthLoadRequestToken.current, request)) return;
        setStarting(false);
        appendEntry({ kind: "error", text: "生长任务启动失败，未生成任何本地替代结果。", artifacts: [] });
      }
      return;
    }
    try {
      const response = await window.novaxDesktop.agent.start({
        projectId,
        sessionId: session.id,
        userInput,
        mode,
        scopeResourceIds,
      });
      if (!terminalRunIds.current.has(response.runId)) setActiveRunId(response.runId);
    } catch {
      setStarting(false);
      appendEntry({ kind: "error", text: "大管家启动失败，请重试。", artifacts: [] });
    }
  }

  async function saveGrowthGuidance() {
    const current = growthRef.current;
    const ruleText = guidanceDraft.trim();
    const guideProjectId = projectId;
    const guideSessionId = session?.id;
    const availability = current ? getGrowthGuidanceAvailability(current) : null;
    if (!current || !guideProjectId || !guideSessionId || !ruleText || guidanceSaving
      || !availability?.canGuide || !current.guidance) return;
    const request = beginGrowthGuidanceRequest();
    setGuidanceSaving(true);
    setGuidanceNotice(null);
    setGuidanceError(null);
    try {
      const response = await window.novaxDesktop.growth.guide({
        goalId: current.goalId,
        expectedRevision: current.guidance.latestSavedRevision,
        ruleText,
        requestId: crypto.randomUUID(),
      });
      if (!isCurrentGrowthRequest(growthGuidanceRequestToken.current, request)) return;
      const latest = growthRef.current;
      if (!latest || latest.goalId !== current.goalId) return;
      publishGrowth(recordGrowthGuidanceResponse(latest, response));
      setGuidanceDraft("");
      setGuidanceNotice(`已保存为规则修订 #${response.persistedRevision}，等待安全修订轮；第 ${response.nextCycleSequence} 轮仅为候选边界，不承诺一定执行。预计范围：${growthFocusLabels(response.focusKinds)}`);
    } catch {
      if (!isCurrentGrowthRequest(growthGuidanceRequestToken.current, request)) return;
      try {
        const snapshot = await window.novaxDesktop.growth.get({
          projectId: guideProjectId,
          sessionId: guideSessionId,
          goalId: current.goalId,
        });
        if (!isCurrentGrowthRequest(growthGuidanceRequestToken.current, request)) return;
        const latest = growthRef.current;
        if (!latest || latest.goalId !== current.goalId) return;
        publishGrowth(mergeGrowthSnapshot(latest, snapshot));
        setGuidanceError("规则修订可能已变化，已刷新最新状态；未自动重试，请确认后再次保存。");
      } catch {
        if (!isCurrentGrowthRequest(growthGuidanceRequestToken.current, request)) return;
        setGuidanceError("指导保存失败，且无法刷新最新规则状态；未自动重试，请稍后重试。");
      }
    } finally {
      if (isCurrentGrowthRequest(growthGuidanceRequestToken.current, request)) setGuidanceSaving(false);
    }
  }

  async function cancelRun() {
    if (!activeRunId) return;
    await window.novaxDesktop.agent.cancel({ runId: activeRunId });
  }

  async function copyMessage(entry: FeedEntry) {
    try {
      await navigator.clipboard.writeText(entry.text);
      setCopiedEntryId(entry.id);
      setActionNotice("已复制");
      window.setTimeout(() => {
        setCopiedEntryId((current) => current === entry.id ? null : current);
        setActionNotice(null);
      }, 1_500);
    } catch {
      setActionNotice("复制失败");
    }
  }

  async function editLastUserMessage() {
    if (!session || running) return;
    let result;
    try {
      result = await window.novaxDesktop.session.retractLast({ sessionId: session.id });
    } catch {
      setActionNotice("上一条消息撤回失败。");
      return;
    }
    if (!result.ok) {
      setActionNotice(result.message);
      return;
    }
    setEntries(toFeedEntries(result.messages));
    setDraft(result.text);
    setActionNotice("上一条消息已撤回，可以修改后重新发送。");
  }

  const running = starting || activeRunId !== null || growthPresentation?.running === true;
  const lastUserEntryIndex = findLastUserEntryIndex(entries);
  const guidanceAvailability = growthPresentation ? getGrowthGuidanceAvailability(growthPresentation) : null;
  const showGuidanceComposer = Boolean(guidanceAvailability?.canGuide && growthPresentation
    && growthPresentation.currentCycleSequence > 0 && growthPresentation.guidance);

  return (
    <>
      <div className="steward-feed">
        <div className="steward-state">
          <GitFork size={18} aria-hidden="true" />
          <span>{session ? session.title : workspace ? "选择一个 Agent 会话" : "等待工作区"}</span>
        </div>
        <div className="steward-conversation" aria-live="polite">
          {entries.map((entry, index) => (
            <article className={`steward-message steward-message--${entry.kind}`} key={entry.id}>
              <span>{entry.kind === "user" ? "你" : entry.kind === "error" ? "运行阻塞" : "大管家"}</span>
              <div className="steward-message-actions" aria-label="消息操作">
                {entry.kind === "user" && index === lastUserEntryIndex && !running ? (
                  <button type="button" onClick={() => void editLastUserMessage()} title="修改上一句">
                    <Pencil size={14} aria-hidden="true" />
                    <span className="sr-only">修改上一句</span>
                  </button>
                ) : null}
                <button type="button" onClick={() => void copyMessage(entry)} title="复制">
                  {copiedEntryId === entry.id ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                  <span className="sr-only">复制</span>
                </button>
              </div>
              {entry.kind === "assistant"
                ? <AgentMessageContent text={entry.text} />
                : <p>{entry.text}</p>}
              <AgentArtifactList artifacts={entry.artifacts} onOpenChangeSet={onOpenChangeSet} onOpenDocumentReference={onOpenDocumentReference} />
              {entry.outcome === "awaiting_confirmation" ? <small>等待审查</small> : null}
            </article>
          ))}
          {growthPresentation ? <RunActivityTimeline
            presentation={growthPresentation}
            artifacts={growthArtifacts}
            onOpenChangeSet={onOpenChangeSet}
            onOpenDocumentReference={onOpenDocumentReference}
          /> : null}
          {growthPresentation ? <GrowthGuidanceStatus snapshot={growthDetails} /> : null}
          {growthPresentation ? <GrowthImpactSummary snapshot={growthDetails} /> : null}
          {running ? (
            <div className="steward-running" role="status">
              <LoaderCircle size={14} aria-hidden="true" />
              <span>{activity || "大管家正在处理"}</span>
            </div>
          ) : null}
          {actionNotice ? <div className="steward-action-notice" role="status">{actionNotice}</div> : null}
        </div>
        {workspace ? (
          <PendingChangeSets
            workspaceId={workspace.workspaceId}
            refreshKey={changeSetRefreshKey}
            selectedId={selectedChangeSetId}
            onOpen={onOpenChangeSet}
          />
        ) : null}
      </div>
      {growthPresentation ? (
        <section className="growth-guidance-composer" aria-label="追加世界规则或指导">
          <header>
            <strong>追加世界规则/指导</strong>
            {growthPresentation.guidance ? <small>最新已保存 #{growthPresentation.guidance.latestSavedRevision}</small> : null}
          </header>
          {showGuidanceComposer ? (
            <>
              <textarea
                aria-label="追加世界规则或指导"
                disabled={!guidanceAvailability?.canGuide || guidanceSaving}
                placeholder={guidanceAvailability?.reason ?? "补充会保存并等待安全修订轮"}
                rows={2}
                value={guidanceDraft}
                onChange={(event) => setGuidanceDraft(event.target.value)}
              />
              <button type="button" onClick={() => void saveGrowthGuidance()} disabled={!guidanceAvailability?.canGuide || guidanceSaving || !guidanceDraft.trim()}>
                {guidanceSaving ? "保存中" : "保存规则修订"}
              </button>
            </>
          ) : <p>{guidanceAvailability?.reason ?? "当前没有可安全追加指导的下一轮边界。"}</p>}
          {showGuidanceComposer && guidanceAvailability?.reason ? <p>{guidanceAvailability.reason}</p> : null}
          {guidanceNotice ? <div className="growth-guidance-composer__notice" role="status"><strong>等待安全修订轮</strong><span>{guidanceNotice}</span></div> : null}
          {guidanceError ? <p className="growth-guidance-composer__error" role="alert">{guidanceError}</p> : null}
        </section>
      ) : null}
      <div className="steward-composer">
        <div className="agent-permission-switch" role="radiogroup" aria-label="大管家提交模式">
          <button type="button" role="radio" aria-checked={mode === "assist"} onClick={() => setMode("assist")} disabled={running}>
            协助
          </button>
          <button type="button" role="radio" aria-checked={mode === "growth"} onClick={() => setMode("growth")} disabled={running}>
            生长
          </button>
          <button type="button" role="radio" aria-checked={mode === "free"} onClick={() => setMode("free")} disabled={running}>
            自由
          </button>
        </div>
        <textarea
          aria-label="给大管家发送消息"
          disabled={!workspace || !session || running}
          placeholder={!workspace ? "先初始化项目" : !session ? "先创建 Agent 会话" : running ? "大管家正在处理" : "和大管家讨论、检索或修改当前项目"}
          rows={3}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendMessage();
            }
          }}
        />
        {activeRunId ? (
          <button type="button" className="send-command send-command--cancel" onClick={() => void cancelRun()} title="取消任务">
            <CircleStop size={16} aria-hidden="true" />
            <span className="sr-only">取消任务</span>
          </button>
        ) : (
          <button type="button" className="send-command" onClick={() => void sendMessage()} disabled={!workspace || !session || running || !draft.trim()} title="发送">
            <Send size={16} aria-hidden="true" />
            <span className="sr-only">发送</span>
          </button>
        )}
      </div>
    </>
  );
}

function toFeedEntries(messages: SessionMessage[]): FeedEntry[] {
  return messages.map((message) => ({
    id: message.id,
    kind: message.role,
    text: message.text,
    artifacts: message.artifacts,
    outcome: message.outcome === "review"
      ? "awaiting_confirmation"
      : message.outcome === "blocked" ? "blocked" : message.outcome === "completed" ? "completed" : undefined,
  }));
}

function findLastUserEntryIndex(entries: FeedEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.kind === "user") return index;
  }
  return -1;
}

function growthFocusLabels(focusKinds: Array<"world" | "story" | "oc">): string {
  return focusKinds.map((kind) => ({ world: "世界", story: "故事", oc: "OC" })[kind]).join("、");
}
