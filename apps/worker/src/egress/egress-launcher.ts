import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";

import { EGRESS_BLOCK_REASONS, type EgressDecision } from "@ago/shared";

import type { Logger } from "../logger.js";
import { compileAllowlist } from "./egress-proxy.js";

/**
 * Runs one egress proxy per sandbox run (AGO-65). Topology:
 *
 *   sandbox container --(internal network, no gateway)--> proxy container --(default bridge)--> internet
 *
 * The internal network has no route out, so the sandbox cannot reach anything except the proxy, whether or not
 * the code honours `HTTP_PROXY`. The proxy joins the bridge only after it is listening on its internal address,
 * so the listener is never reachable from other containers on the bridge. Every failure here is a deny: the
 * caller must not start the sandbox without a ready proxy and must never fall back to a direct network.
 */

/** Pinned by digest so a moved tag can never change what runs (node 24, alpine). Refresh deliberately. */
export const EGRESS_PROXY_IMAGE =
  "node@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5";
export const EGRESS_LABEL = "ago.egress";
export const EGRESS_RUN_LABEL = "ago.egress.run";
export const EGRESS_PROXY_PORT = 3128;
const READY_TIMEOUT_MS = 20_000;
const CLEANUP_TIMEOUT_MS = 15_000;
const MAX_LINE_BYTES = 8 * 1024;

export interface EgressRuntimeAllowlist {
  readonly hosts: readonly string[];
  readonly ports: readonly number[];
}

export interface StartEgressProxyOptions {
  readonly runId: string;
  readonly workspaceId: string;
  readonly allowlist: EgressRuntimeAllowlist;
  readonly onDecision?: (decision: EgressDecision) => void;
  readonly image?: string;
  readonly dockerBinary?: string;
  readonly readyTimeoutMs?: number;
  /** TEST ONLY: exact IPs exempt from the private-range block (a local target container). */
  readonly unsafeAllowAddressesForTests?: readonly string[];
  /** TEST ONLY: `name:ip` entries added to the proxy's /etc/hosts so a local target container has a name. */
  readonly addHostsForTests?: readonly string[];
}

export interface EgressSession {
  /** `http://<proxy ip>:3128`, reachable only from the internal network. */
  readonly proxyUrl: string;
  /** The `--internal` Docker network the sandbox joins. */
  readonly networkName: string;
  /** Removes the proxy container and the network. Safe to call more than once. */
  stop(): Promise<void>;
}

export type StartEgressResult =
  | { readonly ok: true; readonly session: EgressSession }
  | { readonly ok: false; readonly message: string };

/** Environment variables that point a sandboxed program at the proxy. */
export function proxyEnvironment(proxyUrl: string): Record<string, string> {
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: "",
    no_proxy: "",
  };
}

/** The proxy's source: `.ts` when running from source (tests), `.js` when running the built worker. */
export async function readEgressProxySource(): Promise<string> {
  for (const name of ["./egress-proxy.ts", "./egress-proxy.js"]) {
    try {
      return await readFile(new URL(name, import.meta.url), "utf8");
    } catch {
      // try the next candidate
    }
  }
  throw new Error("egress proxy source not found");
}

/** `docker run` flags for the proxy container. Pure, so the exact hardening is unit tested. */
export function buildProxyRunArgs(input: {
  readonly name: string;
  readonly networkName: string;
  readonly image: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly allowlist: EgressRuntimeAllowlist;
  readonly unsafeAllowAddressesForTests?: readonly string[];
  readonly addHostsForTests?: readonly string[];
}): string[] {
  const env: [string, string][] = [
    ["EGRESS_PROXY_MAIN", "1"],
    ["EGRESS_RUN_ID", input.runId],
    ["EGRESS_WORKSPACE_ID", input.workspaceId],
    ["EGRESS_LISTEN_PORT", String(EGRESS_PROXY_PORT)],
    ["EGRESS_HOSTS", input.allowlist.hosts.join(",")],
    ["EGRESS_PORTS", input.allowlist.ports.join(",")],
  ];
  if ((input.unsafeAllowAddressesForTests ?? []).length > 0) {
    env.push([
      "EGRESS_UNSAFE_ALLOW_ADDRESSES_TEST_ONLY",
      (input.unsafeAllowAddressesForTests ?? []).join(","),
    ]);
  }
  return [
    "run",
    "--name",
    input.name,
    "--label",
    `${EGRESS_LABEL}=true`,
    "--label",
    `${EGRESS_RUN_LABEL}=${input.runId}`,
    "--pull",
    "never",
    "-i",
    "--init",
    "--network",
    input.networkName,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "65532:65532",
    "--memory",
    "128m",
    "--memory-swap",
    "128m",
    "--cpus",
    "0.5",
    "--pids-limit",
    "64",
    "--ulimit",
    "nofile=1024:1024",
    "--ulimit",
    "core=0",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=8m,mode=1777",
    ...env.flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    ...(input.addHostsForTests ?? []).flatMap((entry) => ["--add-host", entry]),
    input.image,
    "node",
    "--input-type=module-typescript",
    "-",
  ];
}

