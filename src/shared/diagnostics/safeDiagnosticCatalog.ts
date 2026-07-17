import { z } from "zod";
import {
  safeDiagnosticBoundarySchema,
  safeDiagnosticOwnerSchema,
  safeDiagnosticRetryabilitySchema,
} from "./safeDiagnosticContract";

const catalogKeySchema = z.string().regex(/^[a-z][a-z0-9_.-]{2,159}$/);

export const safeDiagnosticDefinitionSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,119}$/),
  owner: safeDiagnosticOwnerSchema,
  boundary: safeDiagnosticBoundarySchema,
  defaultRetryability: safeDiagnosticRetryabilitySchema,
  userSummaryKey: catalogKeySchema,
  modelCorrectionKey: catalogKeySchema.nullable(),
}).strict();

export type SafeDiagnosticDefinition = z.infer<typeof safeDiagnosticDefinitionSchema>;

export interface SafeDiagnosticCatalog {
  readonly codes: readonly string[];
  get(code: string): SafeDiagnosticDefinition | undefined;
  has(code: string): boolean;
}

export function createSafeDiagnosticCatalog(input: readonly SafeDiagnosticDefinition[]): SafeDiagnosticCatalog {
  const definitions = input.map((value) => Object.freeze(safeDiagnosticDefinitionSchema.parse(value)));
  const byCode = new Map<string, SafeDiagnosticDefinition>();
  for (const definition of definitions) {
    if (byCode.has(definition.code)) throw catalogError("SAFE_DIAGNOSTIC_CATALOG_DUPLICATE_CODE");
    byCode.set(definition.code, definition);
  }
  const codes = Object.freeze([...byCode.keys()].sort());
  return Object.freeze({
    codes,
    get: (code: string) => byCode.get(code),
    has: (code: string) => byCode.has(code),
  });
}

function catalogError(code: "SAFE_DIAGNOSTIC_CATALOG_DUPLICATE_CODE"): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
