export function largeWorldFragmentFixture() {
  const sourceDocumentRefs = ["setting"];
  return {
    summary: "Create a source-bound large world.",
    world: { localId: "world", title: "Tide World" },
    entities: [
      { localId: "north", kind: "location" as const, title: "North", scaleRole: "macro_region" as const, sourceDocumentRefs },
      { localId: "south", kind: "location" as const, title: "South", scaleRole: "macro_region" as const, sourceDocumentRefs },
      { localId: "isles", kind: "location" as const, title: "Isles", scaleRole: "macro_region" as const, sourceDocumentRefs },
      { localId: "mountains", kind: "location" as const, title: "Mountains", scaleRole: "mountain_system" as const, sourceDocumentRefs },
      { localId: "sea", kind: "location" as const, title: "Sea", scaleRole: "sea" as const, sourceDocumentRefs },
      { localId: "river", kind: "location" as const, title: "River", scaleRole: "river" as const, sourceDocumentRefs },
      { localId: "road", kind: "location" as const, title: "Road", scaleRole: "transport_network" as const, sourceDocumentRefs },
      { localId: "ore", kind: "location" as const, title: "Ore Belt", scaleRole: "resource_distribution" as const, sourceDocumentRefs },
      { localId: "north_crown", kind: "faction" as const, title: "North Crown", scaleRole: "polity" as const, macroRegionRef: "north", sourceDocumentRefs },
      { localId: "north_clans", kind: "faction" as const, title: "North Clans", scaleRole: "civilization_group" as const, macroRegionRef: "north", sourceDocumentRefs },
      { localId: "south_league", kind: "faction" as const, title: "South League", scaleRole: "polity" as const, macroRegionRef: "south", sourceDocumentRefs },
      { localId: "isle_people", kind: "faction" as const, title: "Isle People", scaleRole: "civilization_group" as const, macroRegionRef: "isles", sourceDocumentRefs },
    ],
    documents: [{
      localId: "setting", ownerRef: "world", kind: "setting" as const, title: "Setting",
      content: "The tide governs a large world of three regions, mountain watersheds, open seas, long rivers, trade roads, mineral belts, rival societies, historical eras, and interacting systems. Every claim is preserved in the setting record so later assertions and causal mechanisms remain source-bound across revisions and stories.",
    }],
    assertions: [
      { localId: "tide", scopeRef: "world", subject: "tide", predicate: "governs", object: { target: "trade" }, sourceDocumentRefs },
      { localId: "trade", scopeRef: "world", subject: "trade", predicate: "supports", object: { target: "polities" }, sourceDocumentRefs },
      { localId: "polity", scopeRef: "world", subject: "polities", predicate: "shape", object: { target: "culture" }, sourceDocumentRefs },
    ],
    eras: ["dawn", "sail", "crown", "present"].map((localId) => ({ localId, title: localId, summary: `${localId} era`, sourceDocumentRefs })),
    historicalTurningPoints: ["flood", "war", "treaty"].map((localId) => ({ localId, title: localId, summary: `${localId} changed the world`, sourceDocumentRefs })),
    causalMechanisms: [
      causal("tide_trade", "tide", "trade", ["geography", "economy"]),
      causal("trade_polity", "trade", "polity", ["economy", "polity"]),
      causal("polity_tide", "polity", "tide", ["culture", "geography"]),
      causal("trade_tide", "trade", "tide", ["technology", "geography"]),
    ],
    relations: [{ localId: "world_north", sourceRef: "world", targetRef: "north" }],
  };
}

function causal(localId: string, causeAssertionRef: string, effectAssertionRef: string, systemRefs: string[]) {
  return {
    localId, causeAssertionRef, effectAssertionRef, systemRefs, relationKind: "causes" as const,
    mechanism: `${localId} source-bound mechanism`, conditions: ["documented conditions"], temporalScope: "documented eras",
    polarityStrengthSummary: "positive, bounded strength", epistemicStatus: "confirmed" as const,
    sourceDocumentRefs: ["setting"],
  };
}