export async function startEgressProxy(
  options: StartEgressProxyOptions,
): Promise<StartEgressResult> {
  const docker = options.dockerBinary ?? "docker";
  const image = options.image ?? EGRESS_PROXY_IMAGE;
  try {
    // A bad list must not half-apply: refuse before anything is created.
    compileAllowlist(options.allowlist.hosts);
  } catch (error) {
    return { ok: false, message: `the egress allowlist is invalid: ${describe(error)}` };
  }
  let source: string;
  try {
    source = await readEgressProxySource();
  } catch (error) {
    return { ok: false, message: describe(error) };
  }

  const suffix = randomBytes(8).toString("hex");
  const networkName = `ago-egn-${suffix}`;
  const proxyName = `ago-egp-${suffix}`;
  const labels = [
    "--label",
    `${EGRESS_LABEL}=true`,
    "--label",
    `${EGRESS_RUN_LABEL}=${options.runId}`,
  ];
  let child: ChildProcess | undefined;
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    child?.kill();
    await runDocker(docker, ["rm", "-f", "-v", proxyName]);
    await runDocker(docker, ["network", "rm", networkName]);
  };
  const fail = async (message: string): Promise<StartEgressResult> => {
    await stop();
    return { ok: false, message };
  };

  const created = await runDocker(docker, [
    "network",
    "create",
    "--internal",
    ...labels,
    networkName,
  ]);
  if (created.code !== 0) return fail("the internal egress network could not be created");

  try {
    child = spawn(
      docker,
      buildProxyRunArgs({
        name: proxyName,
        networkName,
        image,
        runId: options.runId,
        workspaceId: options.workspaceId,
        allowlist: options.allowlist,
        unsafeAllowAddressesForTests: options.unsafeAllowAddressesForTests,
        addHostsForTests: options.addHostsForTests,
      }),
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
  } catch (error) {
    return fail(`docker is not available: ${describe(error)}`);
  }
  const proc = child;
  let stderrTail = "";

  const ready = new Promise<string | undefined>((resolve) => {
    let buffer = "";
    let settled = false;
    const settle = (address: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(address);
    };
    const timer = setTimeout(() => {
      settle(undefined);
    }, options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    proc.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        const parsed = parseLine(line);
        if (parsed?.kind === "ready") settle(parsed.address);
        else if (parsed?.kind === "decision") options.onDecision?.(parsed.decision);
        at = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_LINE_BYTES) buffer = "";
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (stderrTail.length < 400) stderrTail += chunk.toString("utf8");
    });
    proc.once("error", () => {
      settle(undefined);
    });
    proc.once("close", () => {
      settle(undefined);
    });
  });

  proc.stdin?.on("error", () => undefined);
  proc.stdin?.end(source);

  const address = await ready;
  if (address === undefined || isIP(address) !== 4) {
    const detail = stderrTail.trim().slice(0, 300);
    return fail(`the egress proxy did not become ready${detail === "" ? "" : `: ${detail}`}`);
  }
  // Only now give the proxy its way out. Before this it can reach nothing.
  const joined = await runDocker(docker, ["network", "connect", "bridge", proxyName]);
  if (joined.code !== 0) return fail("the egress proxy could not be given its outbound route");

  return {
    ok: true,
    session: { proxyUrl: `http://${address}:${String(EGRESS_PROXY_PORT)}`, networkName, stop },
  };
}

type ParsedLine =
  | { readonly kind: "ready"; readonly address: string }
  | { readonly kind: "decision"; readonly decision: EgressDecision };

function parseLine(line: string): ParsedLine | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.event === "egress.ready" && typeof record.address === "string") {
    return { kind: "ready", address: record.address };
  }
  const { event, run_id: runId, workspace_id: workspaceId, host, port, method, reason } = record;
  if (
    (event === "egress.allowed" || event === "egress.blocked") &&
    typeof runId === "string" &&
    typeof workspaceId === "string" &&
    typeof host === "string" &&
    typeof port === "number" &&
    typeof method === "string"
  ) {
    const knownReason = EGRESS_BLOCK_REASONS.find((candidate) => candidate === reason);
    return {
      kind: "decision",
      decision: {
        event,
        run_id: runId,
        workspace_id: workspaceId,
        host,
        port,
        method,
        ...(knownReason === undefined ? {} : { reason: knownReason }),
      },
    };
  }
  return undefined;
}

/**
 * Sends proxy decisions to the worker's structured logger (scrubbed by it). Blocks are warnings; allowed
 * requests are debug. Only run_id, workspace_id, host, port, method and reason are ever logged.
 */
export function createEgressDecisionLogger(logger: Logger): (decision: EgressDecision) => void {
  return (decision) => {
    const bound = logger.child({ run_id: decision.run_id, workspace_id: decision.workspace_id });
    const fields = {
      event: decision.event,
      host: decision.host,
      port: decision.port,
      method: decision.method,
      reason: decision.reason,
    };
    if (decision.event === "egress.blocked") bound.warn(fields, "egress request blocked");
    else bound.debug(fields, "egress request allowed");
  };
}

/** Removes every egress proxy container and network, e.g. left behind by a worker that crashed mid-run. */
export async function removeLeftoverEgressResources(dockerBinary = "docker"): Promise<number> {
  const filter = ["--filter", `label=${EGRESS_LABEL}=true`];
  const containers = (await runDocker(dockerBinary, ["ps", "-a", "-q", ...filter])).stdout
    .split(/\s+/)
    .filter((id) => id.length > 0);
  for (const id of containers) await runDocker(dockerBinary, ["rm", "-f", "-v", id]);
  const networks = (await runDocker(dockerBinary, ["network", "ls", "-q", ...filter])).stdout
    .split(/\s+/)
    .filter((id) => id.length > 0);
  for (const id of networks) await runDocker(dockerBinary, ["network", "rm", id]);
  return containers.length + networks.length;
}

function runDocker(
  docker: string,
  args: readonly string[],
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    };
    let child: ChildProcess;
    try {
      child = spawn(docker, [...args], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      resolve({ code: null, stdout });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done(null);
    }, CLEANUP_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.once("error", () => {
      done(null);
    });
    child.once("close", (code) => {
      done(code);
    });
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
