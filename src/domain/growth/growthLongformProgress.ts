import type { z } from "zod";
import {
  deriveGrowthLongformOutlineDocumentId,
  growthLongformPersistedOutlineSchema,
} from "../../agent-worker/growth/growthLongformOutline";
import { deriveGrowthLongformSectionDocumentId } from "../../agent-worker/growth/growthLongformSection";
import { AssertionRepository } from "../graph/assertionRepository";
import { CreativeDocumentRepository } from "../workspace/creativeDocumentRepository";
import { CreativeRelationRepository } from "../workspace/creativeRelationRepository";
import { DocumentRepository } from "../workspace/documentRepository";
import { ResourceRepository } from "../workspace/resourceRepository";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";

const PERSONAL_STORY_PREDICATE = "closure.oc.binding.personal_story";

type PersistedOutline = z.infer<typeof growthLongformPersistedOutlineSchema>;

export type GrowthLongformProgressBlockedReason =
  | "GROWTH_LONGFORM_MAIN_STORY_NOT_UNIQUE"
  | "GROWTH_LONGFORM_WORLD_NOT_UNIQUE"
  | "GROWTH_LONGFORM_FOCUS_OC_NOT_FOUND"
  | "GROWTH_LONGFORM_PERSONAL_STORY_BINDING_MISSING"
  | "GROWTH_LONGFORM_PERSONAL_STORY_BINDING_AMBIGUOUS"
  | "GROWTH_LONGFORM_PERSONAL_STORY_BINDING_SOURCE_INVALID"
  | "GROWTH_LONGFORM_PERSONAL_STORY_RESOURCE_INVALID"
  | "GROWTH_LONGFORM_PERSONAL_STORY_RELATIONS_INVALID"
  | "GROWTH_LONGFORM_PERSONAL_STORY_RELATIONS_INVALID"
  | "GROWTH_LONGFORM_OUTLINE_DOCUMENT_MISSING"
  | "GROWTH_LONGFORM_OUTLINE_DOCUMENT_AMBIGUOUS"
  | "GROWTH_LONGFORM_OUTLINE_VERSION_MISSING"
  | "GROWTH_LONGFORM_OUTLINE_INVALID"
  | "GROWTH_LONGFORM_OUTLINE_IDENTITY_MISMATCH"
  | "GROWTH_LONGFORM_SECTION_DOCUMENT_INVALID"
  | "GROWTH_LONGFORM_SECTION_ORDER_INVALID";

export interface GrowthLongformCompletedSection {
  outlineSectionId: string;
  documentId: string;
  documentVersionId: string;
  contentSha256: string;
  evidenceId: string;
}

export interface GrowthLongformPendingSection {
  outlineSectionId: string;
  documentId: string;
  title: string;
  objective: string;
  evidenceIds: string[];
  continuityConstraints: string[];
  estimatedCodePoints: { min: number; max: number };
}

export type GrowthLongformProgress =
  | {
      status: "blocked";
      reason: GrowthLongformProgressBlockedReason;
      checkpointId: string;
      focusOcResourceId: string;
    }
  | {
      status: "ready";
      checkpointId: string;
      mainStoryResourceId: string;
      worldResourceId: string;
      focusOcResourceId: string;
      personalStoryResourceId: string;
      outline: {
        outlineId: string;
        documentId: string;
        documentVersionId: string;
        contentSha256: string;
        storyTitle: string;
        summary: string;
        sections: PersistedOutline["sections"];
      };
      completedSections: GrowthLongformCompletedSection[];
      nextSection: GrowthLongformPendingSection | null;
      complete: boolean;
    };

/** Resolves only checkpoint-pinned, formally committed Longform progress. */
export class GrowthLongformProgressResolver {
  constructor(readonly workspace: WorkspaceDatabase) {}

