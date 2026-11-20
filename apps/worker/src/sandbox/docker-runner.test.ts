import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDockerSandboxRunner, listSandboxContainers } from "./docker-runner.js";
import { SANDBOX_IMAGE, type SandboxRequest, type SandboxResult } from "./sandbox-runner.js";

// Real containers: slow on Windows under full-suite load (AGO-121 lost re-gates to 5 s defaults).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

function dockerReady(): { ok: true } | { ok: false; reason: string } {
  const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], {
    encoding: "utf8",
    timeout: 20_000,
  });
  if (info.error !== undefined || info.status !== 0) {
    return { ok: false, reason: "the docker daemon is not reachable" };
  }
  if (info.stdout.trim() !== "linux")
    return { ok: false, reason: "docker is not running Linux containers" };
  const image = spawnSync("docker", ["image", "inspect", SANDBOX_IMAGE], {
    encoding: "utf8",
    timeout: 20_000,
  });
  if (image.status !== 0) {
    const pull = spawnSync("docker", ["pull", SANDBOX_IMAGE], {
      encoding: "utf8",
      timeout: 100_000,
    });
    if (pull.status !== 0)
      return { ok: false, reason: `the pinned image ${SANDBOX_IMAGE} is not available` };
  }
  return { ok: true };
}

const ready = dockerReady();
if (!ready.ok) {
  // Printed on purpose: a skipped escape-probe suite must say why (CI may not have Docker).
  console.warn(`[sandbox] SKIPPING the container escape probes: ${ready.reason}`);
}

const runner = createDockerSandboxRunner();
const runIds: string[] = [];
let counter = 0;

function request(command: string[], extra: Partial<SandboxRequest> = {}): SandboxRequest {
  counter += 1;
  const runId = `probe-${String(process.pid)}-${String(counter)}`;
  runIds.push(runId);
  return { workspaceId: "ws-probe", runId, command, ...extra };
}

async function sh(script: string, extra: Partial<SandboxRequest> = {}): Promise<SandboxResult> {
  return runner.run(request(["sh", "-c", script], extra));
}

function completed(result: SandboxResult): Extract<SandboxResult, { kind: "completed" }> {
  if (result.kind !== "completed")
    throw new Error(`expected completed, got denied: ${result.reason}`);
  return result;
}

