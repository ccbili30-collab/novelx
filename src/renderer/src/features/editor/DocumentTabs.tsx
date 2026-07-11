import { FileText, Plus, X } from "lucide-react";
import type { WorkspaceSnapshot } from "../../../../shared/ipcContract";

type Document = WorkspaceSnapshot["documents"][number];

export function DocumentTabs(props: {
  documents: Document[];
  selectedDocumentId: string | null;
  onSelect(document: Document): Promise<void>;
  onCreate(): void;
  onDelete(document: Document): Promise<void>;
}) {
  return (
    <nav className="document-tabs" aria-label="对象文档">
      <div className="document-tabs__scroll">
        {props.documents.map((document) => (
          <span className="document-tab" data-selected={document.id === props.selectedDocumentId} key={document.id}>
            <button type="button" title={document.title} onClick={() => void props.onSelect(document)}><FileText size={12} /><span>{document.title}</span></button>
            <button type="button" title={`删除文档《${document.title}》`} onClick={() => void props.onDelete(document)}><X size={11} /></button>
          </span>
        ))}
      </div>
      <button className="document-tabs__add" type="button" title="新建文档" onClick={props.onCreate}><Plus size={13} /></button>
    </nav>
  );
}
