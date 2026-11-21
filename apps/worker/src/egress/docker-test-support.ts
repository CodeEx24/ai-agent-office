import { spawnSync } from "node:child_process";

import { SANDBOX_IMAGE } from "../sandbox/sandbox-runner.js";
import { EGRESS_PROXY_IMAGE, EGRESS_RUN_LABEL } from "./egress-launcher.js";

// Shared helpers for the real-container egress tests (AGO-251). Every container and network a test creates is
// tied to a run id that is unique to this test process, so the "leaves nothing behind" checks look only at what
// THIS process created and never trip over a container from an earlier, crashed or concurrent run.

const SANDBOX_RUN_LABEL = "ago.sandbox.run";

export function docker(args: string[], timeout = 60_000): { ok: boolean; out: string } {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout });
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}`.trim() };
}

export function dockerReady(): { ok: true } | { ok: false; reason: string } {
  const info = docker(["info", "--format", "{{.OSType}}"], 20_000);
  if (!info.ok) return { ok: false, reason: "the docker daemon is not reachable" };
  if (info.out !== "linux") return { ok: false, reason: "docker is not running Linux containers" };
  for (const image of [SANDBOX_IMAGE, EGRESS_PROXY_IMAGE]) {
    if (!docker(["image", "inspect", image], 20_000).ok && !docker(["pull", image], 120_000).ok) {
      return { ok: false, reason: `the pinned image ${image} is not available` };
    }
  }
  return { ok: true };
}

export interface RunScope {
  /** A run id unique to this process: `<name>-<pid>-<nonce>`. Remembered so it can be checked and cleaned. */
  id(name: string): string;
  /** Ids of every container and network this scope's runs left behind (egress proxy, network, sandbox). */
  leftovers(): string;
  /** Force-remove only what this scope's runs created, found by their run-id labels. */
  cleanup(): void;
}

export function createRunScope(): RunScope {
  const nonce = `${String(process.pid)}-${Date.now().toString(36)}`;
  const ids = new Set<string>();

  const lines = (out: string): string[] => out.split("\n").filter((line) => line !== "");
  const containersOf = (runId: string): string[] =>
    [EGRESS_RUN_LABEL, SANDBOX_RUN_LABEL].flatMap((label) =>
      lines(docker(["ps", "-a", "-q", "--filter", `label=${label}=${runId}`]).out),
    );
  const networksOf = (runId: string): string[] =>
    lines(docker(["network", "ls", "-q", "--filter", `label=${EGRESS_RUN_LABEL}=${runId}`]).out);

  return {
    id(name) {
      const runId = `${name}-${nonce}`;
      ids.add(runId);
      return runId;
    },
    leftovers() {
      return [...ids].flatMap((runId) => [...containersOf(runId), ...networksOf(runId)]).join("");
    },
    cleanup() {
      for (const runId of ids) {
        for (const container of containersOf(runId)) docker(["rm", "-f", container]);
        for (const network of networksOf(runId)) docker(["network", "rm", network]);
      }
    },
  };
}