describe.skipIf(!ready.ok)("sandbox: a normal call", () => {
  it("runs a command and returns its output and exit code", async () => {
    const result = completed(await sh("echo out; echo err >&2; exit 3"));
    expect(result).toMatchObject({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
  });

  it("runs as an unprivileged per-run uid with no capabilities, no new privileges and the default seccomp profile", async () => {
    const result = completed(
      await sh("id -u; grep -E '^(CapEff|CapBnd|NoNewPrivs|Seccomp):' /proc/self/status"),
    );
    const text = result.stdout;
    expect(Number(text.split("\n")[0])).toBeGreaterThanOrEqual(100_000);
    expect(text).toMatch(/CapEff:\s+0{16}/);
    expect(text).toMatch(/CapBnd:\s+0{16}/);
    expect(text).toMatch(/NoNewPrivs:\s+1/);
    expect(text).toMatch(/Seccomp:\s+2/);
  });

  it("moves input files in through the scratch directory", async () => {
    const result = completed(
      await runner.run(
        request(["sh", "-c", "cat a/b.txt"], {
          files: [{ path: "a/b.txt", content: "from the host" }],
        }),
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("from the host");
  });
});

describe.skipIf(!ready.ok)("AC1: no network and no host socket", () => {
  let listener: Server;
  let port = 0;
  let connections = 0;

  beforeAll(async () => {
    listener = createServer((socket) => {
      connections += 1;
      socket.end("host-listener");
    });
    await new Promise<void>((resolve) => listener.listen(0, "0.0.0.0", resolve));
    const address = listener.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
  });
  afterAll(() => {
    listener.close();
  });

  it("has only a loopback interface", async () => {
    const result = completed(await sh("ls /sys/class/net"));
    expect(result.stdout.trim()).toBe("lo");
  });

  it("cannot resolve DNS", async () => {
    const result = completed(await sh("nslookup -timeout=2 example.com 2>&1; echo status=$?"));
    expect(result.stdout).not.toContain("status=0");
  });

  it("cannot open a raw TCP connection to the internet", async () => {
    const result = completed(await sh("nc -w 2 1.1.1.1 80 </dev/null; echo status=$?"));
    expect(result.stdout).not.toContain("status=0");
  });

  it("cannot reach a listener on the host over HTTP or TCP, by name or by address", async () => {
    const targets = ["host.docker.internal", "172.17.0.1", "192.168.65.254", "127.0.0.1"];
    for (const target of targets) {
      const result = completed(
        await sh(
          `wget -q -T 2 -O- http://${target}:${String(port)}/ 2>&1; echo status=$?; nc -w 2 ${target} ${String(port)} </dev/null; echo nc=$?`,
          { limits: { timeoutMs: 40_000 } },
        ),
      );
      expect(result.stdout).not.toContain("status=0");
      expect(result.stdout).not.toContain("nc=0");
      expect(result.stdout).not.toContain("host-listener");
    }
    expect(connections).toBe(0);
  });

  it("has no Docker socket and no host path mounted", async () => {
    const result = completed(
      await sh("ls -d /var/run/docker.sock /run/docker.sock 2>&1; echo ---; cat /proc/mounts"),
    );
    expect(result.stdout).toMatch(/No such file/);
    const mounts = result.stdout.split("---")[1] ?? "";
    // Container-owned bind mounts (/etc/hosts, /etc/hostname, /etc/resolv.conf) are Docker's own, not host paths.
    expect(mounts).not.toMatch(
      /docker\.sock|\s\/(host|mnt|c|Users|run\/desktop)|virtiofs|\s9p\s|grpcfuse|fakeowner/,
    );
  });

  it("sees no abstract unix sockets of the host (own network namespace)", async () => {
    const result = completed(await sh("grep -c '@' /proc/net/unix; true"));
    expect(result.stdout.trim()).toBe("0");
  });

  it("sees no other process (own pid namespace)", async () => {
    const result = completed(await sh("ls /proc | grep -E '^[0-9]+$' | wc -l"));
    expect(Number(result.stdout.trim())).toBeLessThan(8);
  });
});

describe.skipIf(!ready.ok)("AC3: escape probes fail", () => {
  it("cannot mount a filesystem, change the clock or create devices", async () => {
    const result = completed(
      await sh(
        "mount -t tmpfs none /mnt 2>&1; echo mount=$?; date -s '2001-01-01' >/dev/null 2>&1; echo year=$(date +%Y); mknod /work/null c 1 3 2>&1; echo mknod=$?",
      ),
    );
    expect(result.stdout).not.toContain("mount=0");
    // busybox `date -s` exits 0 even when it is refused, so the clock itself is what is checked.
    expect(result.stdout).not.toContain("year=2001");
    expect(result.stdout).not.toContain("mknod=0");
  });

  it("cannot ping out or load a kernel module", async () => {
    // (Loopback ping works for an unprivileged user via ICMP datagram sockets; that is not an escape.)
    const result = completed(
      await sh("ping -c1 -W1 1.1.1.1 2>&1; echo ping=$?; insmod x.ko 2>&1; echo insmod=$?"),
    );
    expect(result.stdout).not.toContain("ping=0");
    expect(result.stdout).not.toContain("insmod=0");
  });

  it("cannot gain privileges through a setuid file", async () => {
    // Even a setuid copy of busybox cannot raise the uid: no-new-privileges, no caps, nosuid scratch.
    const result = completed(
      await sh(
        "cp /bin/busybox /work/b 2>&1; chmod u+s /work/b 2>&1; /work/b id -u 2>&1; echo status=$?",
      ),
    );
    expect(result.stdout).not.toMatch(/^0$/m);
  });

  it("cannot write outside the scratch directories", async () => {
    const result = completed(
      await sh(
        "touch /etc/x 2>&1; echo etc=$?; touch /usr/x 2>&1; echo usr=$?; touch /root/x 2>&1; echo root=$?; touch /work/ok; echo work=$?",
      ),
    );
    expect(result.stdout).not.toContain("etc=0");
    expect(result.stdout).not.toContain("usr=0");
    expect(result.stdout).not.toContain("root=0");
    expect(result.stdout).toContain("work=0");
  });

  it("cannot read host paths or the worker's environment", async () => {
    const result = completed(await sh("ls /host /Users /c /mnt/c /mnt/host 2>&1; env"));
    expect(result.stdout).not.toMatch(/jocar|SUPABASE|ANTHROPIC|TOKEN|SECRET/);
    expect(result.stdout).toMatch(/No such file/);
  });

  it("cannot fill the disk past the scratch cap", async () => {
    const result = completed(
      await sh("dd if=/dev/zero of=/work/big bs=1M count=50 2>&1; echo status=$?", {
        limits: { scratchMb: 8 },
      }),
    );
    expect(result.stdout).not.toContain("status=0");
    expect(result.stdout).toMatch(/No space left/);
  });

  it("cannot open more files than the limit", async () => {
    const result = completed(await sh("ulimit -n", { limits: { maxOpenFiles: 64 } }));
    expect(result.stdout.trim()).toBe("64");
  });
});

describe.skipIf(!ready.ok)("AC2: CPU, memory, pids and time limits", () => {
  it("applies the memory and CPU limits to the container's cgroup", async () => {
    const result = completed(
      await sh(
        "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/cpu.max /sys/fs/cgroup/pids.max",
        { limits: { memoryMb: 48, cpus: 0.5, pids: 20 } },
      ),
    );
    expect(result.stdout.trim().split("\n")).toEqual([
      String(48 * 1024 * 1024),
      "0",
      "50000 100000",
      "20",
    ]);
  });

  it("kills a memory blow-up and reports out_of_memory", async () => {
    const result = await sh('x=aaaaaaaaaaaaaaaa; while true; do x="$x$x"; done', {
      limits: { memoryMb: 32, timeoutMs: 40_000 },
    });
    expect(result).toMatchObject({ kind: "denied", reason: "out_of_memory" });
  });

  it("stops a fork bomb at the pids limit", async () => {
    const result = completed(
      await sh(
        "for i in $(seq 1 300); do (sleep 20 &) 2>/dev/null; done; ls /proc | grep -cE '^[0-9]+$'",
        { limits: { pids: 16, timeoutMs: 40_000 } },
      ),
    );
    expect(Number(result.stdout.trim().split("\n").pop())).toBeLessThanOrEqual(16);
  });

  it("kills a CPU spin at the time limit and reports a timeout (timeout means deny)", async () => {
    const started = Date.now();
    const result = await sh("while :; do :; done", { limits: { timeoutMs: 2_000 } });
    expect(result).toMatchObject({ kind: "denied", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("kills a sleep past the time limit, including child processes", async () => {
    const result = await sh("sleep 60 & sleep 60 & wait", { limits: { timeoutMs: 1_500 } });
    expect(result).toMatchObject({ kind: "denied", reason: "timeout" });
  });

  it("denies output past the cap instead of buffering it", async () => {
    const result = await runner.run(
      request(["yes"], { limits: { outputBytes: 2_048, timeoutMs: 30_000 } }),
    );
    expect(result).toMatchObject({ kind: "denied", reason: "output_limit" });
  });

  it("stops when the run is aborted", async () => {
    const controller = new AbortController();
    const pending = sh("sleep 60", { signal: controller.signal, limits: { timeoutMs: 60_000 } });
    setTimeout(() => {
      controller.abort();
    }, 1_500);
    expect(await pending).toMatchObject({ kind: "denied", reason: "aborted" });
  });
});

describe("sandbox: requests that never reach Docker", () => {
  it("denies an invalid request", async () => {
    const result = await runner.run({
      workspaceId: "ws",
      runId: "r",
      command: ["cat"],
      files: [{ path: "../x", content: "" }],
    });
    expect(result).toMatchObject({ kind: "denied", reason: "invalid_request" });
  });

  it("denies, never hangs, when Docker is not installed", async () => {
    const result = await createDockerSandboxRunner({ dockerBinary: "docker-does-not-exist" }).run({
      workspaceId: "ws",
      runId: "r",
      command: ["echo", "hi"],
    });
    expect(result).toMatchObject({ kind: "denied", reason: "runtime_unavailable" });
  });
});

describe.skipIf(!ready.ok)("sandbox: no container is left behind", () => {
  it("removes the container on success, failure, deny and timeout", async () => {
    await sh("exit 0");
    await sh("exit 7");
    await sh("sleep 30", { limits: { timeoutMs: 1_000 } });
    await runner.run(request(["no-such-program"]));
    for (const runId of runIds) {
      expect(await listSandboxContainers("docker", runId)).toEqual([]);
    }
    expect(runIds.length).toBeGreaterThan(4);
  });

  afterAll(async () => {
    for (const runId of runIds) {
      expect(await listSandboxContainers("docker", runId)).toEqual([]);
    }
  });
});
