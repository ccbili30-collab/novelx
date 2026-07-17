import { createSafeDiagnosticCatalog } from "../../../../shared/diagnostics/safeDiagnosticCatalog";

export const growthRevisionDiagnosticCatalog = createSafeDiagnosticCatalog([
  revisionDefinition("GROWTH_REVISION_FRAGMENT_INVALID", "fragment_invalid"),
  revisionDefinition("GROWTH_REVISION_FRAGMENT_DUPLICATE_LOCAL_ID", "duplicate_local_id"),
  revisionDefinition("GROWTH_REVISION_FRAGMENT_DUPLICATE_TARGET", "duplicate_target"),
  revisionDefinition("GROWTH_REVISION_FRAGMENT_AUTHORITY_INVALID", "authority_invalid"),
  revisionDefinition("GROWTH_REVISION_FRAGMENT_IMPACT_MISMATCH", "impact_mismatch"),
  revisionDefinition("GROWTH_REVISION_FRAGMENT_REFERENCE_INVALID", "reference_invalid"),
  revisionDefinition("GROWTH_REVISION_FRAGMENT_OWNER_REF_INVALID", "owner_ref_invalid"),
  revisionDefinition("GROWTH_REVISION_FRAGMENT_DOCUMENT_OWNER_KIND_INVALID", "document_owner_kind_invalid"),
  revisionDefinition("GROWTH_REVISION_FRAGMENT_SCOPE_REF_INVALID", "scope_ref_invalid"),
  revisionDefinition("GROWTH_REVISION_FRAGMENT_DOCUMENT_SOURCE_REF_INVALID", "document_source_ref_invalid"),
  revisionDefinition("GROWTH_REVISION_FRAGMENT_RELATION_ENDPOINT_REF_INVALID", "relation_endpoint_ref_invalid"),
  revisionDefinition("GROWTH_REVISION_FRAGMENT_PARENT_REF_INVALID", "parent_ref_invalid"),
  revisionDefinition("GROWTH_REVISION_FRAGMENT_REFERENCE_CYCLE", "reference_cycle"),
  revisionDefinition("GROWTH_REVISION_FRAGMENT_RELATION_INVALID", "relation_invalid"),
]);

function revisionDefinition(code: string, key: string) {
  return {
    code,
    owner: "growth_phase" as const,
    boundary: "phase_compile" as const,
    defaultRetryability: "model_correction" as const,
    userSummaryKey: `growth.revision.${key}`,
    modelCorrectionKey: `growth.revision.correct_${key}`,
  };
}
