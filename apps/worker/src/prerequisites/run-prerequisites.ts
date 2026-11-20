import type { PrerequisiteResult } from "@ago/shared";

import { DEFAULT_PREREQUISITE_PROBES, type PrerequisiteProbe } from "./probes.js";

/** One probe may not hold up a decision for long. Timeout means deny. */
export const PREREQUISITE_PROBE_TIMEOUT_MS = 5_000;

export interface RunPrerequisiteOptions {
  readonly probes?: readonly PrerequisiteProbe[];
  readonly timeoutMs?: number;
}

/**
 * Runs every probe, each under its own timeout, and reports one result per probe. A probe that fails, throws,
 * returns a malformed code or does not answer in time is a failure: nothing here throws, and nothing from an
 * error reaches the result (only a fixed status and a short code).
 */
export async function runPrerequisiteChecks(
  options: RunPrerequisiteOptions = {},
): Promise<PrerequisiteResult[]> {
  const probes = options.probes ?? DEFAULT_PREREQUISITE_PROBES;
  const timeoutMs = options.timeoutMs ?? PREREQUISITE_PROBE_TIMEOUT_MS;
  return Promise.all(probes.map((probe) => runOne(probe, timeoutMs)));
}

async function runOne(probe: PrerequisiteProbe, timeoutMs: number): Promise<PrerequisiteResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      resolve("timeout");
    }, timeoutMs);
  });
  try {
    const outcome = await Promise.race([
      Promise.resolve().then(() => {
        return probe.run();
      }),
      timeout,
    ]);
    if (outcome === "timeout") return { name: probe.name, status: "timeout", reason: "timed_out" };
    if (outcome === undefined) return { name: probe.name, status: "pass" };
    if (typeof outcome === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(outcome)) {
      return { name: probe.name, status: "fail", reason: outcome };
    }
    return { name: probe.name, status: "fail", reason: "invalid_probe_result" };
  } catch {
    return { name: probe.name, status: "error", reason: "probe_threw" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
