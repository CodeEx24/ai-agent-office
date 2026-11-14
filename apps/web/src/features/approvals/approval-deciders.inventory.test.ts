// AGO-58: inventory of every approval-deciding entry point in apps/web. A new one must be added here on purpose, and it
// must call the human-only guard first, or this test fails. (Worker paths and SQL functions are covered by the
// AGO-51 scanner in apps/worker/src/approvals/no-auto-approve.test.ts; docs/features/approvals.md lists all of them.)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

// Vitest runs from the apps/web package directory (pnpm and turbo both set it).
const SRC = join(process.cwd(), "src");
const toPosix = (full: string): string => relative(SRC, full).split(sep).join("/");

/** The only file in apps/web that writes the `approvals` table. */
const DECIDER_FILES = ["features/approvals/decide-approval.ts"];
/** Every route handler under /api/approvals: all human-only. */
const APPROVAL_ROUTES = ["app/api/approvals/[id]/decision/route.ts"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "node_modules" ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry) ? [full] : [];
  });
}

const FILES = sourceFiles(SRC).map((full) => ({
  path: toPosix(full),
  text: readFileSync(full, "utf8"),
}));

const WRITES_APPROVALS =
  /from\(\s*["']approvals["']\s*\)[\s\S]{0,400}?\.(update|upsert|insert|delete)\(/;
// Any call into the database that could decide an approval by another name.
const APPROVAL_RPC = /\.rpc\(\s*["'][a-z_]*approv[a-z_]*["']/;

describe("approval-deciding entry points in apps/web", () => {
  it("only the listed file writes the approvals table", () => {
    const writers = FILES.filter((f) => WRITES_APPROVALS.test(f.text)).map((f) => f.path);
    expect(writers.sort()).toEqual([...DECIDER_FILES].sort());
  });

  it("no code calls a database function that decides an approval", () => {
    // The rejection recorder calls `record_agent_approval_rejection`, which only appends an audit event.
    const callers = FILES.filter(
      (f) => APPROVAL_RPC.test(f.text) && !f.text.includes('"record_agent_approval_rejection"'),
    ).map((f) => f.path);
    expect(callers).toEqual([]);
  });

  it("every route under /api/approvals is listed, and refuses an agent credential before anything else", () => {
    const routes = FILES.filter((f) => /^app\/api\/approvals\/.*route\.ts$/.test(f.path));
    expect(routes.map((r) => r.path).sort()).toEqual([...APPROVAL_ROUTES].sort());
    for (const route of routes) {
      const guard = route.text.indexOf("rejectAgentCredential(request)");
      expect(guard, `${route.path} must call rejectAgentCredential(request)`).toBeGreaterThan(-1);
      for (const later of ["parseInput(", "request.json(", "decideApproval("]) {
        const at = route.text.indexOf(later);
        if (at !== -1) expect(guard, `${route.path}: guard before ${later}`).toBeLessThan(at);
      }
    }
  });

  it("the decide function is reachable only from the human-only route", () => {
    const importers = FILES.filter(
      (f) => f.path !== DECIDER_FILES[0] && /decide-approval["']/.test(f.text),
    ).map((f) => f.path);
    expect(importers).toEqual(APPROVAL_ROUTES);
  });

  it("no server action touches approvals: a 'use server' file would need requireHumanRequest first", () => {
    const actions = FILES.filter(
      (f) => /^\s*["']use server["']/m.test(f.text) && /approval/i.test(f.text),
    );
    for (const action of actions) {
      expect(action.text, `${action.path} must call requireHumanRequest`).toContain(
        "requireHumanRequest",
      );
    }
  });

  it("the proxy refuses agent credentials and records the rejection on approval paths", () => {
    const proxy = FILES.find((f) => f.path === "proxy.ts")?.text ?? "";
    expect(proxy).toContain("rejectAgentCredential(request)");
    expect(proxy).toContain("isApprovalRoute(");
    expect(proxy).toContain("recordAgentRouteRejection(");
  });

  it("only the server-only recorder reads SUPABASE_SERVICE_ROLE_KEY in apps/web", () => {
    // The service key bypasses RLS. AGO-58 confines it to one server-only module making one narrow RPC call.
    const readers = FILES.filter((f) => f.text.includes("SUPABASE_SERVICE_ROLE_KEY")).map(
      (f) => f.path,
    );
    expect(readers).toEqual(["features/approvals/record-agent-rejection.ts"]);
  });
});
