import { z } from "zod";
import { providerRuntimeProfileSchema } from "./providerContract";

const id = z.string().trim().min(1).max(240);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

const gmConsequenceSchema = z.object({
  category: z.enum(["success", "failure", "damage", "reward", "clue", "npc_decision", "state_change"]),
  description: z.string().trim().min(1).max(2_000),
  targetId: id.nullable(),
  numericDelta: z.number().finite().nullable(),
}).strict();

export const resolvedGmTurnSchema = z.object({
  status: z.literal("resolved"),
  resolutionId: id,
  evidenceIds: z.array(id).min(1).max(200),
  outcome: z.string().trim().min(1).max(4_000),
  consequences: z.array(gmConsequenceSchema).max(100),
  stateDelta: z.record(z.string().min(1).max(240), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  narrativeFacts: z.array(z.string().trim().min(1).max(2_000)).max(100),
}).strict();

const blockedGmTurnSchema = z.object({
  status: z.literal("blocked"),
  reasons: z.array(z.object({
    code: z.enum(["missing_source", "conflicting_sources", "insufficient_input", "authority_violation"]),
    message: z.string().trim().min(1).max(1_000),
    evidenceIds: z.array(id).max(100),
  }).strict()).min(1).max(20),
}).strict();

export const gmTurnOutputSchema = z.discriminatedUnion("status", [resolvedGmTurnSchema, blockedGmTurnSchema]);

export const playerWorkerTurnStartCommandSchema = z.object({
  type: z.literal("play.start"),
  runId: id,
  playthroughId: id,
  playerAction: z.string().trim().min(1).max(12_000),
  evidence: z.array(z.object({
    id,
    content: z.string().min(1).max(100_000),
    sha256,
  }).strict()).min(1).max(200),
  currentState: z.record(z.string().min(1).max(240), z.json()),
  recentMemory: z.string().max(100_000),
  luck: z.number().min(0).max(1),
  styleConstraints: z.array(z.string().trim().min(1).max(2_000)).max(100),
  providerProfile: providerRuntimeProfileSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (new Set(value.evidence.map((item) => item.id)).size !== value.evidence.length) {
    context.addIssue({ code: "custom", message: "Player evidence ids must be unique." });
  }
  if (value.evidence.reduce((total, item) => total + item.content.length, 0) > 500_000) {
    context.addIssue({ code: "custom", message: "Player evidence packet is too large." });
  }
});

export const playerWorkerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("play.started"), runId: id }).strict(),
  z.object({
    type: z.literal("play.completed"),
    runId: id,
    result: z.object({
      gmResolution: resolvedGmTurnSchema,
      writerText: z.string().trim().min(1).max(100_000),
      evidenceIds: z.array(id).min(1).max(200),
      stateSnapshot: z.record(z.string().min(1).max(240), z.json()),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("play.failed"),
    runId: id,
    error: z.object({ code: z.string().min(1).max(120), message: z.string().min(1).max(240) }).strict(),
  }).strict(),
]);

export type GmTurnOutput = z.infer<typeof gmTurnOutputSchema>;
export type ResolvedGmTurn = z.infer<typeof resolvedGmTurnSchema>;
export type PlayerWorkerTurnStartCommand = z.infer<typeof playerWorkerTurnStartCommandSchema>;
export type PlayerWorkerEvent = z.infer<typeof playerWorkerEventSchema>;
