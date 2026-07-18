import type { WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

/** Removes schema v23+ additive tables from a current workspace before testing a pre-v23 migration. */
export function removePostV22GrowthSchema(db: WorkspaceDatabase["db"]): void {
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND (name LIKE 'growth_%' OR name LIKE 'causal_relation%')
    ORDER BY name DESC
  `).all() as Array<{ name: string }>;
  if (tables.some(({ name }) => !/^(growth_|causal_relation)[a-z0-9_]+$/.test(name))) {
    throw new Error("Legacy workspace fixture found an unsafe post-v22 table name.");
  }
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    for (const { name } of tables) db.exec(`DROP TABLE "${name}"`);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
