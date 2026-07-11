import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationRegistryRepository } from "../../src/domain/application/applicationRegistryRepository";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ApplicationRegistryRepository", () => {
  it("persists distinct projects and removes only the registry entry", () => {
    const root = createRoot();
    const projectAPath = path.join(root, "project-a");
    const projectBPath = path.join(root, "project-b");
    fs.mkdirSync(projectAPath);
    fs.mkdirSync(projectBPath);
    const databasePath = path.join(root, "user-data", "application.db");

    let repository = new ApplicationRegistryRepository(databasePath);
    const projectA = repository.registerProject(projectAPath, "uninitialized");
    const projectB = repository.registerProject(projectBPath, "materials_detected");
    expect(projectA.id).not.toBe(projectB.id);
    expect(repository.listProjects().map((project) => project.name)).toEqual(["project-b", "project-a"]);

    repository.removeProject(projectA.id);
    expect(repository.listProjects().map((project) => project.id)).toEqual([projectB.id]);
    expect(fs.existsSync(projectAPath)).toBe(true);
    repository.close();

    repository = new ApplicationRegistryRepository(databasePath);
    const restored = repository.registerProject(projectAPath.toUpperCase(), "uninitialized");
    expect(restored.id).toBe(projectA.id);
    expect(repository.listProjects()).toHaveLength(2);
    repository.close();
  });

  it("lists and restores removed projects without touching their directories", () => {
    const root = createRoot();
    const projectPath = path.join(root, "restorable-world");
    fs.mkdirSync(projectPath);
    const repository = new ApplicationRegistryRepository(path.join(root, "user-data", "application.db"));
    const project = repository.registerProject(projectPath, "ready");

    repository.removeProject(project.id);
    expect(repository.listProjects()).toEqual([]);
    expect(repository.listRemovedProjects()).toEqual([
      expect.objectContaining({ id: project.id, name: "restorable-world", active: false }),
    ]);
    expect(repository.restoreProject(project.id)).toMatchObject({ id: project.id, rootPath: projectPath });
    expect(repository.listProjects()).toHaveLength(1);
    expect(fs.existsSync(projectPath)).toBe(true);
    repository.close();
  });

  it("keeps messages private to their persistent Agent session", () => {
    const root = createRoot();
    const projectPath = path.join(root, "novel");
    fs.mkdirSync(projectPath);
    const databasePath = path.join(root, "user-data", "application.db");
    let repository = new ApplicationRegistryRepository(databasePath);
    const project = repository.registerProject(projectPath, "ready");
    const first = repository.createSession(project.id, "Coastline");
    const second = repository.createSession(project.id, "Timeline");

    repository.appendMessage({
      sessionId: first.id,
      role: "user",
      text: "Why is the coastline broken?",
      outcome: null,
    });
    repository.appendMessage({
      sessionId: first.id,
      role: "assistant",
      text: "The source material suggests subsidence.",
      outcome: "completed",
    });
    repository.appendMessage({
      sessionId: second.id,
      role: "user",
      text: "Check the founding era.",
      outcome: null,
    });

    expect(repository.listMessages(first.id).map((message) => message.text)).toEqual([
      "Why is the coastline broken?",
      "The source material suggests subsidence.",
    ]);
    expect(repository.listMessages(second.id).map((message) => message.text)).toEqual([
      "Check the founding era.",
    ]);
    repository.close();

    repository = new ApplicationRegistryRepository(databasePath);
    expect(repository.listSessions(project.id).map((session) => session.title)).toEqual(["Timeline", "Coastline"]);
    expect(repository.listMessages(first.id)).toHaveLength(2);
    repository.close();
  });

  it("persists structured Agent artifacts across registry restart", () => {
    const root = createRoot();
    const projectPath = path.join(root, "artifact-project");
    fs.mkdirSync(projectPath);
    const databasePath = path.join(root, "user-data", "application.db");
    let repository = new ApplicationRegistryRepository(databasePath);
    const project = repository.registerProject(projectPath, "ready");
    const session = repository.createSession(project.id, "Artifact session");
    repository.appendMessage({
      sessionId: session.id,
      role: "assistant",
      text: "候选变更已生成。",
      outcome: "review",
      artifacts: [
        { kind: "activity", label: "整理项目资料", status: "succeeded", detail: "已完成。" },
        { kind: "tool_call", tool: "checker", label: "一致性检查", status: "succeeded" },
        { kind: "change_set", changeSetId: "change-1", state: "pending_review" },
      ],
    });
    repository.close();

    repository = new ApplicationRegistryRepository(databasePath);
    expect(repository.listMessages(session.id)[0]?.artifacts).toEqual([
      { kind: "activity", label: "整理项目资料", status: "succeeded", detail: "已完成。" },
      { kind: "tool_call", tool: "checker", label: "一致性检查", status: "succeeded" },
      { kind: "change_set", changeSetId: "change-1", state: "pending_review" },
    ]);
    repository.close();
  });

  it("admits only a bounded, explicitly incomplete suffix of private conversation history", () => {
    const root = createRoot();
    const projectPath = path.join(root, "history-budget");
    fs.mkdirSync(projectPath);
    const repository = new ApplicationRegistryRepository(path.join(root, "user-data", "application.db"));
    const project = repository.registerProject(projectPath, "ready");
    const session = repository.createSession(project.id, "历史测试");
    for (const [role, text] of [
      ["user", "第一条"],
      ["assistant", "第二条"],
      ["error", "内部失败"],
      ["user", "第三条"],
      ["assistant", "第四条"],
    ] as const) {
      repository.appendMessage({
        sessionId: session.id,
        role,
        text,
        outcome: role === "user" ? null : role === "assistant" ? "completed" : "blocked",
      });
    }

    expect(repository.listRecentConversation(session.id, { maxMessages: 2, maxUtf8Bytes: 1_000 })).toEqual({
      entries: [
        expect.objectContaining({ role: "user", text: "第三条" }),
        expect.objectContaining({ role: "assistant", text: "第四条" }),
      ],
      completeness: { incomplete: true, omittedMessages: 2 },
    });
    repository.close();
  });

  it("creates exactly one default Agent session for a project without sessions", () => {
    const root = createRoot();
    const projectPath = path.join(root, "existing-novax-project");
    fs.mkdirSync(projectPath);
    const repository = new ApplicationRegistryRepository(path.join(root, "user-data", "application.db"));
    const project = repository.registerProject(projectPath, "ready");

    const first = repository.ensureDefaultSession(project.id);
    const second = repository.ensureDefaultSession(project.id);

    expect(first).toMatchObject({ title: "大管家", projectId: project.id });
    expect(second.id).toBe(first.id);
    expect(repository.listSessions(project.id)).toHaveLength(1);
    repository.close();
  });

  it("shares checkpoint-scoped memory and structured handoffs without exposing another session's private chat", () => {
    const root = createRoot();
    const projectPath = path.join(root, "collaboration");
    fs.mkdirSync(projectPath);
    const repository = new ApplicationRegistryRepository(path.join(root, "user-data", "application.db"));
    const project = repository.registerProject(projectPath, "ready");
    const sender = repository.createSession(project.id, "世界观 Agent");
    const recipient = repository.createSession(project.id, "正文 Agent");
    repository.appendMessage({
      sessionId: sender.id,
      role: "user",
      text: "这条私聊不能跨会话出现",
      outcome: null,
    });
    repository.publishSharedMemory({
      projectId: project.id,
      sourceSessionId: sender.id,
      title: "海岸线设定索引",
      content: "正式事实位于世界领域，需要按当前检查点检索。",
      scopeResourceIds: ["world-coast"],
      checkpointId: "checkpoint-7",
    });
    const handoff = repository.createHandoff({
      projectId: project.id,
      senderSessionId: sender.id,
      recipientSessionId: recipient.id,
      title: "继续写港口章节",
      instructions: "先核验海岸线形成原因，再交给 Writer。",
      scopeResourceIds: ["world-coast", "story-port"],
      checkpointId: "checkpoint-7",
    });

    expect(repository.getCollaborationContext(project.id, recipient.id)).toMatchObject({
      sharedMemories: [{
        title: "海岸线设定索引",
        sourceSessionTitle: "世界观 Agent",
        checkpointId: "checkpoint-7",
      }],
      handoffs: [{
        title: "继续写港口章节",
        senderSessionTitle: "世界观 Agent",
        status: "pending",
      }],
    });
    expect(JSON.stringify(repository.getCollaborationContext(project.id, recipient.id)))
      .not.toContain("这条私聊不能跨会话出现");
    expect(repository.updateHandoffStatus(handoff.id, recipient.id, "accepted").status).toBe("accepted");
    expect(repository.updateHandoffStatus(handoff.id, recipient.id, "completed").status).toBe("completed");
    expect(repository.getCollaborationContext(project.id, recipient.id).handoffs).toEqual([]);
    repository.close();
  });

  it("renames, archives, and restores a session without changing its identity", () => {
    const root = createRoot();
    const projectPath = path.join(root, "world");
    fs.mkdirSync(projectPath);
    const repository = new ApplicationRegistryRepository(path.join(root, "user-data", "application.db"));
    const project = repository.registerProject(projectPath, "ready");
    const session = repository.createSession(project.id, "New session");

    expect(repository.renameSession(session.id, "World history")).toMatchObject({
      id: session.id,
      title: "World history",
    });
    expect(repository.archiveSession(session.id, true)).toMatchObject({ id: session.id, archived: true });
    expect(repository.listSessions(project.id)).toEqual([]);
    expect(repository.archiveSession(session.id, false)).toMatchObject({ id: session.id, archived: false });
    expect(repository.listSessions(project.id)).toHaveLength(1);
    repository.close();
  });

  it("clears messages and deletes a session while preserving published shared memory", () => {
    const root = createRoot();
    const projectPath = path.join(root, "session-lifecycle");
    fs.mkdirSync(projectPath);
    const repository = new ApplicationRegistryRepository(path.join(root, "user-data", "application.db"));
    const project = repository.registerProject(projectPath, "ready");
    const session = repository.createSession(project.id, "Disposable chat");
    repository.appendMessage({ sessionId: session.id, role: "user", text: "draft", outcome: null });

    expect(repository.clearSessionMessages(session.id)).toMatchObject({ id: session.id, messageCount: 0 });
    repository.publishSharedMemory({
      projectId: project.id,
      sourceSessionId: session.id,
      title: "Accepted fact",
      content: "This fact must outlive its source chat.",
      scopeResourceIds: [],
      checkpointId: "checkpoint-1",
    });
    repository.deleteSession(session.id);
    expect(repository.listSessions(project.id, true)).toEqual([]);
    expect(repository.listSharedMemories(project.id)).toEqual([
      expect.objectContaining({ sourceSessionId: null, title: "Accepted fact" }),
    ]);
    repository.close();
  });

  it("removes only safely identified E2E registrations under the temp directory", () => {
    const root = createRoot();
    const tempRoot = path.join(root, "temp");
    const e2ePath = path.join(tempRoot, "novax-e2e-stale-project");
    const normalTempPath = path.join(tempRoot, "my-novel");
    const outsidePath = path.join(root, "novax-e2e-real-project");
    for (const projectPath of [e2ePath, normalTempPath, outsidePath]) fs.mkdirSync(projectPath, { recursive: true });
    const repository = new ApplicationRegistryRepository(path.join(root, "user-data", "application.db"));
    const e2e = repository.registerProject(e2ePath, "ready");
    const normal = repository.registerProject(normalTempPath, "ready");
    const outside = repository.registerProject(outsidePath, "ready");

    expect(repository.removeSafeE2eRegistrations(tempRoot)).toBe(1);
    expect(repository.listProjects().map((project) => project.id).sort()).toEqual([normal.id, outside.id].sort());
    expect(repository.listRemovedProjects()).toEqual([expect.objectContaining({ id: e2e.id })]);
    expect(fs.existsSync(e2ePath)).toBe(true);
    repository.close();
  });

  it("stores source inventory as references without promoting source files", () => {
    const root = createRoot();
    const projectPath = path.join(root, "materials");
    fs.mkdirSync(projectPath);
    const repository = new ApplicationRegistryRepository(path.join(root, "user-data", "application.db"));
    const project = repository.registerProject(projectPath, "materials_detected");
    repository.replaceSourceInventory(project.id, [{
      relativePath: "drafts/chapter.txt",
      kind: "text",
      size: 120,
      modifiedAt: "2026-07-10T12:00:00.000Z",
      sha256: "a".repeat(64),
    }]);

    expect(repository.getSourceInventorySummary(project.id)).toEqual({
      fileCount: 1,
      managedCopyCount: 0,
    });
    repository.close();
    expect(fs.existsSync(path.join(projectPath, ".novax"))).toBe(false);
  });
});

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-application-registry-"));
  roots.push(root);
  return root;
}
