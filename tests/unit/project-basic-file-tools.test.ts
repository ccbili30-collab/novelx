import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangeSetPolicyEvaluator } from "../../src/domain/changeSet/changeSetService";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { createWorkspaceAgentToolGateway } from "../../src/main/workspaceAgentToolGateway";

const opened: Array<{ root: string; workspace: WorkspaceDatabase }> = [];

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.workspace.close();
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

describe("basic project file tools", () => {
  it("discovers and reads a Chinese Markdown project that has no README", async () => {
    const { root, workspace } = createWorkspace();
    const fixtures = {
      "01-力量体系.md": "# 力量体系\n潮汐术需要以记忆作为代价。\n",
      "02-场景地图与世界观.md": "# 场景地图与世界观\n银湾海岸由海水倒灌形成。\n",
      "03-人物关系图.md": "# 人物关系图\n林雾与沈星是同伴。\n",
      "04-物品大全.md": "# 物品大全\n银贝指南针指向潮汐裂隙。\n",
    };
    for (const [fileName, content] of Object.entries(fixtures)) {
      fs.writeFileSync(path.join(root, fileName), content, "utf8");
    }
    const gateway = createWorkspaceAgentToolGateway(workspace, noOpPolicy, () => true);
    const context = invocationContext();

    await expect(gateway.readProjectFile({ path: "README.md" }, context))
      .rejects.toMatchObject({ code: "PROJECT_FILE_NOT_FOUND" });

    const listing = await gateway.listProjectDirectory({ path: "" }, context);
    expect(listing.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path))
      .toEqual(Object.keys(fixtures));

    const glob = await gateway.globProjectFiles({ pattern: "**/*.md", path: "" }, context);
    expect(glob.entries.map((entry) => entry.path)).toEqual(Object.keys(fixtures));

    const stat = await gateway.statProjectFile({ path: "02-场景地图与世界观.md" }, context);
    expect(stat).toMatchObject({ kind: "file", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });

    const search = await gateway.searchProjectFiles({ query: "潮汐", path: "" }, context);
    expect(search.matches.map((match) => match.path)).toEqual([
      "01-力量体系.md",
      "04-物品大全.md",
    ]);

    const reads = await Promise.all(Object.keys(fixtures).map((fileName) => (
      gateway.readProjectFile({ path: fileName }, context)
    )));
    expect(reads.map((file) => file.path)).toEqual(Object.keys(fixtures));
    expect(reads.every((file) => file.kind === "text" && file.complete && file.content)).toBe(true);
  });
});

const noOpPolicy: ChangeSetPolicyEvaluator = {
  assess: (candidate) => candidate.items.map((item) => ({ itemId: item.id, risk: "low", conflicts: [] })),
};

function invocationContext() {
  return {
    runId: "basic-file-tools-run",
    invocationId: "basic-file-tools-run:steward",
    requestId: "11111111-1111-4111-8111-111111111111",
    mode: "assist" as const,
    signal: new AbortController().signal,
  };
}

function createWorkspace(): { root: string; workspace: WorkspaceDatabase } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-basic-file-tools-"));
  const workspace = openWorkspace(root);
  opened.push({ root, workspace });
  return { root, workspace };
}
