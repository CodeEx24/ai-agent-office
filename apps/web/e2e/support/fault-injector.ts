import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// AGO-201 QA: makes chosen server-side calls of ONE test-owned app instance fail with a 500, while
// the shared database and every other spec stay untouched. `fault-preload.mjs` does the work inside
// the app's process; this file owns the control file the spec switches on and off.
// (A reverse proxy in front of Supabase does not work: NEXT_PUBLIC_SUPABASE_URL is inlined at build.)

const PRELOAD = fileURLToPath(new URL("./fault-preload.mjs", import.meta.url));

export interface FaultInjector {
  /** Environment for `startAppServer`: loads the preload and points it at this injector's files. */
  readonly env: Readonly<Record<string, string>>;
  /** Fail every server-side request whose `METHOD /path?query` matches `pattern` with HTTP 500. `null` heals. */
  failWhen(pattern: RegExp | null): void;
  /** How many requests were failed on purpose so far. */
  failedCount(): number;
  dispose(): void;
}

export function createFaultInjector(): FaultInjector {
  const dir = mkdtempSync(path.join(tmpdir(), "ago-qa-fault-"));
  const controlFile = path.join(dir, "pattern.txt");
  const hitsFile = path.join(dir, "hits.txt");
  writeFileSync(controlFile, "");
  writeFileSync(hitsFile, "");

  const inherited = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : "";
  return {
    env: {
      NODE_OPTIONS: `${inherited}--import=${pathToFileURL(PRELOAD).href}`,
      AGO_QA_FAULT_FILE: controlFile,
      AGO_QA_FAULT_HITS: hitsFile,
    },
    failWhen: (pattern) => {
      writeFileSync(controlFile, pattern === null ? "" : pattern.source);
    },
    failedCount: () => readFileSync(hitsFile, "utf8").length,
    dispose: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
