import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildReport, checkTicketRecord, ticketKeyFromBranch, verdictOf } from "./checks.mjs";
import { findTranscriptDirs, formatCost, priceUsage, sumUsage } from "./cost.mjs";

const pass = { name: "Lint", command: "pnpm lint", status: "pass", output: "ok" };
const fail = { name: "Test", command: "pnpm test", status: "fail", output: "boom\nline2" };
const skip = { name: "pgTAP", command: "pnpm exec supabase test db", status: "skip", output: "stack down" };

describe("checks report format", () => {
  it("starts with VERDICT: PASS when nothing failed (skips do not fail)", () => {
    const report = buildReport([pass, skip], { key: "AGO-205", branch: "chore/ago-205/x" });
    expect(report.split("\n")[0]).toBe("VERDICT: PASS");
    expect(report).toContain("| pgTAP | SKIP |");
  });

  it("starts with VERDICT: FAIL and carries the command and log tail of the failure", () => {
    const report = buildReport([pass, fail]);
    expect(report.split("\n")[0]).toBe("VERDICT: FAIL");
    expect(report).toContain("$ pnpm test");
    expect(report).toContain("boom");
    expect(verdictOf([fail])).toBe("FAIL");
  });

  it("keeps only the tail of a long log", () => {
    const output = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const report = buildReport([{ ...fail, output }]);
    expect(report).toContain("line 199");
    expect(report).not.toContain("line 10\n");
  });
});

describe("ticket key and record", () => {
  it("reads the key from the branch name", () => {
    expect(ticketKeyFromBranch("chore/ago-205/adopt-delivery-workflow")).toBe("AGO-205");
    expect(ticketKeyFromBranch("main")).toBeNull();
  });

  it("requires a ticket link, and a PR link once a PR exists", () => {
    const withTicket = "# AGO-1 - T\n\nTicket: https://x.atlassian.net/browse/AGO-1\nPRs: (pending)\n";
    expect(checkTicketRecord(null, "AGO-1", false).ok).toBe(false);
    expect(checkTicketRecord("# AGO-1\nno links", "AGO-1", false).ok).toBe(false);
    expect(checkTicketRecord(withTicket, "AGO-1", false).ok).toBe(true);
    expect(checkTicketRecord(withTicket, "AGO-1", true).ok).toBe(false);
    const withPr = withTicket.replace("(pending)", "https://github.com/o/r/pull/12");
    expect(checkTicketRecord(withPr, "AGO-1", true).ok).toBe(true);
  });
});

describe("cost", () => {
  const line = (id, model, usage) => JSON.stringify({ message: { id, model, usage } });

  it("sums and prices usage, de-duplicating by message id", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const text = [line("m1", "claude-sonnet-5-5", usage), line("m1", "claude-sonnet-5-5", usage)].join("\n");
    const totals = sumUsage([text]);
    const priced = priceUsage(totals);
    expect(priced.usd).toBeCloseTo(18, 5); // 3 + 15 per million
    expect(formatCost(priced, totals, 1)).toContain("cost: $18.00");
  });

  it("reports unknown models as unpriced", () => {
    const totals = sumUsage([line("m1", "other-model", { input_tokens: 5 })]);
    expect(priceUsage(totals).unpriced).toEqual(["other-model"]);
  });

  it("finds transcript folders by whole-token ticket key, and none when absent", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cost-test-"));
    try {
      mkdirSync(path.join(root, "C--x-ago-205-adopt-delivery-workflow"));
      mkdirSync(path.join(root, "C--x-ago-2051-other"));
      writeFileSync(path.join(root, "note.txt"), "");
      expect(findTranscriptDirs(root, "AGO-205")).toHaveLength(1);
      expect(findTranscriptDirs(root, "AGO-999")).toHaveLength(0);
      expect(findTranscriptDirs(path.join(root, "missing"), "AGO-205")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
