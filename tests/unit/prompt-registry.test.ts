import { describe, expect, it } from "vitest";
import { loadActivePromptSet, loadCandidatePromptSet, verifyPromptRegistry } from "../../src/agent-worker/promptRegistry";
import { promptManifest } from "../../src/agent-worker/prompts/manifest";

describe("versioned Prompt registry", () => {
  it("loads the published three-role set and verifies every versioned Prompt hash", () => {
    const prompts = loadActivePromptSet();

    expect(prompts.map(({ id, role, version, status, rollbackTo, sha256 }) => ({
      id,
      role,
      version,
      status,
      rollbackTo,
      hashLength: sha256.length,
    }))).toEqual([
      { id: "novax.steward", role: "steward", version: "1.12.0", status: "active", rollbackTo: "1.11.0", hashLength: 64 },
      { id: "novax.writer", role: "writer", version: "1.7.0", status: "active", rollbackTo: "1.6.0", hashLength: 64 },
      { id: "novax.checker", role: "checker", version: "1.8.0", status: "active", rollbackTo: "1.7.0", hashLength: 64 },
    ]);
    expect(verifyPromptRegistry()).toEqual({ ok: true, verified: 32 });
    expect(promptManifest.filter((prompt) => prompt.id === "novax.steward").map(({ version, status }) => ({
      version,
      status,
    }))).toEqual([
      { version: "1.0.0", status: "deprecated" },
      { version: "1.1.0", status: "deprecated" },
      { version: "1.2.0", status: "deprecated" },
      { version: "1.3.0", status: "deprecated" },
      { version: "1.4.0", status: "deprecated" },
      { version: "1.5.0", status: "deprecated" },
      { version: "1.6.0", status: "deprecated" },
      { version: "1.7.0", status: "deprecated" },
      { version: "1.8.0", status: "deprecated" },
      { version: "1.9.0", status: "deprecated" },
      { version: "1.10.0", status: "deprecated" },
      { version: "1.11.0", status: "deprecated" },
      { version: "1.12.0", status: "active" },
    ]);
    expect(loadCandidatePromptSet().map(({ role, version, status }) => ({ role, version, status }))).toEqual([
      { role: "writer", version: "1.8.0", status: "candidate" },
      { role: "checker", version: "1.9.0", status: "candidate" },
    ]);
  });

  it("binds every active Prompt to the same real publication evidence", () => {
    const active = promptManifest.filter((prompt) => prompt.status === "active");
    expect(active).toHaveLength(3);
    expect(new Set(active.map((prompt) => JSON.stringify(prompt.publicationEvidence))).size).toBe(1);
    expect(active[0]?.publicationEvidence).toMatchObject({
      providerId: "openai-compatible",
      modelId: "deepseek-chat",
      actualModelIds: ["deepseek-v4-flash"],
      reportSha256: "c898144f914ed93713084227ac561a9d3348ce42cc07f05bb3df10dd7ab2ee0e",
    });
  });

  it("keeps Steward authority behind sources, Change Set, Free/Assist, and real tool evidence", () => {
    const steward = loadActivePromptSet().find((prompt) => prompt.role === "steward")?.content || "";

    expect(steward).toContain("对世界事实、角色状态、历史、规则、正文和用户过去决定没有把握时，检索正式资料");
    expect(steward).toContain("正式修改必须形成 Change Set");
    expect(steward).toContain("Free / Assist");
    expect(steward).toContain("没有执行工具时，不得声称已经读取、检索、修改、保存或检查项目");
    expect(steward).toContain("未解决冲突");
    expect(steward).toContain("submit_steward_result");
  });

  it("keeps Writer and Checker outside GM and canon authority", () => {
    const prompts = loadActivePromptSet();
    const writer = prompts.find((prompt) => prompt.role === "writer")?.content || "";
    const checker = prompts.find((prompt) => prompt.role === "checker")?.content || "";

    expect(writer).toContain("你不是 GM");
    expect(writer).toContain("不得新增成败、伤害、奖励、线索或 NPC 决策");
    expect(writer).toContain("候选正文");
    expect(writer).toContain("机器可区分的 `blocked` 结果");
    expect(checker).toContain("不得补写剧情、世界事实或正文");
    expect(checker).toContain("必须且只能调用一次 `submit_checker_result`");
    expect(checker).toContain("`severity`、`category`、`evidence`、`location`、`scope` 和 `reason`");
  });
});
