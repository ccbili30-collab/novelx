import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeSetPolicyEvaluator } from "../../src/domain/changeSet/changeSetService";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: unknown[]) => unknown) {
      electron.handlers.set(channel, handler);
    },
  },
  app: {},
  BrowserWindow: class {},
  dialog: {},
}));

import { ApplicationRegistryRepository } from "../../src/domain/application/applicationRegistryRepository";
import { GrowthRepository } from "../../src/domain/growth/growthRepository";
import { registerDesktopIpc } from "../../src/main/registerDesktopIpc";
import { WorkspaceSession } from "../../src/main/workspaceIpc";
import { desktopIpcChannels } from "../../src/shared/ipcContract";

let root: string | undefined;
let application: ApplicationRegistryRepository | undefined;
let session: WorkspaceSession | undefined;
let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  session?.close();
  application?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  dispose = undefined;
  session = undefined;
  application = undefined;
  root = undefined;
  electron.handlers.clear();
});

describe("growth guidance IPC", () => {
  it("accepts only Renderer guidance data and derives project authority in Main", () => {
    const setup = createSetup();
    const guide = requiredHandler(desktopIpcChannels.growthGuide);
    const request = {
      goalId: setup.goalId,
      expectedRevision: 1,
      ruleText: "Use the IPC revision.",
      requestId: "88888888-8888-4888-8888-888888888888",
    };

    expect(guide({}, request)).toEqual({
      goalId: setup.goalId,
      persistedRevision: 2,
      currentCycleRevision: 1,
      appliesAt: "next_cycle_boundary",
      nextCycleSequence: 2,
      nextCycleKind: "revision",
      focusKinds: ["world"],
      status: "persisted_pending_boundary",
    });
    for (const field of ["projectId", "sessionId", "branchId", "checkpointId", "scopeResourceIds", "lens", "cycleId", "runId"]) {
      expect(() => guide({}, { ...request, [field]: "forged" }), field).toThrow();
    }
  });
});

function createSetup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-growth-guidance-ipc-"));
  const policy: ChangeSetPolicyEvaluator = {
    assess: (candidate) => candidate.items.map((item) => ({ itemId: item.id, risk: "low" as const, conflicts: [] })),
  };
  session = new WorkspaceSession(() => policy);
  session.openPath(root);
  application = new ApplicationRegistryRepository(path.join(root, "application.db"));
  const project = application.registerProject(root, "ready");
  application.selectProject(project.id);
  application.createSession(project.id, "Growth IPC");
  const context = session.getGrowthCoordinatorContext();
  if (!context) throw new Error("Expected Growth workspace context.");
  const goalId = "growth-goal:ipc-guidance";
  const repository = new GrowthRepository(context.workspace);
  repository.createGoal({
    id: goalId,
    idempotencyKey: "growth-goal:ipc-guidance",
    branchId: context.branchId,
    seed: { kind: "text", text: "IPC seed." },
    authorizedScopeResourceIds: context.authorizedScopeResourceIds,
    initialRuleText: "Initial IPC rule.",
    sourceMessageId: null,
  });
  repository.beginCycle({
    id: `${goalId}:cycle:1`,
    goalId,
    idempotencyKey: `${goalId}:cycle:1`,
    inputCheckpointId: context.checkpointId,
    ruleRevision: 1,
    intent: { kind: "expand", focusKinds: ["world"], resumeFrontier: ["story", "oc"] },
  });
  const registered = registerDesktopIpc("unused-worker.js", application, undefined, undefined, undefined, undefined, undefined, session);
  dispose = registered.dispose;
  return { goalId };
}

function requiredHandler(channel: string): (...args: unknown[]) => unknown {
  const handler = electron.handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler;
}
