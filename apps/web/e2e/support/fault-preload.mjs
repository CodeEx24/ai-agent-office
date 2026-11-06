// AGO-201 QA: loaded into a test-owned `next start` through NODE_OPTIONS=--import. It wraps the
// server's global fetch so chosen calls (the Supabase REST calls the app makes) fail with a 500,
// which a spec cannot do from the browser because those calls never leave the server.
//
// Control: AGO_QA_FAULT_FILE holds one regular expression (empty = no faults). It is matched against
// "METHOD /path?query" of every outgoing request and re-read on each call, so a spec can switch the
// fault on and off while the server runs. Every injected failure appends one character to
// AGO_QA_FAULT_HITS, so a spec can prove the fault was really hit.
// Without both variables this file does nothing. Test support only; never part of the app build.
import { appendFileSync, readFileSync } from "node:fs";

const controlFile = process.env.AGO_QA_FAULT_FILE;
const hitsFile = process.env.AGO_QA_FAULT_HITS;

if (controlFile && hitsFile) {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = function faultInjectingFetch(input, init) {
    try {
      const pattern = readFileSync(controlFile, "utf8").trim();
      if (pattern) {
        const href =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = String(
          init?.method ?? (typeof input === "object" ? input.method : undefined) ?? "GET",
        ).toUpperCase();
        const url = new URL(href);
        if (new RegExp(pattern).test(`${method} ${url.pathname}${url.search}`)) {
          appendFileSync(hitsFile, "x");
          return Promise.resolve(
            new Response(JSON.stringify({ message: "injected fault (AGO-201 QA)" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            }),
          );
        }
      }
    } catch {
      // A broken control file must never break the server: fall through to the real fetch.
    }
    return originalFetch.call(globalThis, input, init);
  };
}
