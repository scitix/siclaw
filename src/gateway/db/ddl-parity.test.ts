/**
 * DDL Parity Check — ensures schema-sqlite.ts and migrate-sqlite.ts define the same tables.
 *
 * schema-sqlite.ts is the Drizzle ORM schema (runtime type-safe queries).
 * migrate-sqlite.ts is the raw DDL used for CREATE TABLE IF NOT EXISTS on startup.
 * They must define the exact same set of tables, otherwise:
 * - A table in schema but not in DDL → runtime queries fail on fresh DBs
 * - A table in DDL but not in schema → table exists but is invisible to Drizzle
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

function extractSchemaTableNames(): string[] {
  const content = fs.readFileSync(
    path.join(import.meta.dirname, "schema-sqlite.ts"),
    "utf-8",
  );
  const matches = content.matchAll(/sqliteTable\("([^"]+)"/g);
  return [...matches].map((m) => m[1]).sort();
}

function extractDdlTableNames(): string[] {
  const content = fs.readFileSync(
    path.join(import.meta.dirname, "migrate-sqlite.ts"),
    "utf-8",
  );
  // Only match tables in the DDL_STATEMENTS array (not in migration code)
  const ddlSection = content.split("const DDL_STATEMENTS")[1]?.split("];")[0];
  if (!ddlSection) throw new Error("Could not find DDL_STATEMENTS array");
  const matches = ddlSection.matchAll(
    /CREATE TABLE IF NOT EXISTS (\w+)/g,
  );
  return [...matches].map((m) => m[1]).sort();
}

describe("DDL parity: schema-sqlite.ts ↔ migrate-sqlite.ts", () => {
  const schemaTables = extractSchemaTableNames();
  const ddlTables = extractDdlTableNames();

  it("schema and DDL define the same set of tables", () => {
    const inSchemaOnly = schemaTables.filter((t) => !ddlTables.includes(t));
    const inDdlOnly = ddlTables.filter((t) => !schemaTables.includes(t));

    const errors: string[] = [];
    if (inSchemaOnly.length > 0) {
      errors.push(
        `Tables in schema-sqlite.ts but missing from migrate-sqlite.ts DDL_STATEMENTS:\n  ${inSchemaOnly.join(", ")}`,
      );
    }
    if (inDdlOnly.length > 0) {
      errors.push(
        `Tables in migrate-sqlite.ts DDL_STATEMENTS but missing from schema-sqlite.ts:\n  ${inDdlOnly.join(", ")}`,
      );
    }

    expect(errors, errors.join("\n\n")).toHaveLength(0);
  });

  it("schema defines at least one table", () => {
    expect(schemaTables.length).toBeGreaterThan(0);
  });

  it("DDL defines at least one table", () => {
    expect(ddlTables.length).toBeGreaterThan(0);
  });
});
