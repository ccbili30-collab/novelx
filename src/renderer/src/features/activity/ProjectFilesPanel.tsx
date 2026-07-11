import { useEffect, useMemo, useState } from "react";
import { ChevronRight, File, FileQuestion, Folder, FolderOpen, LoaderCircle, X } from "lucide-react";
import type { ProjectFileEntry, ProjectFileReadResult } from "../../../../shared/ipcContract";

interface ProjectFilesPanelProps {
  projectId: string | null;
  workspaceReady: boolean;
  refreshKey: number;
}

interface FileTreeNode extends ProjectFileEntry {
  name: string;
  children: FileTreeNode[];
}

export function ProjectFilesPanel({ projectId, workspaceReady, refreshKey }: ProjectFilesPanelProps) {
  const [entries, setEntries] = useState<ProjectFileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ProjectFileReadResult | null>(null);

  useEffect(() => {
    let active = true;
    setSelected(null);
    setEntries([]);
    setError(null);
    if (!projectId || !workspaceReady) return () => { active = false; };
    setLoading(true);
    void window.novaxDesktop.workspace.listProjectFiles().then((result) => {
      if (!active) return;
      if (result.ok) {
        setEntries(result.entries);
        setExpanded(new Set(result.entries.filter((entry) => entry.kind === "directory" && !entry.path.includes("/")).map((entry) => entry.path)));
      } else {
        setError(result.error.message);
      }
    }).catch(() => {
      if (active) setError("读取项目目录失败，请重新扫描项目后再试。");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [projectId, workspaceReady, refreshKey]);

  const tree = useMemo(() => buildTree(entries), [entries]);

  async function openFile(path: string) {
    setError(null);
    const result = await window.novaxDesktop.workspace.readProjectFile({ path });
    if (result.ok) setSelected(result);
    else setError(result.error.message);
  }

  return (
    <div className="project-files-panel">
      {loading ? <div className="project-files-state"><LoaderCircle size={14} className="spin" />正在读取项目内容</div> : null}
      {!loading && !workspaceReady ? <div className="project-files-state">初始化项目后即可查看文件。</div> : null}
      {!loading && workspaceReady && entries.length === 0 && !error ? <div className="project-files-state">这个项目文件夹目前是空的。</div> : null}
      {error ? <div className="project-files-state project-files-state--error">{error}</div> : null}
      {tree.length > 0 ? (
        <div className="project-file-tree" role="tree" aria-label="项目文件夹内容">
          {tree.map((node) => <FileTreeRow key={node.path} node={node} depth={0} expanded={expanded} onToggle={(path) => setExpanded(toggleSet(expanded, path))} onOpen={openFile} />)}
        </div>
      ) : null}
      {selected?.ok ? (
        <section className="project-file-preview" aria-label="文件预览">
          <header><span>{selected.file.path}</span><button type="button" title="关闭预览" onClick={() => setSelected(null)}><X size={14} /></button></header>
          {selected.file.kind === "text" && selected.file.content !== null
            ? <pre>{selected.file.content}</pre>
            : <div className="project-file-binary"><FileQuestion size={20} /><span>这是二进制文件，当前只显示文件信息。</span><small>{formatBytes(selected.file.size)}</small></div>}
          {!selected.file.complete ? <footer>内容较长，当前显示前 {selected.file.returnedChars.toLocaleString()} 个字符。</footer> : null}
        </section>
      ) : null}
    </div>
  );
}

function FileTreeRow(props: { node: FileTreeNode; depth: number; expanded: Set<string>; onToggle(path: string): void; onOpen(path: string): Promise<void> }) {
  const isOpen = props.expanded.has(props.node.path);
  const isDirectory = props.node.kind === "directory";
  return (
    <>
      <button
        type="button"
        role="treeitem"
        aria-expanded={isDirectory ? isOpen : undefined}
        className="project-file-row"
        style={{ paddingLeft: 10 + props.depth * 15 }}
        onClick={() => isDirectory ? props.onToggle(props.node.path) : void props.onOpen(props.node.path)}
      >
        {isDirectory ? <ChevronRight className="project-file-chevron" data-open={isOpen} size={13} /> : <span className="project-file-spacer" />}
        {isDirectory ? (isOpen ? <FolderOpen size={15} /> : <Folder size={15} />) : <File size={14} />}
        <span>{props.node.name}</span>
        {!isDirectory && props.node.size !== null ? <small>{formatBytes(props.node.size)}</small> : null}
      </button>
      {isDirectory && isOpen ? props.node.children.map((child) => (
        <FileTreeRow key={child.path} node={child} depth={props.depth + 1} expanded={props.expanded} onToggle={props.onToggle} onOpen={props.onOpen} />
      )) : null}
    </>
  );
}

function buildTree(entries: ProjectFileEntry[]): FileTreeNode[] {
  const nodes = new Map<string, FileTreeNode>();
  for (const entry of entries) nodes.set(entry.path, { ...entry, name: entry.path.split("/").at(-1) ?? entry.path, children: [] });
  const roots: FileTreeNode[] = [];
  for (const node of nodes.values()) {
    const index = node.path.lastIndexOf("/");
    const parent = index < 0 ? null : nodes.get(node.path.slice(0, index));
    if (parent) parent.children.push(node); else roots.push(node);
  }
  const sort = (items: FileTreeNode[]) => items.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, "zh-CN") : a.kind === "directory" ? -1 : 1).forEach((item) => sort(item.children));
  sort(roots);
  return roots;
}

function toggleSet(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value); else next.add(value);
  return next;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
