// AGO-150 (gate r1): browser code must not pull the env module into the client bundle. The root `@ago/shared`
// barrel exports the server env schema, so client-reachable office modules import values from `@ago/shared/office`.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const OFFICE_DIR = join(__dirname, "..");
const BROWSER_FILE = join(__dirname, "../../../lib/supabase/browser.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Import statements that load the root barrel at runtime (type-only imports are erased and are fine). */
function valueImportsOfRootBarrel(source: string): string[] {
  const statements = source.match(/^import\s[^;]*?from\s+"@ago\/shared";/gms) ?? [];
  return statements.filter((statement) => !/^import\s+type\s/.test(statement));
}

describe("client-reachable office modules", () => {
  it("never import values from the root @ago/shared barrel (it carries the server env names)", () => {
    const offenders = [...sourceFiles(OFFICE_DIR), BROWSER_FILE].filter(
      (file) => valueImportsOfRootBarrel(readFileSync(file, "utf8")).length > 0,
    );
    expect(offenders).toEqual([]);
  });

  it("never import the env modules or server-only code", () => {
    for (const file of [...sourceFiles(OFFICE_DIR), BROWSER_FILE]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/from\s+"[^"]*\/lib\/env"/);
      expect(source, file).not.toMatch(/@ago\/shared\/client-env/);
      expect(source, file).not.toMatch(/process\.env/);
    }
  });
});
