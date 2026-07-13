import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import { AlertCircle, FileText, LoaderCircle, Plus, RotateCcw, Save } from "lucide-react";
import type { AgentArtifact, CreativeEditorDocumentSnapshot, WorkspaceSnapshot } from "../../../../shared/ipcContract";

type WorkspaceDocument = WorkspaceSnapshot["documents"][number];
type SaveState = "loading" | "stable" | "unsaved" | "saving" | "draft" | "error";

export interface CreativeDocumentEditorHandle {
  flush(): Promise<void>;
}

export const CreativeDocumentEditorHost = forwardRef<CreativeDocumentEditorHandle, {
  document: WorkspaceDocument;
  refreshKey: number;
  locator?: Extract<AgentArtifact, { kind: "document_reference" }>["locator"] | null;
  onCreateDocument(): void;
}>(function CreativeDocumentEditorHost({ document: documentSummary, refreshKey, locator, onCreateDocument }, ref) {
  const [document, setDocument] = useState<CreativeEditorDocumentSnapshot | null>(null);
  const [content, setContent] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const generationRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const latestRef = useRef({ content: "", document: null as CreativeEditorDocumentSnapshot | null });
  const queueRef = useRef(Promise.resolve<CreativeEditorDocumentSnapshot | null>(null));
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const generation = ++generationRef.current;
    setDocument(null);
    setContent("");
    setSaveState("loading");
    setErrorMessage(null);
    void window.novaxDesktop.creativeDocument.get({ documentId: documentSummary.id }).then((next) => {
      if (generationRef.current !== generation) return;
      latestRef.current = { content: next.content, document: next };
      setDocument(next);
      setContent(next.content);
      setSaveState(next.dirty ? "draft" : "stable");
    }).catch((error: unknown) => {
      if (generationRef.current !== generation) return;
      setErrorMessage(readErrorMessage(error));
      setSaveState("error");
    });
  }, [documentSummary.id, refreshKey]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !document || !locator) return;
    const range = locateContent(content, locator);
    textarea.focus();
    textarea.setSelectionRange(range.start, range.end);
  }, [content, document, locator]);

  useEffect(() => {
    if (!document || content === document.content) return;
    setSaveState("unsaved");
    const generation = generationRef.current;
    const timer = window.setTimeout(() => {
      timerRef.current = null;
      setSaveState("saving");
      void queueWorkingSave(document, content).then((next) => {
        if (generationRef.current !== generation) return;
        latestRef.current = { ...latestRef.current, document: next };
        setDocument(next);
        setSaveState(latestRef.current.content === next.content ? "draft" : "unsaved");
      }).catch((error: unknown) => {
        if (generationRef.current !== generation) return;
        setErrorMessage(readErrorMessage(error));
        setSaveState("error");
      });
    }, 700);
    timerRef.current = timer;
    return () => window.clearTimeout(timer);
  }, [content, document]);

  function queueWorkingSave(base: CreativeEditorDocumentSnapshot, nextContent: string): Promise<CreativeEditorDocumentSnapshot> {
    const request = queueRef.current.then((queued) => {
      const current = queued?.documentId === base.documentId ? queued : base;
      if (current.content === nextContent) return current;
      return window.novaxDesktop.creativeDocument.saveWorking({
        documentId: current.documentId,
        content: nextContent,
        expectedRevision: current.workingRevision,
        expectedStableVersionId: current.stableVersionId,
      });
    });
    queueRef.current = request;
    return request;
  }

  async function flush(): Promise<void> {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    const latest = latestRef.current;
    if (!latest.document || latest.content === latest.document.content) return;
    const next = await queueWorkingSave(latest.document, latest.content);
    latestRef.current = { ...latestRef.current, document: next };
    setDocument(next);
    setSaveState("draft");
  }

  async function saveStable() {
    if (!document) return;
    setSaveState("saving");
    setErrorMessage(null);
    try {
      await flush();
      const latest = latestRef.current.document;
      if (!latest || !latest.dirty) {
        setSaveState("stable");
        return;
      }
      const stable = await window.novaxDesktop.creativeDocument.saveStable({
        documentId: latest.documentId,
        expectedRevision: latest.workingRevision,
      });
      latestRef.current = { content: stable.content, document: stable };
      setDocument(stable);
      setContent(stable.content);
      setSaveState("stable");
    } catch (error) {
      setErrorMessage(readErrorMessage(error));
      setSaveState("error");
    }
  }

  async function discardDraft() {
    if (!document?.hasWorkingCopy || !document.dirty) return;
    if (!window.confirm("放弃当前草稿并恢复最近的稳定版本？未发布内容将被删除。")) return;
    setSaveState("saving");
    setErrorMessage(null);
    try {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      await queueRef.current;
      const latest = latestRef.current.document;
      if (!latest) return;
      const restored = await window.novaxDesktop.creativeDocument.discardWorking({
        documentId: latest.documentId,
        expectedRevision: latest.workingRevision,
      });
      queueRef.current = Promise.resolve(restored);
      latestRef.current = { content: restored.content, document: restored };
      setDocument(restored);
      setContent(restored.content);
      setSaveState("stable");
    } catch (error) {
      setErrorMessage(readErrorMessage(error));
      setSaveState("error");
    }
  }

  useImperativeHandle(ref, () => ({ flush }));

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveStable();
    }
  }

  return (
    <article className="editor-host" aria-label={`${documentSummary.title}编辑器`}>
      <header className="editor-toolbar">
        <div className="editor-identity"><FileText size={15} aria-hidden="true" /><div><strong>{documentSummary.title}</strong><span>{documentKindLabel(documentSummary.kind)}</span></div></div>
        <button className="editor-save-command" type="button" title="新建知识文档" onClick={onCreateDocument}><Plus size={16} aria-hidden="true" /></button>
        <div className={`editor-save-state editor-save-state--${saveState}`} role="status">
          {saveState === "loading" || saveState === "saving" ? <LoaderCircle size={13} aria-hidden="true" /> : null}
          {saveState === "error" ? <AlertCircle size={13} aria-hidden="true" /> : null}
          <span>{saveStateLabel(saveState)}</span>
        </div>
        <button className="editor-save-command" type="button" title="放弃草稿并恢复稳定版本" disabled={!document?.dirty || saveState === "loading" || saveState === "saving"} onClick={() => void discardDraft()}><RotateCcw size={16} aria-hidden="true" /></button>
        <button className="editor-save-command" type="button" title="保存稳定版本" disabled={!document || saveState === "loading" || saveState === "saving"} onClick={() => void saveStable()}><Save size={16} aria-hidden="true" /></button>
      </header>
      {errorMessage ? <div className="editor-error" role="alert">{errorMessage}</div> : null}
      <div className="editor-paper"><textarea ref={textareaRef} aria-label={`${documentSummary.title}内容`} value={content} disabled={!document} onChange={(event) => {
        latestRef.current = { ...latestRef.current, content: event.target.value };
        setContent(event.target.value);
      }} onKeyDown={onKeyDown} spellCheck={false} /></div>
    </article>
  );
});

