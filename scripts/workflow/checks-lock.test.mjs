// AGO-213: the pgTAP step of the gate must never release a db lock it did not take.
import { describe, expect, it } from "vitest";
import { lockTakenByThisStep, pgtapStep } from "./checks.mjs";

function harness(acquireOutput, { acquireCode = 0 } = {}) {
  const calls = [];
  const runCommand = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (args.includes("acquire")) return { code: acquireCode, output: acquireOutput };
    return { code: 0, output: "db lock released" };
  };
  const runStep = (name) => ({ name, command: "pnpm exec supabase test db", status: "pass", output: "ok" });
  return { calls, deps: { runCommand, runStep, isStackUp: async () => true } };
}

describe("lockTakenByThisStep", () => {
  it("is true only for a fresh acquire", () => {
    expect(lockTakenByThisStep("db lock acquired by AGO-213\n")).toBe(true);
    expect(lockTakenByThisStep("db lock already held by AGO-213\n")).toBe(false);
    expect(lockTakenByThisStep("")).toBe(false);
  });
});

describe("pgtapStep and the db lock", () => {
  it("keeps the caller's lock: no release when acquire reports it was already held", async () => {
    const { calls, deps } = harness("db lock already held by AGO-213");
    const result = await pgtapStep("AGO-213", deps);
    expect(result.status).toBe("pass");
    expect(calls.some((c) => c.includes("release"))).toBe(false);
  });

  it("releases a lock it took itself", async () => {
    const { calls, deps } = harness("db lock acquired by AGO-213");
    await pgtapStep("AGO-213", deps);
    expect(calls.filter((c) => c.includes("release"))).toEqual(["node scripts/db-lock.mjs release AGO-213"]);
  });

  it("still keeps the caller's lock when the pgTAP run itself throws", async () => {
    const { calls, deps } = harness("db lock already held by AGO-213");
    deps.runStep = () => {
      throw new Error("supabase crashed");
    };
    await expect(pgtapStep("AGO-213", deps)).rejects.toThrow("supabase crashed");
    expect(calls.some((c) => c.includes("release"))).toBe(false);
  });

  it("fails without releasing anything when acquire fails", async () => {
    const { calls, deps } = harness("db lock still held by AGO-99 after 30 min", { acquireCode: 2 });
    const result = await pgtapStep("AGO-213", deps);
    expect(result.status).toBe("fail");
    expect(calls.some((c) => c.includes("release"))).toBe(false);
  });
});
