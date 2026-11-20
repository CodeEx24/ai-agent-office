/**
 * The per-run sandbox (AGO-71). Code and file tools run behind `SandboxRunner`; the Docker implementation is
 * one vendor of it. The runner is only called after the policy hook allowed the tool call (the loop is the
 * only caller of `execute`), and it never widens what the call may do: limits are clamped, never "unlimited".
 */

import type { EgressRuntimeAllowlist } from "../egress/egress-launcher.js";
import { compileAllowlist } from "../egress/egress-proxy.js";

/**
 * Base image, pinned by digest so a moved tag can never change what code runs in (alpine 3.22).
 * Refresh deliberately: `docker pull alpine:3.22` then copy the new digest here.
 */
export const SANDBOX_IMAGE =
  "alpine@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f";

export interface SandboxLimits {
  /** Wall-clock limit for the whole call, including container start. */
  readonly timeoutMs: number;
  readonly memoryMb: number;
  readonly cpus: number;
  /** Maximum processes and threads inside the container (fork bombs). */
  readonly pids: number;
  /** Size of the writable scratch directory `/work`. */
  readonly scratchMb: number;
  /** stdout and stderr are each capped at this many bytes; going over is a deny, not a truncation. */
  readonly outputBytes: number;
  readonly maxOpenFiles: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  timeoutMs: 10_000,
  memoryMb: 256,
  cpus: 1,
  pids: 64,
  scratchMb: 64,
  outputBytes: 64 * 1024,
  maxOpenFiles: 256,
};

export const SANDBOX_LIMIT_BOUNDS: Readonly<
  Record<keyof SandboxLimits, { min: number; max: number }>
> = {
  timeoutMs: { min: 500, max: 120_000 },
  memoryMb: { min: 16, max: 1024 },
  cpus: { min: 0.1, max: 2 },
  pids: { min: 8, max: 256 },
  scratchMb: { min: 1, max: 256 },
  outputBytes: { min: 1024, max: 1024 * 1024 },
  maxOpenFiles: { min: 16, max: 1024 },
};

/** Pulls every limit into its bounds. A value that is not a finite number keeps the default. */
export function resolveSandboxLimits(overrides?: Partial<SandboxLimits>): SandboxLimits {
  const out: Record<string, number> = { ...DEFAULT_SANDBOX_LIMITS };
  for (const name of Object.keys(SANDBOX_LIMIT_BOUNDS) as (keyof SandboxLimits)[]) {
    const value = overrides?.[name];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const { min, max } = SANDBOX_LIMIT_BOUNDS[name];
    out[name] = Math.min(max, Math.max(min, value));
  }
  return out as unknown as SandboxLimits;
}

export interface SandboxFile {
  /** Relative path inside the scratch directory. No `..`, no absolute paths. */
  readonly path: string;
  readonly content: string;
}

export interface SandboxRequest {
  readonly workspaceId: string;
  readonly runId: string;
  /** argv, run without a shell. Use `["sh", "-c", "..."]` when a shell is wanted. */
  readonly command: readonly string[];
  readonly files?: readonly SandboxFile[];
  readonly limits?: Partial<SandboxLimits>;
  readonly signal?: AbortSignal;
  /**
   * Set by worker code from the workspace allowlist (AGO-65), never by the model. Absent means the container
   * gets `--network none`. Present means its only route is the egress proxy (default deny, this allowlist);
   * an empty allowlist is valid and allows nothing.
   */
  readonly egress?: EgressRuntimeAllowlist;
}

export type SandboxDenyReason =
  | "timeout"
  | "out_of_memory"
  | "output_limit"
  | "aborted"
  | "invalid_request"
  | "runtime_unavailable";

export type SandboxResult =
  | {
      readonly kind: "completed";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly durationMs: number;
    }
  | {
      readonly kind: "denied";
      readonly reason: SandboxDenyReason;
      readonly message: string;
      readonly durationMs: number;
    };

export interface SandboxRunner {
  run(request: SandboxRequest): Promise<SandboxResult>;
}

const MAX_ARGS = 64;
const MAX_ARG_CHARS = 16_384;
const MAX_FILES = 32;
const MAX_FILE_PATH_CHARS = 200;
const MAX_INPUT_BYTES = 1024 * 1024;
const SAFE_ID = /^[a-zA-Z0-9_-]{1,80}$/;

/** Returns a reason when the request must not reach the runtime, otherwise undefined. */
export function validateSandboxRequest(request: SandboxRequest): string | undefined {
  if (!SAFE_ID.test(request.runId)) return "run id is not a safe identifier";
  if (!SAFE_ID.test(request.workspaceId)) return "workspace id is not a safe identifier";
  const { command } = request;
  if (command.length === 0 || command.length > MAX_ARGS)
    return "command must have 1 to 64 arguments";
  for (const arg of command) {
    if (typeof arg !== "string" || arg.length > MAX_ARG_CHARS || arg.includes("\0")) {
      return "command argument is too long or contains a NUL byte";
    }
  }
  if (command[0] === "" || command[0]?.startsWith("-") === true)
    return "command must name a program";
  const files = request.files ?? [];
  if (files.length > MAX_FILES) return "too many input files";
  let total = 0;
  const seen = new Set<string>();
  for (const file of files) {
    const problem = validateRelativePath(file.path);
    if (problem !== undefined) return `input file path ${problem}`;
    if (seen.has(file.path)) return "duplicate input file path";
    seen.add(file.path);
    total += Buffer.byteLength(file.content, "utf8");
  }
  if (total > MAX_INPUT_BYTES) return "input files are larger than 1 MiB";
  if (request.egress !== undefined) {
    const { hosts, ports } = request.egress;
    if (hosts.length > 200 || ports.length > 10) return "egress allowlist is too large";
    if (!ports.every((port) => Number.isInteger(port) && port >= 1 && port <= 65_535)) {
      return "egress allowlist has an invalid port";
    }
    try {
      compileAllowlist(hosts);
    } catch {
      return "egress allowlist has an invalid host";
    }
  }
  return undefined;
}

function validateRelativePath(path: string): string | undefined {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_FILE_PATH_CHARS) {
    return "is empty or too long";
  }
  if (path.includes("\0") || path.includes("\\")) return "has a forbidden character";
  if (path.startsWith("/")) return "must be relative";
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return "has an empty, '.' or '..' segment";
  }
  return undefined;
}
