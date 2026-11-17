import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";

import {
  SANDBOX_IMAGE,
  resolveSandboxLimits,
  validateSandboxRequest,
  type SandboxLimits,
  type SandboxRequest,
  type SandboxResult,
  type SandboxRunner,
} from "./sandbox-runner.js";
import { createTar } from "./tar.js";

/** Every sandbox container carries this label, so a leftover one (crashed worker) can be found and removed. */
export const SANDBOX_LABEL = "ago.sandbox";
export const SANDBOX_RUN_LABEL = "ago.sandbox.run";
const NOBODY_UID = 65534;
/** Waiting on `docker rm`/`docker inspect` must never hang the run either. */
const CLEANUP_TIMEOUT_MS = 15_000;

export interface DockerRunnerOptions {
  readonly image?: string;
  readonly dockerBinary?: string;
}

/**
 * The isolation flags for one container. Pure, so the exact set is unit tested. Notes:
 * - no `--privileged`, no `--security-opt seccomp=unconfined`/`apparmor=unconfined`: Docker's default
 *   seccomp and AppArmor profiles stay on;
 * - no `-v`/`--mount` of any host path and no Docker socket: scratch space is a size-capped tmpfs;
 * - `--init` runs a reaper as PID 1, so killing the container ends the whole process tree.
 */
