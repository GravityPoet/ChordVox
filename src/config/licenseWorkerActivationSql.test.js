import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("license worker activation SQL", () => {
  it("uses a single conditional insert instead of a separate count-then-insert race", () => {
    const source = fs.readFileSync(
      path.join(repoRoot, "services/license-worker/src/index.ts"),
      "utf8"
    );
    const [, sqlSource = ""] =
      source.match(/export const INSERT_ACTIVATION_IF_SLOT_AVAILABLE_SQL =([\s\S]*?);/) || [];
    const normalizedSqlSource = sqlSource.replace(/\s+/g, " ").trim();

    expect(normalizedSqlSource).toContain("INSERT OR IGNORE INTO activations");
    expect(normalizedSqlSource).toContain("SELECT ?, ?, ?, ?, ?, ?, ?");
    expect(normalizedSqlSource).toContain(
      "WHERE NOT EXISTS (SELECT 1 FROM activations WHERE license_id = ? AND machine_id = ?)"
    );
    expect(normalizedSqlSource).toContain(
      "AND (SELECT COUNT(*) FROM activations WHERE license_id = ?) < ?"
    );
    expect(normalizedSqlSource).not.toMatch(/VALUES/i);
    expect(source).not.toContain("async function activationCount");
    expect(source).toContain("resultChanges(insertResult) <= 0");
    expect(source).toContain("const racedExisting = await loadExistingActivation");
  });
});
