import type { CheckerOutput, WriterOutput } from "../contracts/roleOutputs";
import type { GmTurnOutput } from "./gmTurnContracts";

export interface AcceptedTurnPipeline {
  gmResolution: Extract<GmTurnOutput, { status: "resolved" }>;
  writerText: string;
  evidenceIds: string[];
}

export function validateTurnPipeline(input: {
  gm: GmTurnOutput;
  writer: WriterOutput;
  checker: CheckerOutput;
}): AcceptedTurnPipeline {
  if (input.gm.status !== "resolved") throw validationError("GM_RESOLUTION_BLOCKED");
  if (input.writer.status !== "candidate") throw validationError("WRITER_TURN_BLOCKED");
  if (input.writer.gmResolutionId !== input.gm.resolutionId) throw validationError("WRITER_GM_RESOLUTION_MISMATCH");
  const gmEvidence = new Set(input.gm.evidenceIds);
  if (input.writer.evidenceIds.some((id) => !gmEvidence.has(id))) throw validationError("WRITER_EVIDENCE_MISMATCH");
  if (input.writer.authorityChanges.length !== 0) throw validationError("WRITER_AUTHORITY_VIOLATION");
  if (input.checker.status === "blocked") throw validationError("TURN_VALIDATION_BLOCKED");
  if (input.checker.status === "findings") {
    if (input.checker.findings.some((finding) => finding.severity === "major"
      || finding.category === "writer_authority"
      || finding.category === "hidden_fact_leak"
      || finding.category === "fact_conflict")) {
      throw validationError("TURN_VALIDATION_REJECTED");
    }
    throw validationError("TURN_VALIDATION_REVIEW_REQUIRED");
  }
  return {
    gmResolution: input.gm,
    writerText: input.writer.candidateText,
    evidenceIds: [...new Set(input.writer.evidenceIds)].sort(),
  };
}

function validationError(code: string): Error & { code: string } {
  return Object.assign(new Error("Turn validation failed."), { code });
}
