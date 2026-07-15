import { describe, expect, it } from "vitest";
import {
  agentArtifactSchema,
  agentRunEventSchema,
  agentRunStartRequestSchema,
  desktopIpcChannels,
  changeSetDecisionRequestSchema,
  changeSetDetailResultSchema,
  changeSetFinalizeAssistRequestSchema,
  collaborationListResultSchema,
  creativeDocumentDiscardWorkingRequestSchema,
  documentOperationResultSchema,
  documentSaveWorkingRequestSchema,
  graphInspectorResultSchema,
  graphSnapshotResultSchema,
  growthGetRequestSchema,
  growthGuideRequestSchema,
  growthGuideResponseSchema,
  growthLiveEventSchema,
  growthStartResponseSchema,
  growthStartRequestSchema,
  handoffSummarySchema,
  projectAddResultSchema,
  projectListResultSchema,
  projectSelectResultSchema,
  sessionCreateRequestSchema,
  sessionListResultSchema,
  sessionListRequestSchema,
  sessionExportResultSchema,
  sessionMessageListResultSchema,
  workspaceImageAssetSchema,
} from "../../src/shared/ipcContract";

describe("desktop IPC contract", () => {
  it("admits only bounded Growth start/get input and safe persisted event projections", () => {
    const start = {
      requestId: "11111111-1111-4111-8111-111111111111", projectId: "project-1", sessionId: "session-1",
      seed: { kind: "text", text: "A seed." }, initialRuleText: "Keep sources.", strategy: "grow_world_story_oc_dynamic_v2",
    };
    expect(growthStartRequestSchema.parse(start)).toEqual(start);
    for (const field of ["goalId", "cycleId", "runId", "branchId", "checkpointId", "lens", "authorizedScopeResourceIds", "apiKey"]) {
      expect(growthStartRequestSchema.safeParse({ ...start, [field]: "forged" }).success, field).toBe(false);
    }
    expect(growthGetRequestSchema.safeParse({ projectId: "project-1", sessionId: "session-1", goalId: "goal-1", scope: ["forged"] }).success).toBe(false);
    const guide = {
      goalId: "goal-1", expectedRevision: 1, ruleText: "Use revised sources.",
      requestId: "22222222-2222-4222-8222-222222222222",
    };
    expect(growthGuideRequestSchema.parse(guide)).toEqual(guide);
    expect(growthGuideRequestSchema.safeParse({ ...guide, sourceMessageId: "message-1" }).success).toBe(false);
    for (const field of ["projectId", "sessionId", "branchId", "checkpointId", "scopeResourceIds", "lens", "cycleId", "runId"]) {
      expect(growthGuideRequestSchema.safeParse({ ...guide, [field]: "forged" }).success, field).toBe(false);
    }
    expect(growthGuideResponseSchema.parse({
      goalId: "goal-1", persistedRevision: 2, currentCycleRevision: 1,
      appliesAt: "next_cycle_boundary", nextCycleSequence: 2, nextCycleKind: "revision", focusKinds: ["world", "story", "oc"],
      status: "persisted_pending_boundary",
    }).status).toBe("persisted_pending_boundary");
    const event = {
      sessionId: "session-1", strategy: "grow_world_story_oc_dynamic_v2",
      event: { goalId: "goal-1", cycleId: "cycle-1", runId: "run-1", sequence: 1, phase: "run_attached", durableState: "running", safeSummary: "Run attached.", targetKind: "resource", targetId: "world-root", targetVersionId: null, contentRef: null },
    };
    expect(growthLiveEventSchema.parse(event)).toEqual(event);
    for (const field of ["locator", "hash", "machinePath", "prompt", "toolArgs"]) {
      expect(growthLiveEventSchema.safeParse({ ...event, event: { ...event.event, [field]: "unsafe" } }).success, field).toBe(false);
    }
    const versioned = {
      ...event,
      event: {
        ...event.event,
        targetKind: "document", targetId: "document-1", targetVersionId: "version-1",
        contentRef: { kind: "document", targetId: "document-1", targetVersionId: "version-1" },
      },
    };
    expect(growthLiveEventSchema.parse(versioned)).toEqual(versioned);
    expect(growthLiveEventSchema.safeParse({
      ...versioned, event: { ...versioned.event, contentRef: { ...versioned.event.contentRef, locator: "unsafe" } },
    }).success).toBe(false);
    expect(growthStartResponseSchema.safeParse({
      capabilityVersion: "hackathon-growth-dynamic-v2", strategy: "grow_world_story_oc_dynamic_v2", coordinatorStatus: "awaiting_guidance",
      goal: { id: "goal-1", status: "active", currentCycleSequence: 3 },
      cycles: Array.from({ length: 4 }, (_, index) => ({ id: `cycle-${index}`, sequence: index + 1, runId: null, status: "committed" })),
      events: [],
    }).success).toBe(true);
  });

  it("projects world_map as a first-class managed image purpose", () => {
    const image = {
      assetId: "asset-map", jobId: "job-map", title: "雾港群岛地图", purpose: "world_map",
      status: "ready", thumbnailUrl: "novax-asset://image/asset-map", mimeType: "image/png",
      width: 1024, height: 1024, sourceResourceIds: ["world-1"], sourceVersionIds: ["version-1"],
      createdAt: "2026-07-14T00:00:00.000Z",
    };
    expect(workspaceImageAssetSchema.parse(image).purpose).toBe("world_map");
    expect(workspaceImageAssetSchema.safeParse({ ...image, purpose: "placeholder_map" }).success).toBe(false);
  });

  it("accepts auditable artifacts and rejects unstructured document locations", () => {
    expect(agentArtifactSchema.parse({
      kind: "document_reference",
      documentId: "doc-1",
      title: "海岸线设定",
      versionId: "version-3",
      locator: { kind: "line", start: 12, end: 16 },
      excerpt: "海岸因沉降而破碎。",
    })).toMatchObject({ kind: "document_reference", versionId: "version-3" });
    expect(agentArtifactSchema.safeParse({
      kind: "document_reference",
      documentId: "doc-1",
      title: "海岸线设定",
      versionId: "version-3",
      locator: "大概在前面几行",
      excerpt: null,
    }).success).toBe(false);
  });

  it("accepts only bounded author input and explicit Free/Assist mode", () => {
    expect(agentRunStartRequestSchema.parse({
      projectId: "project-1",
      sessionId: "session-1",
      userInput: "讨论银湾海岸",
      mode: "assist",
    })).toEqual({
      projectId: "project-1",
      sessionId: "session-1",
      userInput: "讨论银湾海岸",
      mode: "assist",
      scopeResourceIds: [],
    });
    expect(() => agentRunStartRequestSchema.parse({ projectId: "project-1", sessionId: "session-1", userInput: "", mode: "assist" })).toThrow();
    expect(() => agentRunStartRequestSchema.parse({ projectId: "project-1", sessionId: "session-1", userInput: "讨论", mode: "admin" })).toThrow();
    expect(() => agentRunStartRequestSchema.parse({ projectId: "project-1", sessionId: "session-1", userInput: "讨论", mode: "free", apiKey: "secret" })).toThrow();
    expect(() => agentRunStartRequestSchema.parse({ userInput: "讨论", mode: "assist" })).toThrow();
  });

  it("rejects raw provider, prompt, debug, path, and internal event fields", () => {
    const unsafeFields = ["prompt", "apiKey", "debugMessage", "machinePath", "rawJson", "thinking", "toolArgs"];

    for (const field of unsafeFields) {
      const result = agentRunEventSchema.safeParse({
        type: "run.failed",
        runId: "run-1",
        code: "AGENT_RUN_FAILED",
        message: "任务失败。",
        [field]: "unsafe",
      });
      expect(result.success, field).toBe(false);
    }
  });

  it("uses a closed channel allowlist", () => {
    expect(desktopIpcChannels).toEqual({
      systemStatus: "novax:system-status",
      updateStatus: "novax:update-status",
      updateCheck: "novax:update-check",
      updateDownload: "novax:update-download",
      updateInstall: "novax:update-install",
      updateEvent: "novax:update-event",
      projectList: "novax:project-list",
      projectAdd: "novax:project-add",
      projectFileList: "novax:project-file-list",
      projectFileRead: "novax:project-file-read",
      projectSelect: "novax:project-select",
      projectRemove: "novax:project-remove",
      projectRestore: "novax:project-restore",
      projectListRemoved: "novax:project-list-removed",
      projectRescan: "novax:project-rescan",
      projectInitialize: "novax:project-initialize",
      sessionList: "novax:session-list",
      sessionCreate: "novax:session-create",
      sessionRename: "novax:session-rename",
      sessionArchive: "novax:session-archive",
      sessionClear: "novax:session-clear",
      sessionDelete: "novax:session-delete",
      sessionExport: "novax:session-export",
      sessionMessages: "novax:session-messages",
      sessionRetractLast: "novax:session-retract-last",
      collaborationList: "novax:collaboration-list",
      sharedMemoryPublish: "novax:shared-memory-publish",
      sourceList: "novax:source-list",
      sourceAdd: "novax:source-add",
      sourceParse: "novax:source-parse",
      decompositionCandidateList: "novax:decomposition-candidate-list",
      decompositionCandidateRevise: "novax:decomposition-candidate-revise",
      decompositionCandidateDecide: "novax:decomposition-candidate-decide",
      importCandidatePropose: "novax:import-candidate-propose",
      decomposerStart: "novax:decomposer-start",
      decomposerCancel: "novax:decomposer-cancel",
      decomposerEvent: "novax:decomposer-event",
      handoffCreate: "novax:handoff-create",
      handoffUpdate: "novax:handoff-update",
      workspaceOpen: "novax:workspace-open",
      workspaceCurrent: "novax:workspace-current",
      workspaceHistory: "novax:workspace-history",
      workspaceDoctor: "novax:workspace-doctor",
      workspaceImageAssets: "novax:workspace-image-assets",
      showcaseGet: "novax:showcase-get",
      storyProfileCreate: "novax:story-profile-create",
      storyProfileList: "novax:story-profile-list",
      startProfileCreate: "novax:start-profile-create",
      startProfileList: "novax:start-profile-list",
      playthroughCreate: "novax:playthrough-create",
      playthroughList: "novax:playthrough-list",
      playTurnList: "novax:play-turn-list",
      playthroughInspect: "novax:playthrough-inspect",
      playthroughResolve: "novax:playthrough-resolve",
      playerTurnStart: "novax:player-turn-start",
      playerTurnCancel: "novax:player-turn-cancel",
      playerTurnEvent: "novax:player-turn-event",
      workspaceContextBudget: "novax:workspace-context-budget",
      workspaceRestore: "novax:workspace-restore",
      workspaceFlushRequest: "novax:workspace-flush-request",
      workspaceFlushComplete: "novax:workspace-flush-complete",
      workspaceMutate: "novax:workspace-mutate",
      documentGet: "novax:document-get",
      documentSaveWorking: "novax:document-save-working",
      documentSaveStable: "novax:document-save-stable",
      creativeDocumentGet: "novax:creative-document-get",
      creativeDocumentSaveWorking: "novax:creative-document-save-working",
      creativeDocumentSaveStable: "novax:creative-document-save-stable",
      creativeDocumentDiscardWorking: "novax:creative-document-discard-working",
      constraintEditorGet: "novax:constraint-editor-get",
      constraintEditorSaveWorking: "novax:constraint-editor-save-working",
      constraintEditorSaveStable: "novax:constraint-editor-save-stable",
      constraintEditorDiscardWorking: "novax:constraint-editor-discard-working",
      changeSetListPending: "novax:change-set-list-pending",
      changeSetGet: "novax:change-set-get",
      changeSetDecide: "novax:change-set-decide",
      changeSetFinalizeAssist: "novax:change-set-finalize-assist",
      graphSnapshot: "novax:graph-snapshot",
      graphInspectNode: "novax:graph-inspect-node",
      providerStatus: "novax:provider-status",
      providerSave: "novax:provider-save",
      providerClearCredential: "novax:provider-clear-credential",
      providerTest: "novax:provider-test",
      imageProviderStatus: "novax:image-provider-status",
      imageProviderSave: "novax:image-provider-save",
      imageProviderClearCredential: "novax:image-provider-clear-credential",
      imageProviderTest: "novax:image-provider-test",
      agentStart: "novax:agent-start",
      agentCancel: "novax:agent-cancel",
      agentEvent: "novax:agent-event",
      growthStart: "novax:growth-start",
      growthGet: "novax:growth-get",
      growthGuide: "novax:growth-guide",
      growthEvent: "novax:growth-event",
    });
  });

  it("requires an exact revision when discarding a creative document draft", () => {
    expect(creativeDocumentDiscardWorkingRequestSchema.parse({ documentId: "document-1", expectedRevision: 3 }))
      .toEqual({ documentId: "document-1", expectedRevision: 3 });
    expect(creativeDocumentDiscardWorkingRequestSchema.safeParse({ documentId: "document-1" }).success).toBe(false);
    expect(creativeDocumentDiscardWorkingRequestSchema.safeParse({ documentId: "document-1", expectedRevision: 3, force: true }).success).toBe(false);
  });

  it("projects expose safe identity and detection without filesystem paths", () => {
    const project = {
      id: "project-1",
      name: "Silver Bay",
      state: "materials_detected",
      sessionCount: 2,
      updatedAt: "2026-07-10T12:00:00.000Z",
      active: true,
    };
    expect(projectListResultSchema.parse({ projects: [project] })).toEqual({ projects: [project] });
    expect(projectAddResultSchema.parse({
      project,
      detection: { kind: "existing_materials", fileCount: 8, supportedFileCount: 6 },
    }).detection.kind).toBe("existing_materials");
    expect(projectSelectResultSchema.parse({
      project,
      workspace: null,
      detection: { kind: "existing_materials", fileCount: 8, supportedFileCount: 6 },
    })).toEqual({
      project,
      workspace: null,
      detection: { kind: "existing_materials", fileCount: 8, supportedFileCount: 6 },
    });
    for (const field of ["rootPath", "databasePath", "machinePath", "canonicalPath"]) {
      expect(projectListResultSchema.safeParse({ projects: [{ ...project, [field]: "C:\\private" }] }).success).toBe(false);
    }
  });

  it("sessions are project-scoped and messages never expose private runtime fields", () => {
    expect(sessionListRequestSchema.parse({ projectId: "project-1" })).toEqual({
      projectId: "project-1",
      includeArchived: false,
    });
    expect(sessionCreateRequestSchema.parse({ projectId: "project-1" })).toEqual({
      projectId: "project-1",
      title: "新会话",
    });
    const session = {
      id: "session-1",
      projectId: "project-1",
      title: "Coastline",
      state: "idle",
      archived: false,
      messageCount: 1,
      updatedAt: "2026-07-10T12:00:00.000Z",
    };
    expect(sessionListResultSchema.parse({ sessions: [session] })).toEqual({ sessions: [session] });
    expect(sessionMessageListResultSchema.parse({
      messages: [{
        id: "message-1",
        sessionId: "session-1",
        role: "assistant",
        text: "Draft ready.",
        outcome: "review",
        createdAt: "2026-07-10T12:01:00.000Z",
      }],
    }).messages).toHaveLength(1);
    expect(sessionMessageListResultSchema.safeParse({
      messages: [{
        id: "message-1",
        sessionId: "session-1",
        role: "assistant",
        text: "Draft ready.",
        outcome: "review",
        createdAt: "2026-07-10T12:01:00.000Z",
        rawProviderResponse: "unsafe",
      }],
    }).success).toBe(false);
    expect(sessionExportResultSchema.parse({
      canceled: false,
      filePath: "C:\\exports\\Coastline.md",
      messageCount: 1,
    })).toEqual({ canceled: false, filePath: "C:\\exports\\Coastline.md", messageCount: 1 });
  });

  it("projects collaboration summaries without checkpoint or storage internals", () => {
    const handoff = {
      id: "handoff-1",
      projectId: "project-1",
      senderSessionId: "session-1",
      recipientSessionId: "session-2",
      title: "继续港口章节",
      instructions: "先核验资料。",
      scopeResourceIds: ["story-port"],
      status: "pending",
      createdAt: "2026-07-10T12:00:00.000Z",
      updatedAt: "2026-07-10T12:00:00.000Z",
    } as const;
    expect(handoffSummarySchema.parse(handoff)).toEqual(handoff);
    expect(collaborationListResultSchema.parse({ sharedMemories: [], handoffs: [handoff] }).handoffs).toHaveLength(1);
    expect(handoffSummarySchema.safeParse({ ...handoff, checkpointId: "internal", databasePath: "C:\\private" }).success).toBe(false);
  });

  it("accepts bounded working-copy saves and rejects hidden storage fields", () => {
    expect(documentSaveWorkingRequestSchema.parse({
      resourceId: "resource-1",
      content: "草稿正文",
      expectedRevision: 3,
      expectedStableVersionId: "version-2",
    })).toEqual({
      resourceId: "resource-1",
      content: "草稿正文",
      expectedRevision: 3,
      expectedStableVersionId: "version-2",
    });
    expect(documentSaveWorkingRequestSchema.safeParse({
      resourceId: "resource-1",
      content: "草稿正文",
      expectedRevision: 3,
      expectedStableVersionId: null,
      machinePath: "C:\\private",
    }).success).toBe(false);
  });

  it.each(["rootPath", "databasePath", "machinePath", "locatorJson", "rawJson"])(
    "rejects unsafe document response field %s",
    (field) => {
      expect(documentOperationResultSchema.safeParse({
        ok: true,
        document: {
          resourceId: "resource-1",
          resourceType: "story",
          title: "第一章",
          content: "正文",
          stableVersionId: "version-1",
          workingRevision: 1,
          hasWorkingCopy: true,
          dirty: false,
          [field]: "unsafe",
        },
      }).success).toBe(false);
    },
  );

  it("allows only explicit Assist item decisions and semantic finalize input", () => {
    expect(changeSetDecisionRequestSchema.parse({
      changeSetId: "change-set-1",
      itemId: "item-1",
      decision: "draft",
    })).toEqual({ changeSetId: "change-set-1", itemId: "item-1", decision: "draft" });
    expect(changeSetDecisionRequestSchema.safeParse({
      changeSetId: "change-set-1",
      itemId: "item-1",
      decision: "committed",
    }).success).toBe(false);
    expect(changeSetFinalizeAssistRequestSchema.safeParse({
      changeSetId: "change-set-1",
      label: "接受海岸设定",
      expectedHeadCheckpointId: "hidden-internal-id",
    }).success).toBe(false);
  });

  it.each(["payload", "rawJson", "source", "sourceRef", "machinePath", "debugMessage", "object"])(
    "rejects unsafe Change Set detail field %s",
    (field) => {
      expect(changeSetDetailResultSchema.safeParse({
        ok: true,
        changeSet: {
          id: "change-set-1",
          summary: "记录银湾海岸",
          mode: "assist",
          status: "pending",
          gateStatus: "review_pending",
          blockedReason: null,
          itemCount: 1,
          pendingCount: 1,
          items: [{
            id: "item-1",
            kind: "fact",
            kindLabel: "世界事实",
            decision: "pending",
            risk: "low",
            conflicts: [],
            semanticSummary: "银湾海岸 · 形成原因",
            contentPreview: "沉降纪元造成差异侵蚀。",
            dependsOn: [],
            [field]: "unsafe",
          }],
        },
      }).success).toBe(false);
    },
  );

  it.each(["ref", "rawRef", "path", "locator", "checkpointId", "payload", "databasePath"])(
    "rejects unsafe graph snapshot field %s",
    (field) => {
      expect(graphSnapshotResultSchema.safeParse({
        ok: true,
        graph: {
          lens: {
            type: "creator",
            label: "创作者视角",
            characterLensAvailable: false,
            limitation: "角色认知视角尚未实现。",
          },
          nodes: [{
            id: "graph-node-1",
            kind: "fact",
            label: "银湾海岸 · 形成原因",
            description: "沉降纪元与海水倒灌",
            semanticType: "assertion",
            scope: { id: "graph-scope-1", label: "世界", type: "world" },
            status: "current",
            conflict: false,
            sourceCount: 1,
            relationCount: 1,
            [field]: "unsafe",
          }],
          edges: [],
          filterOptions: {
            nodeKinds: ["fact"],
            semanticTypes: ["assertion"],
            scopeTypes: ["world"],
            statuses: ["current"],
          },
        },
      }).success).toBe(false);
    },
  );

  it("accepts semantic graph inspection without raw source records", () => {
    expect(graphInspectorResultSchema.parse({
      ok: true,
      inspector: {
        node: {
          id: "graph-node-1",
          kind: "fact",
          label: "银湾海岸 · 形成原因",
          description: "沉降纪元与海水倒灌",
          semanticType: "assertion",
          scope: { id: "graph-scope-1", label: "世界", type: "world" },
          status: "current",
          conflict: false,
          sourceCount: 1,
          relationCount: 1,
        },
        detail: {
          kind: "fact",
          subject: "银湾海岸",
          predicate: "形成原因",
          valueSummary: "沉降纪元与海水倒灌",
          status: "current",
          scope: { id: "graph-scope-1", label: "世界", type: "world" },
          sources: [{ type: "change_set", label: "已确认变更：海岸设定" }],
        },
        relations: [],
      },
    }).ok).toBe(true);
    expect(graphInspectorResultSchema.safeParse({
      ok: true,
      inspector: {
        node: {
          id: "graph-node-1",
          kind: "fact",
          label: "事实",
          description: "内容",
          semanticType: "assertion",
          scope: { id: "graph-scope-1", label: "世界", type: "world" },
          status: "current",
          conflict: false,
          sourceCount: 1,
          relationCount: 0,
        },
        detail: {
          kind: "fact",
          subject: "事实",
          predicate: "关系",
          valueSummary: "内容",
          status: "current",
          scope: { id: "graph-scope-1", label: "世界", type: "world" },
          sources: [{ type: "change_set", label: "来源", ref: "private" }],
        },
        relations: [],
      },
    }).success).toBe(false);
  });
});