function saveStateLabel(state: SaveState): string {
  if (state === "loading") return "正在载入";
  if (state === "stable") return "稳定版本";
  if (state === "unsaved") return "尚未保存";
  if (state === "saving") return "正在保存";
  if (state === "draft") return "草稿已保存";
  return "保存失败";
}

function documentKindLabel(kind: WorkspaceDocument["kind"]): string {
  const labels: Record<WorkspaceDocument["kind"], string> = {
    prose: "正文",
    setting: "世界设定",
    character_profile: "角色资料",
    location_profile: "地点资料",
    faction_profile: "势力资料",
    knowledge_note: "知识文档",
    style_guide: "风格指南",
    writing_constraints: "写作约束",
  };
  return labels[kind];
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "文档操作失败，请重试。";
}

function locateContent(
  content: string,
  locator: Extract<AgentArtifact, { kind: "document_reference" }>["locator"],
): { start: number; end: number } {
  if (locator.kind === "section") {
    const start = Math.max(0, content.indexOf(locator.label));
    return { start, end: Math.min(content.length, start + locator.label.length) };
  }
  const lines = content.split("\n");
  const start = lines.slice(0, Math.max(0, locator.start - 1)).reduce((total, line) => total + line.length + 1, 0);
  const end = lines.slice(0, Math.max(locator.start, locator.end)).reduce((total, line) => total + line.length + 1, 0) - 1;
  return { start: Math.min(start, content.length), end: Math.min(Math.max(start, end), content.length) };
}
