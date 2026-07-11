import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import type { CreativeProjector } from "./projectionCoordinator";
import { RetrievalProjector } from "./retrievalProjector";
import { SemanticGraphProjector } from "./semanticGraphProjector";
import { TimelineProjector } from "./timelineProjector";
import { SummaryProjector } from "./summaryProjector";
import { CharacterKnowledgeProjector } from "./characterKnowledgeProjector";

export function createDefaultProjectors(workspace: WorkspaceDatabase): CreativeProjector[] {
  return [
    new SemanticGraphProjector(workspace),
    new TimelineProjector(workspace),
    new RetrievalProjector(workspace),
    new SummaryProjector(workspace),
    new CharacterKnowledgeProjector(workspace),
  ];
}
