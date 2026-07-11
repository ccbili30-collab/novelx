import { describe, expect, it } from "vitest";
import { workspaceSnapshotSchema } from "../../src/shared/ipcContract";
import { ProjectWriteQueue } from "../../src/main/workspaceIpc";

describe("workspace Renderer projection", () => {
  const snapshot = {
    workspaceId: "workspace-1",
    name: "我的世界",
    activeBranchId: "branch-1",
    resources: [
      { id: "resource-1", type: "world", objectKind: "world", title: "世界", parentId: null },
    ],
    documents: [],
    relations: [],
    constraintProfiles: [],
  };

  it("accepts domain resources without physical storage details", () => {
    expect(workspaceSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it.each(["rootPath", "databasePath", "machinePath", "locatorJson"])("rejects unsafe field %s", (field) => {
    expect(workspaceSnapshotSchema.safeParse({ ...snapshot, [field]: "C:\\private" }).success).toBe(false);
  });
});

describe("project write queue", () => {
  it("serializes writes and checks cancellation only when a queued write reaches the head", async () => {
    const queue = new ProjectWriteQueue();
    const firstController = new AbortController();
    const secondController = new AbortController();
    let releaseFirst!: () => void;
    const order: string[] = [];
    const first = queue.run(firstController.signal, async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push("first:end");
      return "first";
    });
    const second = queue.run(secondController.signal, async () => {
      order.push("second:start");
      return "second";
    });
    secondController.abort();

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await expect(first).resolves.toBe("first");
    await expect(second).rejects.toMatchObject({ code: "AGENT_RUN_CANCELLED" });
    expect(order).toEqual(["first:start", "first:end"]);
  });
});