export function buildDockerRunArgs(input: {
  readonly name: string;
  readonly runId: string;
  readonly image: string;
  readonly limits: SandboxLimits;
  readonly command: readonly string[];
  readonly hasFiles: boolean;
  /**
   * Unprivileged uid the code runs as. RLIMIT_NPROC counts every process of a uid on the whole host, so each
   * run gets its own random uid: then `nproc` bounds this run alone and cannot be exhausted by (or starve) another.
   */
  readonly uid?: number;
}): string[] {
  const { limits } = input;
  const uid = String(input.uid ?? NOBODY_UID);
  const memory = `${String(limits.memoryMb)}m`;
  const nofile = String(limits.maxOpenFiles);
  const nproc = String(limits.pids);
  const scratch = String(limits.scratchMb);
  const program = input.hasFiles
    ? ["sh", "-c", 'tar -x -f - -C /work && exec "$@"', "sandbox", ...input.command]
    : [...input.command];
  return [
    "run",
    "--name",
    input.name,
    "--label",
    `${SANDBOX_LABEL}=true`,
    "--label",
    `${SANDBOX_RUN_LABEL}=${input.runId}`,
    "--rm",
    "--pull",
    "never",
    "-i",
    "--init",
    "--network",
    "none",
    "--ipc",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    `${uid}:${uid}`,
    "--memory",
    memory,
    "--memory-swap",
    memory,
    "--cpus",
    String(limits.cpus),
    "--pids-limit",
    String(limits.pids),
    "--ulimit",
    `nofile=${nofile}:${nofile}`,
    "--ulimit",
    `nproc=${nproc}:${nproc}`,
    "--ulimit",
    "core=0",
    "--tmpfs",
    `/work:rw,noexec,nosuid,nodev,size=${scratch}m,uid=${uid},gid=${uid},mode=0700`,
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=16m,uid=${uid},gid=${uid},mode=1777`,
    "--workdir",
    "/work",
    "--env",
    "HOME=/work",
    input.image,
    ...program,
  ];
}

interface Captured {
  chunks: Buffer[];
  bytes: number;
}

type DenyReason = Extract<SandboxResult, { kind: "denied" }>["reason"];

export function createDockerSandboxRunner(options: DockerRunnerOptions = {}): SandboxRunner {
  const image = options.image ?? SANDBOX_IMAGE;
  const docker = options.dockerBinary ?? "docker";

  return {
    async run(request: SandboxRequest): Promise<SandboxResult> {
      const startedAt = Date.now();
      const denied = (reason: DenyReason, message: string): SandboxResult => ({
        kind: "denied",
        reason,
        message,
        durationMs: Date.now() - startedAt,
      });

      const problem = validateSandboxRequest(request);
      if (problem !== undefined) return denied("invalid_request", problem);
      if (request.signal?.aborted === true) return denied("aborted", "the run was stopped");

      const limits = resolveSandboxLimits(request.limits);
      const files = request.files ?? [];
      const name = `ago-sbx-${randomBytes(8).toString("hex")}`;
      const args = buildDockerRunArgs({
        name,
        runId: request.runId,
        image,
        limits,
        command: request.command,
        hasFiles: files.length > 0,
        uid: 100_000 + randomInt(0, 900_000),
      });

      const out: Captured = { chunks: [], bytes: 0 };
      const err: Captured = { chunks: [], bytes: 0 };
      let stopReason: "timeout" | "output_limit" | "aborted" | undefined;
      let child: ChildProcess;
      try {
        child = spawn(docker, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      } catch (error) {
        return denied("runtime_unavailable", describe(error));
      }

      const exit = new Promise<{ code: number | null; spawnError?: Error }>((resolve) => {
        child.once("error", (spawnError) => {
          resolve({ code: null, spawnError });
        });
        child.once("close", (code) => {
          resolve({ code });
        });
      });

      const stop = (reason: "timeout" | "output_limit" | "aborted"): void => {
        if (stopReason !== undefined) return;
        stopReason = reason;
        // Killing the docker CLI does not stop the container; kill the container itself, then the CLI.
        void killContainer(docker, name).finally(() => child.kill());
      };

      const capture = (sink: Captured) => (chunk: Buffer) => {
        sink.bytes += chunk.length;
        if (sink.bytes > limits.outputBytes) {
          stop("output_limit");
          return;
        }
        sink.chunks.push(chunk);
      };
      child.stdout?.on("data", capture(out));
      child.stderr?.on("data", capture(err));

      const timer = setTimeout(() => {
        stop("timeout");
      }, limits.timeoutMs);
      const onAbort = () => {
        stop("aborted");
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });

      // The container may exit before reading stdin; a broken pipe there is not an error.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(files.length > 0 ? createTar(files) : undefined);

      try {
        const { code, spawnError } = await exit;
        if (spawnError !== undefined) {
          return denied("runtime_unavailable", `docker is not available: ${spawnError.message}`);
        }
        if (stopReason === "timeout") {
          return denied(
            "timeout",
            `the call ran longer than ${String(limits.timeoutMs)} ms and was killed`,
          );
        }
        if (stopReason === "output_limit") {
          return denied(
            "output_limit",
            `output was larger than ${String(limits.outputBytes)} bytes and the call was killed`,
          );
        }
        if (stopReason === "aborted") return denied("aborted", "the run was stopped");

        const stderrText = Buffer.concat(err.chunks).toString("utf8");
        // 125 = Docker itself failed (daemon down, image missing); the code did not run.
        if (code === 125) {
          return denied(
            "runtime_unavailable",
            `the container could not start: ${stderrText.trim().slice(0, 300)}`,
          );
        }
        // 137 = SIGKILL. A timeout or abort kill was handled above, so here it is the kernel OOM killer.
        if (code === 137) {
          return denied(
            "out_of_memory",
            `the call used more than ${String(limits.memoryMb)} MiB and was killed`,
          );
        }
        return {
          kind: "completed",
          exitCode: code ?? -1,
          stdout: Buffer.concat(out.chunks).toString("utf8"),
          stderr: stderrText,
          durationMs: Date.now() - startedAt,
        };
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        // Every exit path: success, deny, timeout, crash. Idempotent and a no-op when `--rm` already won.
        await removeContainer(docker, name);
      }
    },
  };
}

/** Finds and force-removes every sandbox container, e.g. left behind by a worker that crashed mid-run. */
export async function removeLeftoverSandboxContainers(dockerBinary = "docker"): Promise<number> {
  const ids = await listSandboxContainers(dockerBinary);
  for (const id of ids) await removeContainer(dockerBinary, id);
  return ids.length;
}

/** Ids of every sandbox container, running or not. `runId` narrows it to one run. */
export async function listSandboxContainers(
  dockerBinary = "docker",
  runId?: string,
): Promise<string[]> {
  const label = runId === undefined ? `${SANDBOX_LABEL}=true` : `${SANDBOX_RUN_LABEL}=${runId}`;
  const result = await runDocker(dockerBinary, ["ps", "-a", "-q", "--filter", `label=${label}`]);
  return result.stdout.split(/\s+/).filter((id) => id.length > 0);
}

function killContainer(docker: string, name: string): Promise<unknown> {
  return runDocker(docker, ["kill", name]);
}

function removeContainer(docker: string, name: string): Promise<unknown> {
  return runDocker(docker, ["rm", "-f", "-v", name]);
}

function runDocker(
  docker: string,
  args: readonly string[],
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const done = (code: number | null) => {
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
