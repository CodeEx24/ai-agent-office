import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * AGO-192 guard: the export path runs as the signed-in person, so row-level security and the member-role check
 * apply. No service-role key, admin client or `pg` connection may appear anywhere in it (loader, route, CLI).
 * This is a source scan: it fails the moment someone adds a shortcut around the person's own session.
 */

const FEATURE_DIR = import.meta.dirname;
const ROUTE_DIR = join(FEATURE_DIR, "..", "..", "app", "api", "agent-packs");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(
      (entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

const FILES = [...sourceFiles(FEATURE_DIR), ...sourceFiles(ROUTE_DIR)];

const FORBIDDEN: [RegExp, string][] = [
  [/service[_-]?role/i, "a service-role reference"],
  [/SUPABASE_SECRET|SUPABASE_SERVICE/i, "a Supabase secret key variable"],
  [/\b(createAdminClient|supabaseAdmin|adminClient)\b/i, "an admin client"],
  [/from\s+["'](pg|postgres|pg-boss)["']/, "a direct database driver"],
];

describe("agent pack export path", () => {
  it("scans the loader, the route and the CLI", () => {
    const names = FILES.map((file) => file.replaceAll("\\", "/"));
    expect(names.some((name) => name.endsWith("features/packs/export-agent-pack.ts"))).toBe(true);
    expect(names.some((name) => name.endsWith("features/packs/cli/run-pack-export.ts"))).toBe(true);
    expect(names.some((name) => name.endsWith("api/agent-packs/export/route.ts"))).toBe(true);
  });

  it.each(FORBIDDEN)("has no %s (%s)", (pattern) => {
    for (const file of FILES) {
      // Code only: the sources say in comments that there is no service-role path, which must not trip the scan.
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code, file).not.toMatch(pattern);
    }
  });

  it("gives the CLI the public anon key only", () => {
    const cli = readFileSync(join(FEATURE_DIR, "cli", "run-pack-export.ts"), "utf8");
    expect(cli).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  });
});
