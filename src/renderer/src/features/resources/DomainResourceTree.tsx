import { BookOpenText, ChevronDown, CircleUserRound, Clock3, FileText, FolderInput, GitBranch, Image, Map, Network, Pencil, Plus, Stethoscope, Trash2 } from "lucide-react";
import type { WorkspaceSnapshot } from "../../../../shared/ipcContract";

type WorkspaceResource = WorkspaceSnapshot["resources"][number];
type WorkspaceDocument = WorkspaceSnapshot["documents"][number];

const domains = [
  { type: "world", label: "世界", icon: Map },
  { type: "oc", label: "OC", icon: CircleUserRound },
  { type: "story", label: "故事", icon: BookOpenText },
  { type: "graph", label: "图谱", icon: Network },
  { type: "timeline", label: "时间线", icon: Clock3 },
  { type: "asset", label: "资产", icon: Image },
] as const;

interface DomainResourceTreeProps {
  workspace: WorkspaceSnapshot | null;
  selectedResourceId: string | null;
  selectedDocumentId: string | null;
  selectedDomain: WorkspaceResource["type"] | null;
  onSelect(resourceId: string): Promise<void>;
  onSelectDocument(documentId: string, resourceId: string): Promise<void>;
  onSelectDomain(domain: WorkspaceResource["type"]): Promise<void>;
  onCreate(domain: WorkspaceResource["type"], parent: WorkspaceResource | null): void;
  onRename(resource: WorkspaceResource): void;
  onMove(resource: WorkspaceResource): void;
  onDelete(resource: WorkspaceResource): void;
  onOpenHistory(): void;
  onOpenDoctor(): void;
}

export function DomainResourceTree(props: DomainResourceTreeProps) {
  return (
    <aside className="domain-resource-rail" aria-label="项目资源">
      <div className="panel-heading">
        <span>创作资源</span>
        {props.selectedResourceId ? <span className="resource-tree-actions">
          <button type="button" title="重命名" onClick={() => {
            const resource = props.workspace?.resources.find((item) => item.id === props.selectedResourceId);
            if (resource) props.onRename(resource);
          }}><Pencil size={13} aria-hidden="true" /></button>
          <button type="button" title="移动" onClick={() => {
            const resource = props.workspace?.resources.find((item) => item.id === props.selectedResourceId);
            if (resource) props.onMove(resource);
          }}><FolderInput size={13} aria-hidden="true" /></button>
          <button type="button" title="删除" onClick={() => {
            const resource = props.workspace?.resources.find((item) => item.id === props.selectedResourceId);
            if (resource) props.onDelete(resource);
          }}><Trash2 size={13} aria-hidden="true" /></button>
        </span> : null}
      </div>
      {!props.workspace ? <div className="resource-tree-empty">项目尚未初始化</div> : (
        <><div className="domain-tree" role="tree" aria-label="创作资源">
          {domains.map((domain) => {
            const resources = props.workspace!.resources.filter((resource) => resource.type === domain.type);
            const roots = resources.filter((resource) => !resource.parentId || !resources.some((candidate) => candidate.id === resource.parentId));
            const Icon = domain.icon;
            return (
              <section className="domain-group" key={domain.type}>
                <button
                  type="button"
                  className="domain-heading"
                  data-selected={props.selectedDomain === domain.type}
                  role="treeitem"
                  onClick={() => void props.onSelectDomain(domain.type)}
                >
                  <ChevronDown size={12} aria-hidden="true" />
                  <Icon size={15} aria-hidden="true" />
                  <span>{domain.label}</span>
                  <small>{resources.length}</small>
                </button>
                <button className="domain-add-command" type="button" title={`创建${domain.label}`} onClick={() => props.onCreate(domain.type, null)}>
                  <Plus size={13} aria-hidden="true" />
                </button>
                {roots.map((resource) => (
                  <ResourceBranch
                    all={resources}
                    documents={props.workspace!.documents}
                    depth={0}
                    key={resource.id}
                    resource={resource}
                    selectedResourceId={props.selectedResourceId}
                    selectedDocumentId={props.selectedDocumentId}
                    onSelect={props.onSelect}
                    onSelectDocument={props.onSelectDocument}
                    onCreate={props.onCreate}
                  />
                ))}
                {resources.length === 0 ? <span className="domain-empty">暂无内容</span> : null}
              </section>
            );
          })}
        </div><div className="project-tool-list" aria-label="项目工具">
          <span>项目工具</span>
          <button type="button" onClick={props.onOpenHistory}><GitBranch size={14} aria-hidden="true" /><span>版本与分支</span></button>
          <button type="button" onClick={props.onOpenDoctor}><Stethoscope size={14} aria-hidden="true" /><span>项目体检</span></button>
        </div></>
      )}
    </aside>
  );
}

function ResourceBranch(props: {
  resource: WorkspaceResource;
  all: WorkspaceResource[];
  documents: WorkspaceDocument[];
  depth: number;
  selectedResourceId: string | null;
  selectedDocumentId: string | null;
  onSelect(resourceId: string): Promise<void>;
  onSelectDocument(documentId: string, resourceId: string): Promise<void>;
  onCreate(domain: WorkspaceResource["type"], parent: WorkspaceResource | null): void;
}) {
  const children = props.all.filter((candidate) => candidate.parentId === props.resource.id);
  const documents = props.documents.filter((document) => document.resourceId === props.resource.id);
  return (
    <>
      <div className="domain-resource-line" role="treeitem" data-selected={props.selectedResourceId === props.resource.id}>
        <button
          type="button"
          className="domain-resource-row"
          title={props.resource.title}
          style={{ paddingLeft: 34 + props.depth * 14 }}
          onClick={() => void props.onSelect(props.resource.id)}
        >
          <span>{props.resource.title}</span>
          <small>{objectKindLabel(props.resource.objectKind)}</small>
        </button>
        {canOwnChildren(props.resource.objectKind) ? <button
          className="resource-add-child"
          type="button"
          title="创建下级对象"
          onClick={() => props.onCreate(props.resource.type, props.resource)}
        ><Plus size={12} aria-hidden="true" /></button> : null}
      </div>
      {documents.map((document) => (
        <button
          type="button"
          className="domain-document-row"
          title={document.title}
          data-selected={props.selectedDocumentId === document.id}
          key={document.id}
          style={{ paddingLeft: 48 + props.depth * 14 }}
          onClick={() => void props.onSelectDocument(document.id, props.resource.id)}
        >
          <FileText size={12} aria-hidden="true" />
          <span>{document.title}</span>
        </button>
      ))}
      {children.map((child) => (
        <ResourceBranch {...props} depth={props.depth + 1} key={child.id} resource={child} />
      ))}
    </>
  );
}

function canOwnChildren(kind: WorkspaceResource["objectKind"]): boolean {
  return ["world", "location", "faction", "story", "volume"].includes(kind);
}

function objectKindLabel(kind: WorkspaceResource["objectKind"]): string {
  const labels: Record<WorkspaceResource["objectKind"], string> = {
    domain_root: "",
    world: "世界",
    oc: "角色",
    story: "故事",
    volume: "卷",
    chapter: "章",
    location: "地点",
    faction: "势力",
    oc_variant: "变体",
    graph_view: "图谱",
    timeline_view: "时间线",
    asset_collection: "资产",
  };
  return labels[kind];
}
