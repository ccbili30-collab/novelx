import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import { AlertCircle, FileText, LoaderCircle, Save } from "lucide-react";
import type { EditorDocumentSnapshot, WorkspaceSnapshot } from "../../../../shared/ipcContract";

type WorkspaceResource = WorkspaceSnapshot["resources"][number];
type SaveState = "loading" | "stable" | "unsaved" | "saving" | "draft" | "error";

const resourceTypeLabels: Record<WorkspaceResource["type"], string> = {
  world: "世界设定",
  oc: "角色资料",
  story: "故事正文",
  graph: "语义图谱",
  timeline: "时间线",
  asset: "视觉资产",
};

export interface EditorHostHandle {
  flush(): Promise<void>;
}

export const EditorHost = forwardRef<EditorHostHandle, { resource: WorkspaceResource }>(function EditorHost(
  { resource },
  ref,
) {
  const [document, setDocument] = useState<EditorDocumentSnapshot | null>(null);
  const [content, setContent] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const generationRef = useRef(0);
  const pendingSaveTimerRef = useRef<number | null>(null);
  const saveQueueRef = useRef(new Map<string, Promise<EditorDocumentSnapshot>>());
  const latestRef = useRef({ content: "", document: null as EditorDocumentSnapshot | null });

  useEffect(() => {
    const generation = ++generationRef.current;
    setDocument(null);
    setContent("");
    setErrorMessage(null);
    setSaveState("loading");

    void window.novaxDesktop.document.get({ resourceId: resource.id })
      .then((next) => {
        if (generationRef.current !== generation) return;
        latestRef.current = { content: next.content, document: next };
        setDocument(next);
        setContent(next.content);
        setSaveState(next.dirty ? "draft" : "stable");
      })
      .catch((error: unknown) => {
        if (generationRef.current !== generation) return;
        setErrorMessage(readErrorMessage(error));
        setSaveState("error");
      });

    return () => {
      const latest = latestRef.current;
      if (!latest.document || latest.document.resourceId !== resource.id || latest.content === latest.document.content) return;
      void queueWorkingSave(latest.document, latest.content).catch(() => undefined);
    };
  }, [resource.id]);

  useEffect(() => {
    if (!document || content === document.content) return;
    setSaveState("unsaved");
    setErrorMessage(null);
    const generation = generationRef.current;
    const timer = window.setTimeout(() => {
      pendingSaveTimerRef.current = null;
      setSaveState("saving");
      void queueWorkingSave(document, content).then((next) => {
        if (generationRef.current !== generation) return;
        latestRef.current = { ...latestRef.current, document: next };
        setDocument(next);
        setSaveState(latestRef.current.content === next.content
          ? (next.dirty ? "draft" : "stable")
          : "unsaved");
      }).catch((error: unknown) => {
        if (generationRef.current !== generation) return;
        setErrorMessage(readErrorMessage(error));
        setSaveState("error");
      });
    }, 700);
    pendingSaveTimerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (pendingSaveTimerRef.current === timer) pendingSaveTimerRef.current = null;
    };
  }, [content, document]);

  async function saveStable() {
    if (!document || saveState === "loading" || saveState === "saving") return;
    if (pendingSaveTimerRef.current !== null) {
      window.clearTimeout(pendingSaveTimerRef.current);
      pendingSaveTimerRef.current = null;
    }
    setErrorMessage(null);
    setSaveState("saving");
    const generation = generationRef.current;
    const requestedContent = latestRef.current.content;
    let workingSnapshot: EditorDocumentSnapshot | null = null;
    try {
      const working = await queueWorkingSave(document, requestedContent);
      workingSnapshot = working;
      if (!working.dirty) {
        if (generationRef.current === generation) {
          latestRef.current = { ...latestRef.current, document: working };
          setDocument(working);
          setSaveState(latestRef.current.content === working.content ? "stable" : "unsaved");
        }
        return;
      }
      const stable = await window.novaxDesktop.document.saveStable({
        resourceId: working.resourceId,
        expectedRevision: working.workingRevision,
      });
      if (generationRef.current !== generation) return;
      latestRef.current = { ...latestRef.current, document: stable };
      setDocument(stable);
      if (latestRef.current.content === requestedContent) {
        latestRef.current = { content: stable.content, document: stable };
        setContent(stable.content);
        setSaveState("stable");
      } else {
        setSaveState("unsaved");
      }
    } catch (error) {
      if (generationRef.current !== generation) return;
      if (workingSnapshot) {
        latestRef.current = { ...latestRef.current, document: workingSnapshot };
        setDocument(workingSnapshot);
      }
      setErrorMessage(readErrorMessage(error));
      setSaveState("error");
    }
  }

  function queueWorkingSave(
    baseDocument: EditorDocumentSnapshot,
    nextContent: string,
  ): Promise<EditorDocumentSnapshot> {
    const previous = saveQueueRef.current.get(baseDocument.resourceId) ?? Promise.resolve(baseDocument);
    const request = previous.then((current) => {
      if (current.content === nextContent) return current;
      return window.novaxDesktop.document.saveWorking({
        resourceId: current.resourceId,
        content: nextContent,
        expectedRevision: current.workingRevision,
        expectedStableVersionId: current.stableVersionId,
      });
    });
    saveQueueRef.current.set(baseDocument.resourceId, request);
    const clear = () => {
      if (saveQueueRef.current.get(baseDocument.resourceId) === request) {
        saveQueueRef.current.delete(baseDocument.resourceId);
      }
    };
    void request.then(clear, clear);
    return request;
  }

  async function flush(): Promise<void> {
    if (pendingSaveTimerRef.current !== null) {
      window.clearTimeout(pendingSaveTimerRef.current);
      pendingSaveTimerRef.current = null;
    }
    const generation = generationRef.current;
    const latest = latestRef.current;
    if (!latest.document || latest.content === latest.document.content) return;
    setSaveState("saving");
    setErrorMessage(null);
    try {
      const next = await queueWorkingSave(latest.document, latest.content);
      if (generationRef.current !== generation) return;
      latestRef.current = { ...latestRef.current, document: next };
      setDocument(next);
      setSaveState(latestRef.current.content === next.content
        ? (next.dirty ? "draft" : "stable")
        : "unsaved");
    } catch (error) {
      if (generationRef.current === generation) {
        setErrorMessage(readErrorMessage(error));
        setSaveState("error");
      }
      throw error;
    }
  }

  useImperativeHandle(ref, () => ({ flush }));

  function onEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveStable();
    }
  }

  return (
    <article className="editor-host" aria-label={`${resource.title}编辑器`}>
      <header className="editor-toolbar">
        <div className="editor-identity">
          <FileText size={15} aria-hidden="true" />
          <div>
            <strong>{resource.title}</strong>
            <span>{resourceTypeLabels[resource.type]}</span>
          </div>
        </div>
        <div className={`editor-save-state editor-save-state--${saveState}`} role="status">
          {saveState === "loading" || saveState === "saving" ? <LoaderCircle size={13} aria-hidden="true" /> : null}
          {saveState === "error" ? <AlertCircle size={13} aria-hidden="true" /> : null}
          <span>{saveStateLabel(saveState)}</span>
        </div>
        <button
          className="editor-save-command"
          type="button"
          title="保存稳定版本"
          disabled={!document || saveState === "loading" || saveState === "saving" || (saveState === "stable" && content === document.content)}
          onClick={() => void saveStable()}
        >
          <Save size={16} aria-hidden="true" />
          <span className="sr-only">保存稳定版本</span>
        </button>
      </header>
      {errorMessage ? <div className="editor-error" role="alert">{errorMessage}</div> : null}
      <div className="editor-paper">
        <textarea
          aria-label={`${resource.title}内容`}
          value={content}
          disabled={!document}
          placeholder={document ? "" : "正在载入"}
          onChange={(event) => {
            const nextContent = event.target.value;
            latestRef.current = { ...latestRef.current, content: nextContent };
            setContent(nextContent);
          }}
          onKeyDown={onEditorKeyDown}
          spellCheck={false}
        />
      </div>
    </article>
  );
});

function saveStateLabel(state: SaveState): string {
  switch (state) {
    case "loading": return "正在载入";
    case "stable": return "稳定版本";
    case "unsaved": return "尚未保存";
    case "saving": return "正在保存";
    case "draft": return "草稿已保存";
    case "error": return "保存失败";
  }
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "文档操作失败，请重试。";
}
