import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import type { WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

export function commitFixtureCheckpoint(
  workspace: WorkspaceDatabase,
  input: { idempotencyKey: string; summary: string; label: string },
  apply: (checkpointId: string, changeSetId: string) => void,
): { changeSetId: string; checkpointId: string } {
  const repository = new ChangeSetRepository(workspace);
  const changeSet = repository.propose({
    idempotencyKey: input.idempotencyKey,
    mode: "assist",
    summary: input.summary,
  });
  const checkpointId = repository.commit(changeSet.id, input.label, (createdCheckpointId) => {
    apply(createdCheckpointId, changeSet.id);
  });
  return { changeSetId: changeSet.id, checkpointId };
}
