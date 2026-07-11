import { z } from "zod";
import { Type } from "typebox";

const identifier = z.string().trim().min(1).max(240);
const reasonSchema = z.object({
  code: z.enum(["missing_source", "conflicting_sources", "insufficient_input", "authority_violation"]),
  message: z.string().trim().min(1).max(1_000),
  evidenceIds: z.array(identifier).max(100),
}).strict();

const consequenceSchema = z.object({
  category: z.enum(["success", "failure", "damage", "reward", "clue", "npc_decision", "state_change"]),
  description: z.string().trim().min(1).max(2_000),
  targetId: identifier.nullable(),
  numericDelta: z.number().finite().nullable(),
}).strict();

const resolvedSchema = z.object({
  status: z.literal("resolved"),
  resolutionId: identifier,
  evidenceIds: z.array(identifier).min(1).max(200),
  outcome: z.string().trim().min(1).max(4_000),
  consequences: z.array(consequenceSchema).max(100),
  stateDelta: z.record(z.string().min(1).max(240), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  narrativeFacts: z.array(z.string().trim().min(1).max(2_000)).max(100),
}).strict();

const blockedSchema = z.object({
  status: z.literal("blocked"),
  reasons: z.array(reasonSchema).min(1).max(20),
}).strict();

export const gmTurnOutputSchema = z.discriminatedUnion("status", [resolvedSchema, blockedSchema]);
export type GmTurnOutput = z.infer<typeof gmTurnOutputSchema>;

const idType = Type.String({ minLength: 1, maxLength: 240 });
export const gmTurnOutputParameters = Type.Object({
  status: Type.Union([Type.Literal("resolved"), Type.Literal("blocked")]),
  resolutionId: Type.Optional(idType),
  evidenceIds: Type.Optional(Type.Array(idType, { minItems: 1, maxItems: 200 })),
  outcome: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
  consequences: Type.Optional(Type.Array(Type.Object({
    category: Type.Union(["success", "failure", "damage", "reward", "clue", "npc_decision", "state_change"].map((value) => Type.Literal(value))),
    description: Type.String({ minLength: 1, maxLength: 2_000 }),
    targetId: Type.Union([idType, Type.Null()]),
    numericDelta: Type.Union([Type.Number(), Type.Null()]),
  }, { additionalProperties: false }), { maxItems: 100 })),
  stateDelta: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 240 }), Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]))),
  narrativeFacts: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 100 })),
  reasons: Type.Optional(Type.Array(Type.Object({
    code: Type.Union(["missing_source", "conflicting_sources", "insufficient_input", "authority_violation"].map((value) => Type.Literal(value))),
    message: Type.String({ minLength: 1, maxLength: 1_000 }),
    evidenceIds: Type.Array(idType, { maxItems: 100 }),
  }, { additionalProperties: false }), { maxItems: 20 })),
}, { additionalProperties: true });
