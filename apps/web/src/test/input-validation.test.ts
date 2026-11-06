import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// AGO-66 AC1 "every route validates input with Zod". This is a static, lint-style check: it reads
// the source (importing it would pull in `server-only`) and fails when a route handler, server
// action or page that reads request input does not go through `parseInput`, unless the function
// documents `@no-input` with a reason. New routes and actions are picked up automatically.

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

const files = walk(SRC).map((path) => ({
  name: relative(SRC, path).replaceAll("\\", "/"),
  text: readFileSync(path, "utf8"),
}));

interface Handler {
  file: string;
  name: string;
  body: string;
  /** Source from the previous export up to this one, so a leading JSDoc is included. */
  leading: string;
}

/** Exported functions of a file with their bodies (up to the next top-level export). */
function exportedFunctions(file: { name: string; text: string }): Handler[] {
  const starts = [...file.text.matchAll(/^export (?:async )?function (\w+)/gm)];
  return starts.map((match, index) => {
    const start = match.index;
    const end = starts[index + 1]?.index ?? file.text.length;
    const before = index === 0 ? 0 : (starts[index - 1]?.index ?? 0);
    return {
      file: file.name,
      name: match[1] ?? "",
      body: file.text.slice(start, end),
      leading: file.text.slice(before, start),
    };
  });
}

function skipsValidation(handler: Handler): boolean {
  return !handler.body.includes("parseInput(") && !handler.leading.includes("@no-input");
}

describe("input validation coverage (AGO-66)", () => {
  const routeFiles = files.filter((f) => /(^|\/)route\.ts$/.test(f.name));
  const actionFiles = files.filter((f) => /^\s*["']use server["']/.test(f.text));
  const pageFiles = files.filter(
    (f) => /(^|\/)page\.tsx$/.test(f.name) && /searchParams|params\b/.test(f.text),
  );

  it("finds the known entry points (guards against the scan silently matching nothing)", () => {
    expect(routeFiles.map((f) => f.name)).toContain("app/auth/callback/route.ts");
    expect(actionFiles.map((f) => f.name)).toEqual(
      expect.arrayContaining(["features/auth/actions.ts", "features/workspaces/actions.ts"]),
    );
    expect(pageFiles.map((f) => f.name)).toContain("app/sign-in/page.tsx");
  });

  it("every route handler parses its input with parseInput", () => {
    const missing = routeFiles
      .flatMap(exportedFunctions)
      .filter((handler) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(handler.name))
      .filter(skipsValidation)
      .map((handler) => `${handler.file}: ${handler.name}`);

    expect(missing, "route handlers without parseInput() or @no-input").toEqual([]);
  });

  it("every exported server action parses its input with parseInput", () => {
    const missing = actionFiles
      .flatMap(exportedFunctions)
      .filter(skipsValidation)
      .map((handler) => `${handler.file}: ${handler.name}`);

    expect(missing, "server actions without parseInput() or @no-input").toEqual([]);
  });

  it("every page that reads searchParams or params parses them with parseInput", () => {
    const missing = pageFiles
      .filter((f) => !f.text.includes("parseInput(") && !f.text.includes("@no-input"))
      .map((f) => f.name);

    expect(missing, "pages reading request input without parseInput() or @no-input").toEqual([]);
  });

  it("the scan itself detects a handler that skips validation", () => {
    const handlers = exportedFunctions({
      name: "fake/route.ts",
      text: "export async function GET() {\n  return Response.json({});\n}\n",
    });

    expect(handlers.filter(skipsValidation)).toHaveLength(1);
  });
});
