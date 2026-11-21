import { describe, expect, it, vi } from "vitest";

import { evaluatePrerequisites } from "@ago/shared";

import { fetchPrerequisiteReport, PREREQUISITE_REPORT_TIMEOUT_MS } from "./prerequisite-report";

const WORKER = "http://127.0.0.1:8080";
const NAMES = [
  "sandbox_hardened",
  "egress_default_deny",
  "credential_broker",
  "approval_payload_hash",
] as const;

const allPass = NAMES.map((name) => ({ name, status: "pass" }));

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe("fetchPrerequisiteReport", () => {
  it("returns the validated results when every check passes", async () => {
    const fetchFn = vi.fn(() => json({ results: allPass }));
    const results = await fetchPrerequisiteReport({
      workerUrl: WORKER,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(results).toEqual(allPass);
    expect(evaluatePrerequisites("code.run", results).isSatisfied).toBe(true);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(`${WORKER}/prerequisites`);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
  });

  it("keeps a failing check so the evaluator blocks on it", async () => {
    const body = {
      results: allPass.map((r) =>
        r.name === "egress_default_deny"
          ? { ...r, status: "fail", reason: "allowlist_unreadable" }
          : r,
      ),
    };
    const results = await fetchPrerequisiteReport({
      workerUrl: WORKER,
      fetchFn: (() => json(body)) as unknown as typeof fetch,
    });
    const verdict = evaluatePrerequisites("web.browse", results);
    expect(verdict.isSatisfied).toBe(false);
    expect(verdict.failures.map((f) => f.name)).toEqual(["egress_default_deny"]);
  });

  it("fails closed when WORKER_INTERNAL_URL is unset, empty or not an http(s) URL", async () => {
    const fetchFn = vi.fn(() => json({ results: allPass }));
    for (const workerUrl of [undefined, "", "not a url", "file:///etc/passwd", "ftp://host"]) {
      expect(
        await fetchPrerequisiteReport({ workerUrl, fetchFn: fetchFn as unknown as typeof fetch }),
      ).toEqual([]);
    }
    expect(fetchFn).not.toHaveBeenCalled();
    expect(evaluatePrerequisites("code.run", []).isSatisfied).toBe(false);
  });

  it("reads WORKER_INTERNAL_URL from the environment and treats it as unset when missing", async () => {
    const previous = process.env.WORKER_INTERNAL_URL;
    delete process.env.WORKER_INTERNAL_URL;
    try {
      const fetchFn = vi.fn(() => json({ results: allPass }));
      expect(
        await fetchPrerequisiteReport({ fetchFn: fetchFn as unknown as typeof fetch }),
      ).toEqual([]);
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      if (previous !== undefined) process.env.WORKER_INTERNAL_URL = previous;
    }
  });

  it("returns no results when the worker is down", async () => {
    const fetchFn = () => Promise.reject(new TypeError("fetch failed: ECONNREFUSED"));
    expect(await fetchPrerequisiteReport({ workerUrl: WORKER, fetchFn: fetchFn })).toEqual([]);
  });

  it("treats a slow worker as a deny once the timeout passes", async () => {
    const fetchFn = (_url: URL, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const started = Date.now();
    const results = await fetchPrerequisiteReport({
      workerUrl: WORKER,
      timeoutMs: 20,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(results).toEqual([]);
    expect(Date.now() - started).toBeLessThan(PREREQUISITE_REPORT_TIMEOUT_MS);
  });

  it("never waits longer than 2 seconds, whatever timeout is asked for", () => {
    expect(PREREQUISITE_REPORT_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
  });

  it.each([
    ["a non-JSON body", () => Promise.resolve(new Response("<html>oops</html>", { status: 200 }))],
    ["a 500", () => json({ error: "unavailable" }, 500)],
    ["a 404", () => json({ results: allPass }, 404)],
    ["a missing results field", () => json({ ok: true })],
    ["results that is not an array", () => json({ results: "pass" })],
    ["an unknown status", () => json({ results: [{ name: "sandbox_hardened", status: "ok" }] })],
    ["an unknown check name", () => json({ results: [{ name: "free_money", status: "pass" }] })],
    [
      "a free-text reason",
      () =>
        json({
          results: [{ name: "sandbox_hardened", status: "fail", reason: "Error at /srv/app" }],
        }),
    ],
    [
      "an extra field on a result",
      () => json({ results: [{ name: "sandbox_hardened", status: "pass", path: "/srv/app" }] }),
    ],
    ["an extra top-level field", () => json({ results: allPass, env: { KEY: "x" } })],
  ])("treats %s as a failed report", async (_label, respond) => {
    expect(
      await fetchPrerequisiteReport({
        workerUrl: WORKER,
        fetchFn: respond as unknown as typeof fetch,
      }),
    ).toEqual([]);
  });
});