  resolve(input: { checkpointId: string; focusOcResourceId: string }): GrowthLongformProgress {
    const checkpointId = normalizeIdentifier(input.checkpointId);
    const focusOcResourceId = normalizeIdentifier(input.focusOcResourceId);
    if (!checkpointId || !focusOcResourceId || !this.workspace.db.prepare("SELECT id FROM checkpoints WHERE id = ?").get(checkpointId)) {
      throw progressError("GROWTH_LONGFORM_PROGRESS_INPUT_INVALID");
    }

    const blocked = (reason: GrowthLongformProgressBlockedReason): GrowthLongformProgress => ({
      status: "blocked", reason, checkpointId, focusOcResourceId,
    });
    const resources = new ResourceRepository(this.workspace).listAtCheckpoint(checkpointId);
    const mainStories = resources.filter((resource) => resource.type === "story" && resource.objectKind === "story");
    if (mainStories.length !== 1) return blocked("GROWTH_LONGFORM_MAIN_STORY_NOT_UNIQUE");
    const worlds = resources.filter((resource) => resource.type === "world" && resource.objectKind === "world");
    if (worlds.length !== 1) return blocked("GROWTH_LONGFORM_WORLD_NOT_UNIQUE");
    const focusOc = resources.find((resource) => (
      resource.id === focusOcResourceId && resource.type === "oc" && resource.objectKind === "oc"
    ));
    if (!focusOc) return blocked("GROWTH_LONGFORM_FOCUS_OC_NOT_FOUND");

    const bindings = new AssertionRepository(this.workspace)
      .listCurrentInScopesAtCheckpoint([focusOcResourceId], checkpointId)
      .filter((assertion) => (
        assertion.scopeType === "oc"
        && assertion.scopeId === focusOcResourceId
        && assertion.subject === focusOcResourceId
        && assertion.predicate === PERSONAL_STORY_PREDICATE
      ));
    if (bindings.length === 0) return blocked("GROWTH_LONGFORM_PERSONAL_STORY_BINDING_MISSING");
    if (bindings.length !== 1) return blocked("GROWTH_LONGFORM_PERSONAL_STORY_BINDING_AMBIGUOUS");
    const storyResourceId = bindings[0]!.object.storyResourceId;
    if (typeof storyResourceId !== "string") return blocked("GROWTH_LONGFORM_PERSONAL_STORY_RESOURCE_INVALID");
    const personalStory = resources.find((resource) => (
      resource.id === storyResourceId
      && resource.type === "story"
      && resource.objectKind === "volume"
      && resource.parentId === mainStories[0]!.id
    ));
    if (!personalStory) return blocked("GROWTH_LONGFORM_PERSONAL_STORY_RESOURCE_INVALID");
    const relations = new CreativeRelationRepository(this.workspace).listAtCheckpoint(checkpointId);
    const usesWorld = relations.filter((relation) => (
      relation.kind === "uses_world" && relation.sourceResourceId === personalStory.id
    ));
    const usesOc = relations.filter((relation) => (
      relation.kind === "uses_oc" && relation.sourceResourceId === personalStory.id
    ));
    if (usesWorld.length !== 1 || usesWorld[0]!.targetResourceId !== worlds[0]!.id
      || usesOc.length !== 1 || usesOc[0]!.targetResourceId !== focusOcResourceId) {
      return blocked("GROWTH_LONGFORM_PERSONAL_STORY_RELATIONS_INVALID");
    }

    const creativeDocuments = new CreativeDocumentRepository(this.workspace).listAtCheckpoint(checkpointId, personalStory.id);
    const outlines = creativeDocuments.filter((document) => document.kind === "writing_constraints");
    if (outlines.length === 0) return blocked("GROWTH_LONGFORM_OUTLINE_DOCUMENT_MISSING");
    if (outlines.length !== 1) return blocked("GROWTH_LONGFORM_OUTLINE_DOCUMENT_AMBIGUOUS");
    const documents = new DocumentRepository(this.workspace);
    const outlineRecord = outlines[0]!;
    const outlineVersion = documents.getStableForCreativeDocumentAtCheckpoint(outlineRecord.id, checkpointId);
    if (!outlineVersion) return blocked("GROWTH_LONGFORM_OUTLINE_VERSION_MISSING");
    if (!bindings[0]!.sources.some((source) => source.kind === "document_version" && source.ref === outlineVersion.id)) {
      return blocked("GROWTH_LONGFORM_PERSONAL_STORY_BINDING_SOURCE_INVALID");
    }

    const outline = parseOutline(outlineVersion.content);
    if (!outline) return blocked("GROWTH_LONGFORM_OUTLINE_INVALID");
    if (deriveGrowthLongformOutlineDocumentId(personalStory.id, outline.outlineId) !== outlineRecord.id) {
      return blocked("GROWTH_LONGFORM_OUTLINE_IDENTITY_MISMATCH");
    }

    const completedSections: GrowthLongformCompletedSection[] = [];
    let nextSection: GrowthLongformPendingSection | null = null;
    let missingPredecessor = false;
    for (const section of outline.sections) {
      const documentId = deriveGrowthLongformSectionDocumentId(personalStory.id, outline.outlineId, section.localId);
      const record = creativeDocuments.find((document) => document.id === documentId);
      if (!record) {
        nextSection ??= pendingSection(section, documentId);
        missingPredecessor = true;
        continue;
      }
      if (record.resourceId !== personalStory.id || record.kind !== "prose") {
        return blocked("GROWTH_LONGFORM_SECTION_DOCUMENT_INVALID");
      }
      const version = documents.getStableForCreativeDocumentAtCheckpoint(documentId, checkpointId);
      if (!version) {
        nextSection ??= pendingSection(section, documentId);
        missingPredecessor = true;
        continue;
      }
      if (missingPredecessor) return blocked("GROWTH_LONGFORM_SECTION_ORDER_INVALID");
      completedSections.push({
        outlineSectionId: section.localId,
        documentId,
        documentVersionId: version.id,
        contentSha256: version.contentHash,
        evidenceId: version.id,
      });
    }

    return {
      status: "ready",
      checkpointId,
      mainStoryResourceId: mainStories[0]!.id,
      worldResourceId: worlds[0]!.id,
      focusOcResourceId,
      personalStoryResourceId: personalStory.id,
      outline: {
        outlineId: outline.outlineId,
        documentId: outlineRecord.id,
        documentVersionId: outlineVersion.id,
        contentSha256: outlineVersion.contentHash,
        storyTitle: outline.storyTitle,
        summary: outline.summary,
        sections: outline.sections,
      },
      completedSections,
      nextSection,
      complete: nextSection === null,
    };
  }
}

function parseOutline(content: string): PersistedOutline | null {
  try {
    const parsed: unknown = JSON.parse(content);
    const result = growthLongformPersistedOutlineSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function pendingSection(section: PersistedOutline["sections"][number], documentId: string): GrowthLongformPendingSection {
  return {
    outlineSectionId: section.localId,
    documentId,
    title: section.title,
    objective: section.objective,
    evidenceIds: [...section.evidenceIds],
    continuityConstraints: [...section.continuityConstraints],
    estimatedCodePoints: { ...section.estimatedCodePoints },
  };
}

function normalizeIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 240 ? normalized : null;
}

function progressError(code: "GROWTH_LONGFORM_PROGRESS_INPUT_INVALID"): Error & { code: string } {
  return Object.assign(new Error("Growth Longform progress input is invalid."), { code });
}
