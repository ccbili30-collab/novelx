import { z } from "zod";
import { decomposerOutputSchema } from "./decomposerContracts";
import { providerRuntimeProfileSchema } from "./providerContract";

const id = z.string().trim().min(1).max(240);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const decomposerWorkerStartSchema = z.object({
  type: z.literal("decompose.start"), runId: id, sourceId: id,
  chunks: z.array(z.object({ id, locator: z.record(z.string(), z.json()), content: z.string().max(500_000), contentSha256: sha256 }).strict()).min(1).max(10_000),
  providerProfile: providerRuntimeProfileSchema,
}).strict();
const receiptSchema = z.object({
  actualProviderId: z.string().nullable(), actualModelId: z.string().nullable(), responseIdSha256: sha256.nullable(),
  inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable(), totalTokens: z.number().int().nonnegative().nullable(),
  contextPolicyVersion: z.string().nullable(), maxChargedInputBytes: z.number().int().nonnegative().nullable(), configuredContextWindow: z.number().int().positive().nullable(),
  safetyReserve: z.number().int().nonnegative().nullable(), outputReserve: z.number().int().nonnegative().nullable(), correctionAttempts: z.number().int().nonnegative(),
}).strict();
export const decomposerWorkerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("decompose.started"), runId: id }).strict(),
  z.object({ type: z.literal("decompose.completed"), runId: id, output: decomposerOutputSchema, receipt: receiptSchema }).strict(),
  z.object({ type: z.literal("decompose.failed"), runId: id, error: z.object({ code: z.string().min(1).max(120), message: z.string().min(1).max(240) }).strict() }).strict(),
]);
export type DecomposerWorkerStart = z.infer<typeof decomposerWorkerStartSchema>;
export type DecomposerWorkerEvent = z.infer<typeof decomposerWorkerEventSchema>;
