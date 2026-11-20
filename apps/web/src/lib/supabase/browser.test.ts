import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createSupabaseBrowserClient } from "./browser";

// AGO-150: the browser client is built from public settings only and never reads the environment.
describe("createSupabaseBrowserClient", () => {
  it("builds a client from the public URL and anon key it is given", () => {
    const client = createSupabaseBrowserClient("http://127.0.0.1:44321", "anon-key-for-test");
    expect(typeof client.from).toBe("function");
  });

  it("never reads process.env or a service-role key (import guard)", () => {
    const source = readFileSync(join(__dirname, "browser.ts"), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
      .join("\n");
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toMatch(/import\.meta\.env/);
    expect(code.toLowerCase()).not.toMatch(/service[_-]?role/);
    expect(code).not.toMatch(/server-only|next\/headers/);
  });
});
