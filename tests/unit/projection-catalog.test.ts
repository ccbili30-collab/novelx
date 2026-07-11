import { describe, expect, it } from "vitest";
import { getProjectionCapability, listProjectionCapabilities } from "../../src/domain/projection/projectionCatalog";

describe("projection catalog", () => {
  it("does not report planned memory projections as implemented", () => {
    expect(listProjectionCapabilities()).toEqual([
      expect.objectContaining({ kind: "semantic_graph", status: "implemented", canonical: false, rebuildable: true }),
      expect.objectContaining({ kind: "timeline", status: "implemented" }),
      expect.objectContaining({ kind: "retrieval", status: "implemented" }),
      expect.objectContaining({ kind: "summary", status: "implemented" }),
      expect.objectContaining({ kind: "character_knowledge", status: "implemented" }),
    ]);
    expect(getProjectionCapability("unknown")).toBeNull();
  });
});
