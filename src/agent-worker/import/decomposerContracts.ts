import { z } from "zod";

const id = z.string().trim().min(1).max(240);
const sourceFields = {
  sourceChunkIds: z.array(id).min(1).max(100),
  confidence: z.number().min(0).max(1),
};

const candidateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("character"), ...sourceFields, payload: z.object({ name: z.string().trim().min(1).max(500), summary: z.string().trim().min(1).max(8_000) }).strict() }).strict(),
  z.object({ kind: z.literal("world_rule"), ...sourceFields, payload: z.object({ subject: z.string().trim().min(1).max(500), predicate: z.string().trim().min(1).max(240), value: z.string().trim().min(1).max(8_000) }).strict() }).strict(),
  z.object({ kind: z.literal("location"), ...sourceFields, payload: z.object({ name: z.string().trim().min(1).max(500), description: z.string().trim().min(1).max(8_000) }).strict() }).strict(),
  z.object({ kind: z.literal("faction"), ...sourceFields, payload: z.object({ name: z.string().trim().min(1).max(500), description: z.string().trim().min(1).max(8_000) }).strict() }).strict(),
  z.object({ kind: z.literal("event"), ...sourceFields, payload: z.object({ subject: z.string().trim().min(1).max(500), description: z.string().trim().min(1).max(8_000), temporal: z.object({ kind: z.enum(["instant", "range", "sequence"]), value: z.string().max(500).optional(), start: z.string().max(500).optional(), end: z.string().max(500).optional(), order: z.number().int().optional() }).strict().nullable() }).strict() }).strict(),
  z.object({ kind: z.literal("style"), ...sourceFields, payload: z.object({ description: z.string().trim().min(1).max(8_000) }).strict() }).strict(),
  z.object({ kind: z.literal("ambiguity"), ...sourceFields, payload: z.object({ question: z.string().trim().min(1).max(4_000), alternatives: z.array(z.string().trim().min(1).max(2_000)).min(2).max(20) }).strict() }).strict(),
]);

export const decomposerOutputSchema = z.object({
  candidates: z.array(candidateSchema).max(1_000),
  unresolvedSourceChunkIds: z.array(id).max(10_000),
}).strict();

export type DecompositionCandidateInput = z.infer<typeof candidateSchema>;
export type DecomposerOutput = z.infer<typeof decomposerOutputSchema>;
