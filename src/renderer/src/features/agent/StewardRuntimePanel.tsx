import { useEffect, useRef, useState } from "react";
import {
  CircleStop,
  GitFork,
  LoaderCircle,
  Send,
} from "lucide-react";
import type { AgentArtifact, SessionSummary, WorkspaceSnapshot } from "../../../../shared/ipcContract";
import { PendingChangeSets } from "../change-set/PendingChangeSets";
import { AgentArtifactList } from "./AgentArtifactList";
import { AgentMessageContent } from "./AgentMessageContent";
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
  onOpenDocumentReference?(reference: Extract<AgentArtifact, { kind: "document_reference" }>): Promise<void> | void;
  onActivityChange(activity: { label: string; domains: string[] } | null): void;
}

interface FeedEntry {
  id: number | string;
  kind: "user" | "assistant" | "error";
  text: string;
  outcome?: "completed" | "blocked" | "awaiting_confirmation";
  artifacts: AgentArtifact[];
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
  onOpenDocumentReference,
  onActivityChange,
}: StewardRuntimePanelProps) {
  const [mode, setMode] = useState<"assist" | "free">("assist");
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const nextEntryId = useRef(1);
  const terminalRunIds = useRef(new Set<string>());

  useEffect(() => {
    return window.novaxDesktop.agent.subscribe((event) => {
      if (!session || event.sessionId !== session.id) return;
      if (event.type === "run.started") {
        if (!terminalRunIds.current.has(event.runId)) setActiveRunId(event.runId);
        return;
      }
      if (event.type === "run.activity") {
        if (event.phase === "started") {
          setActivity(event.label);
          onActivityChange({ label: event.label, domains: event.domains ?? [] });
        } else if (event.phase === "failed") {
          setActivity(`${event.label}失败`);
          onActivityChange({ label: `${event.label}失败`, domains: event.domains ?? [] });
        } else {
          setActivity(null);
          onActivityChange(null);
        }
        return;
      }

      terminalRunIds.current.add(event.runId);
      setStarting(false);
      setActiveRunId((current) => current === event.runId ? null : current);
      setActivity(null);
      onActivityChange(null);
      if (event.type === "run.completed") {
        appendEntry({ kind: "assistant", text: event.message, outcome: event.outcome, artifacts: event.artifacts });
      } else {
        appendEntry({ kind: "error", text: event.message, artifacts: [] });
      }
    });
  }, [session?.id, onActivityChange]);

  useEffect(() => {
    let cancelled = false;
    setEntries([]);
    setDraft("");
    setActiveRunId(null);
    setStarting(false);
    setActivity(null);
    onActivityChange(null);
    terminalRunIds.current.clear();
    if (session) {
      void window.novaxDesktop.session.messages({ sessionId: session.id }).then((result) => {
        if (cancelled) return;
        setEntries(result.messages.map((message) => ({
          id: message.id,
          kind: message.role,
          text: message.text,
          artifacts: message.artifacts,
          outcome: message.outcome === "review"
            ? "awaiting_confirmation"
            : message.outcome === "blocked" ? "blocked" : message.outcome === "completed" ? "completed" : undefined,
        })));
      });
    }
    return () => { cancelled = true; };
  }, [session?.id, messageRefreshKey, onActivityChange]);

  function appendEntry(entry: Omit<FeedEntry, "id">) {
    setEntries((current) => [...current, { ...entry, id: nextEntryId.current++ }]);
  }

  async function sendMessage() {
    const userInput = draft.trim();
    if (!workspace || !projectId || !session || !userInput || starting || activeRunId) return;
    setStarting(true);
    setDraft("");
    appendEntry({ kind: "user", text: userInput, artifacts: [] });
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

  async function cancelRun() {
    if (!activeRunId) return;
    await window.novaxDesktop.agent.cancel({ runId: activeRunId });
  }

  const running = starting || activeRunId !== null;

  return (
    <>
      <div className="steward-feed">
        <div className="steward-state">
          <GitFork size={18} aria-hidden="true" />
          <span>{session ? session.title : workspace ? "选择一个 Agent 会话" : "等待工作区"}</span>
        </div>
        <div className="steward-conversation" aria-live="polite">
          {entries.map((entry) => (
            <article className={`steward-message steward-message--${entry.kind}`} key={entry.id}>
              <span>{entry.kind === "user" ? "你" : entry.kind === "error" ? "运行阻塞" : "大管家"}</span>
              {entry.kind === "assistant"
                ? <AgentMessageContent text={entry.text} />
                : <p>{entry.text}</p>}
              <AgentArtifactList artifacts={entry.artifacts} onOpenChangeSet={onOpenChangeSet} onOpenDocumentReference={onOpenDocumentReference} />
              {entry.outcome === "awaiting_confirmation" ? <small>等待审查</small> : null}
            </article>
          ))}
          {running ? (
            <div className="steward-running" role="status">
              <LoaderCircle size={14} aria-hidden="true" />
              <span>{activity || "大管家正在处理"}</span>
            </div>
          ) : null}
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
      <div className="steward-composer">
        <div className="agent-permission-switch" role="radiogroup" aria-label="大管家提交模式">
          <button type="button" role="radio" aria-checked={mode === "assist"} onClick={() => setMode("assist")} disabled={running}>
            协助
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
