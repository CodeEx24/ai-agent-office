import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * AGO-23: "wrapped content is labeled in every prompt" is only provable if there is ONE path from
 * content to a model request. This test walks the worker's source and fails when a second path
 * appears: a new caller of the model, a new place that builds `<untrusted_data>` tags, or a model
 * request built by hand instead of from the context builder's output. If it fails, route the new code
 * through `ContextBuilder.build` and `wrapUntrusted`, then (only if that is truly impossible) add the
 * file here with a comment saying why, and cover it with an invariant test like untrusted-invariant.test.ts.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "__fixtures__") {
        files.push(...sourceFiles(path));
      }
    } else if (
      entry.name.endsWith(".ts") &&
      !/\.(test|qa|acceptance|integration|e2e|drill)\.ts$/.test(entry.name) &&
      !entry.name.endsWith(".test-helpers.ts")
    ) {
      files.push(path);
    }
  }
  return files;
}

const FILES = sourceFiles(SRC).map((path) => ({
  rel: relative(SRC, path).split(sep).join("/"),
  text: readFileSync(path, "utf8"),
}));

const filesMatching = (pattern: RegExp): string[] =>
  FILES.filter((file) => pattern.test(file.text)).map((file) => file.rel);

describe("AGO-23: one path from content to a model prompt", () => {
  it("finds the worker source (the walk is not vacuous)", () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.map((f) => f.rel)).toContain("context/context-builder.ts");
  });

  it("only the tool loop calls a model, and only the Claude provider talks to the model API", () => {
    expect(filesMatching(/\bprovider\.complete\(/)).toEqual(["agent/agent-loop.ts"]);
    expect(filesMatching(/api\.anthropic\.com|x-api-key|ANTHROPIC_MESSAGES_URL/)).toEqual([
      "agent/claude-provider.ts",
    ]);
  });

  it("the tool loop sends exactly what the context builder returned, and builds no prompt text itself", () => {
    const loop = FILES.find((f) => f.rel === "agent/agent-loop.ts")?.text ?? "";
    const call = /provider\.complete\(\{([\s\S]*?)\}\)/.exec(loop)?.[1] ?? "";
    expect(call).toMatch(/system:\s*built\.system/);
    expect(call).toMatch(/messages:\s*built\.messages/);
    // The only request built from the builder's output; no second `messages:` literal anywhere else.
    expect(loop.match(/\bmessages\s*:/g)?.length).toBe(1);
    expect(loop).not.toMatch(/role:\s*"user"/);
  });

  it("only the context builder renders retrieved text into a prompt", () => {
    expect(filesMatching(/\bwrapUntrusted\(/).sort()).toEqual(
      ["context/context-builder.ts", "context/untrusted.ts"].sort(),
    );
  });

  it("only untrusted.ts builds the data tags", () => {
    expect(filesMatching(/untrusted_data|UNTRUSTED_TAG/)).toEqual(["context/untrusted.ts"]);
  });
});
