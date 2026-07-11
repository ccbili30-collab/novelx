import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentAuditRepository } from "../../src/domain/audit/agentAuditRepository";
import { AgentTaskNoteRepository } from "../../src/domain/agent/agentTaskNoteRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

const opened: Array<{ root: string; workspace: WorkspaceDatabase }> = [];

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.workspace.close();
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

describe("AgentTaskNoteRepository", () => {
  it("persists ordered source-linked notes and replaces the same covered range", () => {
    const workspace = createWorkspace();
    beginRun(workspace, "run-long-read");
    const repository = new AgentTaskNoteRepository(workspace);
    const source = { path: "世界.md", sha256: "a".repeat(64), startChar: 0, endChar: 24_000 };

    const first = repository.save({ runId: "run-long-read", title: "地理", content: "海岸线由沉降形成。", source });
    const replacement = repository.save({ runId: "run-long-read", title: "地理修订", content: "海岸线由沉降与海水倒灌形成。", source });
    repository.save({
      runId: "run-long-read",
      title: "族群",
      content: "精灵源自世界树。",
      source: { path: "世界.md", sha256: "a".repeat(64), startChar: 24_000, endChar: 48_000 },
    });

    expect(replacement.id).toBe(first.id);
    expect(repository.list("run-long-read")).toMatchObject([
      { id: first.id, title: "地理修订", content: "海岸线由沉降与海水倒灌形成。", source },
      { title: "族群", source: { startChar: 24_000, endChar: 48_000 } },
    ]);
  });
});

function createWorkspace(): WorkspaceDatabase {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-agent-notes-"));
  const workspace = openWorkspace(root);
  opened.push({ root, workspace });
  return workspace;
}

function beginRun(workspace: WorkspaceDatabase, runId: string): void {
  new AgentAuditRepository(workspace).beginRun({
    runId,
    mode: "assist",
    userInputSha256: "b".repeat(64),
    providerId: "test",
    requestedModelId: "test-model",
    providerConfigSha256: "c".repeat(64),
  });
}
