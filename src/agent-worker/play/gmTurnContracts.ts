import { Type } from "typebox";
export { gmTurnOutputSchema, type GmTurnOutput } from "../../shared/playerWorkerProtocol";

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
