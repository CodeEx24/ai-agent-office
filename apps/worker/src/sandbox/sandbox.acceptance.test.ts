import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDockerSandboxRunner, listSandboxContainers } from "./docker-runner.js";
import { SandboxDeniedError, createRunCodeTool } from "./run-code-tool.js";
import {
  SANDBOX_IMAGE,
  resolveSandboxLimits,
  type SandboxRequest,
  type SandboxResult,
  type SandboxRunner,
} from "./sandbox-runner.js";

// Independent functional acceptance tests for AGO-71 (real containers, no mocks for AC1-AC3).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

function dockerReady(): { ok: true } | { ok: false; reason: string } {
  const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], {
    encoding: "utf8",
    timeout: 20_000,
  });
  if (info.error !== undefined || info.status !== 0) {
    return { ok: false, reason: "the docker daemon is not reachable" };
  }
  if (info.stdout.trim() !== "linux") {
    return { ok: false, reason: "docker is not running Linux containers" };
  }
  const image = spawnSync("docker", ["image", "inspect", SANDBOX_IMAGE], {
    encoding: "utf8",
    timeout: 20_000,
  });
  if (image.status !== 0) {
    return { ok: false, reason: `the pinned image ${SANDBOX_IMAGE} is not available` };
  }
  return { ok: true };
}

const ready = dockerReady();
if (!ready.ok) {
  console.warn(
    `[sandbox-acceptance] SKIPPING the real-container acceptance tests: ${ready.reason}`,
  );
}

const runner = createDockerSandboxRunner();
const runIds: string[] = [];
let counter = 0;

function request(command: string[], extra: Partial<SandboxRequest> = {}): SandboxRequest {
  counter += 1;
  const runId = `acc-${String(process.pid)}-${String(counter)}`;
  runIds.push(runId);
  return { workspaceId: "ws-acceptance", runId, command, ...extra };
}

function sh(script: string, extra: Partial<SandboxRequest> = {}): Promise<SandboxResult> {
  return runner.run(request(["sh", "-c", script], extra));
}

function completed(result: SandboxResult): Extract<SandboxResult, { kind: "completed" }> {
  if (result.kind !== "completed") {
    throw new Error(`expected completed, got denied: ${result.reason} (${result.message})`);
  }
  return result;
}

describe.skipIf(!ready.ok)("AC1: no network access and no host socket for code tools", () => {
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

  it("exposes no network interface except loopback and no default route", async () => {
    const result = completed(
      await sh(
        "ls /sys/class/net; echo ---; cat /proc/net/route; echo ---; cat /proc/net/if_inet6",
      ),
    );
    const [ifaces = "", routes = "", inet6 = ""] = result.stdout.split("---\n");
    expect(ifaces.trim()).toBe("lo");
    // only the header line, no route at all
    expect(routes.trim().split("\n")).toHaveLength(1);
    // the only IPv6 address is the loopback ::1
    expect(inet6.trim().split("\n")).toHaveLength(1);
    expect(inet6).toMatch(/^0{31}1\s/);
  });

  it("fails DNS resolution by two different resolvers", async () => {
    const result = completed(
      await sh(
        "nslookup -timeout=2 example.com 2>&1; echo nslookup=$?; getent hosts example.com; echo getent=$?; wget -q -T 2 -O- http://example.com/ 2>&1; echo wget=$?",
        { limits: { timeoutMs: 60_000 } },
      ),
    );
    expect(result.stdout).not.toContain("nslookup=0");
    expect(result.stdout).not.toContain("getent=0");
    expect(result.stdout).not.toContain("wget=0");
  });

  it("makes no connection to a host listener over IPv4, by name, gateway or every host address", async () => {
    const hostAddrs: string[] = [];
    for (const list of Object.values(networkInterfaces())) {
      for (const entry of list ?? []) if (entry.family === "IPv4") hostAddrs.push(entry.address);
    }
    const targets = [
      "host.docker.internal",
      "gateway.docker.internal",
      "172.17.0.1",
      "192.168.65.254",
      "127.0.0.1",
      ...hostAddrs,
    ];
    const script = targets
      .map(
        (t) =>
          `wget -q -T 1 -O- http://${t}:${String(port)}/ 2>&1; echo "wget[${t}]=$?"; nc -w 1 ${t} ${String(port)} </dev/null 2>&1; echo "nc[${t}]=$?"`,
      )
      .join("; ");
    const result = completed(await sh(script, { limits: { timeoutMs: 100_000 } }));
    expect(result.stdout).not.toContain("host-listener");
    expect(result.stdout).not.toMatch(/(wget|nc)\[[^\]]+\]=0/);
    expect(connections).toBe(0);
  });

  it("cannot connect over IPv6, neither to the host loopback nor to a public address", async () => {
    const result = completed(
      await sh(
        `nc -6 -w 2 ::1 ${String(port)} </dev/null 2>&1; echo nc_lo=$?; nc -6 -w 2 2606:4700:4700::1111 80 </dev/null 2>&1; echo nc_pub=$?; wget -q -T 2 -O- "http://[2606:4700:4700::1111]/" 2>&1; echo wget_pub=$?; wget -q -T 2 -O- "http://[::1]:${String(port)}/" 2>&1; echo wget_lo=$?`,
        { limits: { timeoutMs: 60_000 } },
      ),
    );
    expect(result.stdout).not.toMatch(/nc_lo=0|nc_pub=0|wget_pub=0|wget_lo=0/);
    expect(result.stdout).not.toContain("host-listener");
    expect(connections).toBe(0);
  });

  it("does not let the code reach a listener it opens itself from outside its own network namespace", async () => {
    // a server inside the container is only reachable on the container's own loopback
    const result = completed(
      await sh("(echo inner | nc -l -p 9099 &) ; sleep 1; nc -w 2 127.0.0.1 9099 </dev/null"),
    );
    expect(result.stdout).toContain("inner");
  });

  it("has no Docker socket anywhere in the filesystem", async () => {
    const result = completed(
      await sh(
        "ls -d /var/run/docker.sock /run/docker.sock /var/run/docker /run/containerd 2>&1; echo ---; find / -xdev \\( -name '*.sock' -o -name 'docker*' \\) 2>/dev/null | grep -v '^/proc' | grep -v '^/sbin/docker-init$'; echo ---",
      ),
    );
    expect(result.stdout).toMatch(/No such file/);
    const found = result.stdout.split("---")[1] ?? "";
    expect(found.trim()).toBe("");
  });

  it("sees no host path mounted and cannot read well-known host locations", async () => {
    const result = completed(
      await sh(
        "for p in /host /host_mnt /run/desktop /mnt/host /mnt/c /c /Users /home/docker /var/lib/docker /etc/docker; do [ -e $p ] && echo EXISTS:$p; done; echo ---; cat /proc/mounts",
      ),
    );
    const [exists = "", mounts = ""] = result.stdout.split("---\n");
    expect(exists.trim()).toBe("");
    expect(mounts).not.toMatch(
      /docker\.sock|virtiofs|\s9p\s|grpcfuse|fakeowner|\/mnt\/host|\/run\/desktop|\/var\/lib\/docker\/volumes/,
    );
  });

  it("sees no abstract unix socket and no unix socket entry of the host", async () => {
    const result = completed(
      await sh("cat /proc/net/unix; echo ---; grep -c '@' /proc/net/unix; true"),
    );
    const [table = ""] = result.stdout.split("---\n");
    // header only: nothing of the host's namespace is visible
    expect(table.trim().split("\n")).toHaveLength(1);
    expect(result.stdout).not.toMatch(/containerd|docker|dockerd/);
  });

  it("runs in its own pid and ipc namespaces with a container hostname", async () => {
    const result = completed(
      await sh(
        "hostname; ls /proc | grep -cE '^[0-9]+$'; ls /dev/shm 2>&1 | head -1; cat /proc/sysvipc/shm 2>&1 | wc -l",
      ),
    );
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).not.toBe(process.env.COMPUTERNAME ?? "__none__");
    expect(Number(lines[1])).toBeLessThan(8);
  });
});

describe.skipIf(!ready.ok)("AC2: CPU, memory, pids, time and output limits", () => {
  it("denies a CPU spin as a timeout within a bounded time", async () => {
    const started = Date.now();
    const result = await sh("while :; do :; done", { limits: { timeoutMs: 1_500 } });
    expect(result).toMatchObject({ kind: "denied", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(25_000);
  });

  it("caps a multi-process CPU burn at the cpu quota (cgroup cpu.max)", async () => {
    const result = completed(await sh("cat /sys/fs/cgroup/cpu.max", { limits: { cpus: 0.25 } }));
    expect(result.stdout.trim()).toBe("25000 100000");
  });

  it("reports out_of_memory, not a hang, when the shell grows a 100 MB variable under a 32 MB limit", async () => {
    const started = Date.now();
    const result = await sh("x=$(head -c 100000000 /dev/zero | tr '\\0' a); echo survived", {
      limits: { memoryMb: 32, timeoutMs: 60_000 },
    });
    expect(result).toMatchObject({ kind: "denied", reason: "out_of_memory" });
    expect(Date.now() - started).toBeLessThan(55_000);
  });

  it("does not allow swap to turn a memory blow-up into a slow hang", async () => {
    const result = completed(
      await sh("cat /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/memory.max", {
        limits: { memoryMb: 64 },
      }),
    );
    expect(result.stdout.trim().split("\n")).toEqual(["0", String(64 * 1024 * 1024)]);
  });

  it("refuses to fork past the pids limit", async () => {
    const result = completed(
      await sh(
        "(for i in $(seq 1 120); do sleep 30 & done) 2>/dev/null; read cur < /sys/fs/cgroup/pids.current; echo cur=$cur; read mx < /sys/fs/cgroup/pids.max; echo mx=$mx; while read k v; do echo ev $k $v; done < /sys/fs/cgroup/pids.events",
        { limits: { pids: 12, timeoutMs: 60_000 } },
      ),
    );
    const text = result.stdout;
    expect(Number(/cur=(\d+)/.exec(text)?.[1])).toBeLessThanOrEqual(12);
    expect(text).toContain("mx=12");
    // 120 background sleeps were requested; the container never held more than the limit
    expect(Number(/cur=(\d+)/.exec(text)?.[1])).toBeGreaterThan(1);
  });

  it("survives a real fork bomb: ends as completed or denied and leaves no container", async () => {
    const req = request(["sh", "-c", "f() { f | f & }; f; sleep 30"], {
      limits: { pids: 16, timeoutMs: 5_000 },
    });
    const result = await runner.run(req);
    expect(["completed", "denied"]).toContain(result.kind);
    expect(await listSandboxContainers("docker", req.runId)).toEqual([]);
  });

  it("denies a call that runs past the wall-clock limit with the typed timeout reason", async () => {
    const result = await sh("sleep 60", { limits: { timeoutMs: 1_000 } });
    expect(result).toMatchObject({ kind: "denied", reason: "timeout" });
    expect(result.kind === "denied" ? result.message : "").toMatch(/500|1000|longer/);
  });

  it("denies stdout over the cap and does not truncate it", async () => {
    const result = await sh("yes", { limits: { outputBytes: 2_048, timeoutMs: 30_000 } });
    expect(result).toMatchObject({ kind: "denied", reason: "output_limit" });
  });

  it("denies stderr over the cap", async () => {
    const result = await sh("yes >&2", { limits: { outputBytes: 2_048, timeoutMs: 30_000 } });
    expect(result).toMatchObject({ kind: "denied", reason: "output_limit" });
  });

  it("accepts output exactly at the cap and denies one byte over", async () => {
    const atCap = await sh("head -c 1024 /dev/zero | tr '\\0' a", {
      limits: { outputBytes: 1_024 },
    });
    expect(completed(atCap).stdout).toHaveLength(1_024);
    const over = await sh("head -c 1025 /dev/zero | tr '\\0' a", {
      limits: { outputBytes: 1_024 },
    });
    expect(over).toMatchObject({ kind: "denied", reason: "output_limit" });
  });

  it("limits the scratch directory so a disk fill fails instead of growing", async () => {
    const result = completed(
      await sh("dd if=/dev/zero of=/work/big bs=1M count=20 2>&1; echo status=$?", {
        limits: { scratchMb: 4 },
      }),
    );
    expect(result.stdout).not.toContain("status=0");
  });

  it("clamps a model-sized limit into bounds instead of lifting it", () => {
    const limits = resolveSandboxLimits({
      timeoutMs: 1e12,
      memoryMb: 1e9,
      cpus: 64,
      pids: -5,
      scratchMb: Number.POSITIVE_INFINITY,
      outputBytes: Number.NaN,
    });
    expect(limits).toMatchObject({
      timeoutMs: 120_000,
      memoryMb: 1_024,
      cpus: 2,
      pids: 8,
      scratchMb: 64,
      outputBytes: 64 * 1024,
    });
  });
});

describe.skipIf(!ready.ok)("AC3: escape probes fail", () => {
  it("has no capabilities, no new privileges, an active seccomp filter and no tracer", async () => {
    const result = completed(
      await sh(
        "grep -E '^(CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp|TracerPid):' /proc/self/status",
      ),
    );
    for (const cap of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
      expect(result.stdout).toMatch(new RegExp(`${cap}:\\s+0{16}`));
    }
    expect(result.stdout).toMatch(/NoNewPrivs:\s+1/);
    expect(result.stdout).toMatch(/Seccomp:\s+2/);
  });

  it("cannot become root through a setuid binary", async () => {
    const result = completed(
      await sh(
        "cp /bin/busybox /work/b 2>&1; chmod u+s /work/b 2>&1; /work/b id -u 2>&1; echo exec=$?; su -c id root 2>&1; echo su=$?; ls -l /bin/su /usr/bin/sudo 2>&1 | head -2; id -u",
      ),
    );
    const lines = result.stdout.trim().split("\n");
    expect(lines.at(-1)).not.toBe("0");
    expect(result.stdout).not.toContain("exec=0");
    expect(result.stdout).not.toContain("su=0");
  });

  it("cannot execute a binary copied into scratch or tmp (noexec)", async () => {
    const result = completed(
      await sh(
        "cp /bin/busybox /work/b; /work/b true 2>&1; echo work=$?; cp /bin/busybox /tmp/b; /tmp/b true 2>&1; echo tmp=$?",
      ),
    );
    expect(result.stdout).not.toContain("work=0");
    expect(result.stdout).not.toContain("tmp=0");
  });

  it("cannot mount, bind-mount, remount or unshare a namespace", async () => {
    const result = completed(
      await sh(
        "mount -t tmpfs none /mnt 2>&1; echo mount=$?; mount --bind /work /mnt 2>&1; echo bind=$?; mount -o remount,rw / 2>&1; echo remount=$?; unshare -U -r true 2>&1; echo unshareU=$?; unshare -m true 2>&1; echo unshareM=$?; chroot /work true 2>&1; echo chroot=$?",
      ),
    );
    expect(result.stdout).not.toMatch(/(mount|bind|remount|unshareU|unshareM|chroot)=0/);
  });

  it("cannot trace or write another process memory (ptrace and /proc/<pid>/mem)", async () => {
    const result = completed(
      await sh(
        "sleep 30 & p=$!; echo x > /proc/$p/mem 2>&1; echo memwrite=$?; echo x > /proc/1/mem 2>&1; echo mem1=$?; cat /proc/1/environ >/dev/null 2>&1; echo environ1=$?; grep TracerPid /proc/self/status; cat /proc/sys/kernel/yama/ptrace_scope 2>&1",
      ),
    );
    expect(result.stdout).not.toContain("mem1=0");
    expect(result.stdout).toMatch(/TracerPid:\s+0/);
  });

  it("cannot write outside the scratch directories", async () => {
    const result = completed(
      await sh(
        'for p in / /bin /etc /usr /root /var /lib /proc /sys /dev; do touch $p/x 2>/dev/null; echo "$p=$?"; done; touch /work/ok; echo work=$?; touch /tmp/ok; echo tmp=$?',
      ),
    );
    for (const p of ["/bin", "/etc", "/usr", "/root", "/var", "/lib", "/proc", "/sys", "/dev"]) {
      expect(result.stdout).not.toContain(`${p}=0`);
    }
    expect(result.stdout).not.toMatch(/^\/=0$/m);
    expect(result.stdout).toContain("work=0");
    expect(result.stdout).toContain("tmp=0");
  });

  it("cannot write kernel interfaces in /proc/sys, /sys or /proc/sysrq-trigger", async () => {
    const probes = [
      "echo b > /proc/sysrq-trigger",
      "echo c > /proc/sysrq-trigger",
      "echo evil > /proc/sys/kernel/hostname",
      "echo /bin/sh > /proc/sys/kernel/core_pattern",
      "echo 1 > /proc/sys/vm/drop_caches",
      "echo 1 > /proc/sys/net/ipv4/ip_forward",
      "echo 0 > /proc/sys/kernel/randomize_va_space",
      "echo 1 > /sys/kernel/uevent_helper",
      "echo 1 > /sys/fs/cgroup/cgroup.procs",
      "echo max > /sys/fs/cgroup/memory.max",
      "echo max > /sys/fs/cgroup/pids.max",
      "echo 0 > /sys/class/net/lo/mtu",
      "echo 1 > /proc/sys/fs/binfmt_misc/register",
      "mkdir /sys/fs/cgroup/escape",
    ];
    const script = probes
      .map((p, i) => `(${p}) 2>/dev/null; echo "probe${String(i)}=$?"`)
      .join("; ");
    const result = completed(await sh(script));
    probes.forEach((_probe, i) => {
      expect(result.stdout, probes[i]).not.toContain(`probe${String(i)}=0`);
    });
    // still alive and unchanged after the writes
    expect((await sh("cat /proc/sys/kernel/hostname")).kind).toBe("completed");
  });

  it("cannot read kernel memory, host disks or raw devices", async () => {
    const result = completed(
      await sh(
        "cat /proc/kcore 2>&1 | head -c 16 | wc -c; ls /dev; ls /dev/sd* /dev/vd* /dev/nvme* /dev/mem /dev/kmem /dev/port 2>&1; cat /dev/mem 2>&1 | head -c 8 | wc -c",
      ),
    );
    expect(result.stdout).not.toMatch(/^\/dev\/(sd|vd|nvme)/m);
    expect(result.stdout).toMatch(/No such file/);
    // /proc/kcore is masked (empty) and /dev/mem is absent
    expect(result.stdout.split("\n")[0]?.trim()).toBe("0");
  });

  it("cannot create device nodes or change the clock", async () => {
    const result = completed(
      await sh(
        "mknod /work/null c 1 3 2>&1; echo mknod=$?; mknod /work/sda b 8 0 2>&1; echo mknodb=$?; date -s '2001-01-01' >/dev/null 2>&1; echo year=$(date +%Y)",
      ),
    );
    expect(result.stdout).not.toMatch(/mknod=0|mknodb=0/);
    expect(result.stdout).not.toContain("year=2001");
  });

  it("does not leak the worker's environment into the sandbox", async () => {
    const previous = process.env.AGO_ACCEPTANCE_SECRET;
    process.env.AGO_ACCEPTANCE_SECRET = "s3cr3t-value-should-not-leak";
    try {
      const result = completed(await sh("env; cat /proc/self/environ | tr '\\0' '\\n'"));
      expect(result.stdout).not.toContain("s3cr3t-value-should-not-leak");
    } finally {
      if (previous === undefined) delete process.env.AGO_ACCEPTANCE_SECRET;
      else process.env.AGO_ACCEPTANCE_SECRET = previous;
    }
  });
});

describe.skipIf(!ready.ok)("cleanup: no container is left behind", () => {
  async function expectNoContainer(req: SandboxRequest): Promise<void> {
    expect(await listSandboxContainers("docker", req.runId)).toEqual([]);
  }

  it("removes the container after a success", async () => {
    const req = request(["sh", "-c", "echo ok"]);
    expect(completed(await runner.run(req)).stdout).toBe("ok\n");
    await expectNoContainer(req);
  });

  it("removes the container after a non-zero exit", async () => {
    const req = request(["sh", "-c", "exit 9"]);
    expect(completed(await runner.run(req)).exitCode).toBe(9);
    await expectNoContainer(req);
  });

  it("removes the container after a timeout deny", async () => {
    const req = request(["sh", "-c", "sleep 60"], { limits: { timeoutMs: 1_000 } });
    expect(await runner.run(req)).toMatchObject({ kind: "denied", reason: "timeout" });
    await expectNoContainer(req);
  });

  it("removes the container after an output-limit deny", async () => {
    const req = request(["yes"], { limits: { outputBytes: 1_024 } });
    expect(await runner.run(req)).toMatchObject({ kind: "denied", reason: "output_limit" });
    await expectNoContainer(req);
  });

  it("removes the container after an out-of-memory deny", async () => {
    const req = request(["sh", "-c", "x=$(head -c 100000000 /dev/zero | tr '\\0' a)"], {
      limits: { memoryMb: 32 },
    });
    expect(await runner.run(req)).toMatchObject({ kind: "denied", reason: "out_of_memory" });
    await expectNoContainer(req);
  });

  it("removes the container after a crash: command not found", async () => {
    const req = request(["definitely-not-a-program"]);
    const result = await runner.run(req);
    expect(result.kind === "completed" ? result.exitCode : 0).not.toBe(0);
    await expectNoContainer(req);
  });

  it("removes the container after the program kills itself with a signal", async () => {
    const req = request(["sh", "-c", "kill -SEGV $$; sleep 1"]);
    const result = await runner.run(req);
    expect(["completed", "denied"]).toContain(result.kind);
    await expectNoContainer(req);
  });

  it("removes the container after an abort mid-run", async () => {
    const controller = new AbortController();
    const req = request(["sh", "-c", "sleep 60"], {
      signal: controller.signal,
      limits: { timeoutMs: 60_000 },
    });
    const pending = runner.run(req);
    setTimeout(() => {
      controller.abort();
    }, 1_500);
    expect(await pending).toMatchObject({ kind: "denied", reason: "aborted" });
    await expectNoContainer(req);
  });

  it("does not start a container when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const req = request(["sh", "-c", "echo hi"], { signal: controller.signal });
    expect(await runner.run(req)).toMatchObject({ kind: "denied", reason: "aborted" });
    await expectNoContainer(req);
  });

  it("removes every container of a burst of concurrent runs", async () => {
    const reqs = [0, 1, 2].map((i) => request(["sh", "-c", `echo ${String(i)}`]));
    await Promise.all(reqs.map((r) => runner.run(r)));
    for (const r of reqs) await expectNoContainer(r);
  });
});

describe("fail closed when Docker is unavailable", () => {
  it("denies with runtime_unavailable and never runs the command on the host", async () => {
    const marker = join(tmpdir(), `ago-acceptance-marker-${String(process.pid)}`);
    expect(existsSync(marker)).toBe(false);
    const result = await createDockerSandboxRunner({ dockerBinary: "docker-does-not-exist" }).run({
      workspaceId: "ws-acceptance",
      runId: "acc-failclosed",
      command: ["touch", marker],
    });
    expect(result).toMatchObject({ kind: "denied", reason: "runtime_unavailable" });
    expect(existsSync(marker)).toBe(false);
  });

  it("denies with runtime_unavailable when the image is missing", async () => {
    const result = await createDockerSandboxRunner({
      image: "ago-acceptance-no-such-image:never",
    }).run({ workspaceId: "ws-acceptance", runId: "acc-noimage", command: ["echo", "hi"] });
    // skip silently-passing: without docker at all this is still runtime_unavailable
    expect(result).toMatchObject({ kind: "denied", reason: "runtime_unavailable" });
  });

  it("denies with runtime_unavailable when the Docker daemon is unreachable", async () => {
    const previous = process.env.DOCKER_HOST;
    process.env.DOCKER_HOST = "tcp://127.0.0.1:1";
    try {
      const result = await createDockerSandboxRunner().run({
        workspaceId: "ws-acceptance",
        runId: "acc-nodaemon",
        command: ["echo", "hi"],
      });
      expect(result).toMatchObject({ kind: "denied", reason: "runtime_unavailable" });
    } finally {
      if (previous === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = previous;
    }
  }, 120_000);
});

describe("request validation edge cases (nothing reaches Docker)", () => {
  const neverRuns = createDockerSandboxRunner({ dockerBinary: "docker-does-not-exist" });
  const base = { workspaceId: "ws-acceptance", runId: "acc-validate" };

  it.each([
    ["an empty argv", []],
    ["an empty program name", [""]],
    ["a NUL byte in an argument", ["echo", "a\0b"]],
    ["an option-looking program", ["--privileged"]],
    ["a short option as program", ["-v"]],
    ["too many arguments", Array.from({ length: 65 }, () => "x")],
    ["an oversized argument", ["echo", "a".repeat(16_385)]],
  ])("denies %s as invalid_request", async (_name, command) => {
    expect(await neverRuns.run({ ...base, command })).toMatchObject({
      kind: "denied",
      reason: "invalid_request",
    });
  });

  it.each([
    ["a parent segment", "../escape"],
    ["a nested parent segment", "a/../../escape"],
    ["an absolute path", "/etc/passwd"],
    ["an empty segment", "a//b"],
    ["a dot segment", "./a"],
    ["a backslash", "a\\b"],
    ["a NUL byte", "a\0b"],
    ["an empty path", ""],
    ["a path over 200 chars", "a".repeat(201)],
  ])("denies an input file path with %s", async (_name, path) => {
    expect(
      await neverRuns.run({ ...base, command: ["cat"], files: [{ path, content: "x" }] }),
    ).toMatchObject({ kind: "denied", reason: "invalid_request" });
  });

  it("denies duplicate input file paths", async () => {
    const result = await neverRuns.run({
      ...base,
      command: ["cat"],
      files: [
        { path: "a.txt", content: "1" },
        { path: "a.txt", content: "2" },
      ],
    });
    expect(result).toMatchObject({ kind: "denied", reason: "invalid_request" });
  });

  it("denies more than 32 files and more than 1 MiB of input in total", async () => {
    const many = Array.from({ length: 33 }, (_v, i) => ({ path: `f${String(i)}`, content: "" }));
    expect(await neverRuns.run({ ...base, command: ["cat"], files: many })).toMatchObject({
      kind: "denied",
      reason: "invalid_request",
    });
    const big = await neverRuns.run({
      ...base,
      command: ["cat"],
      files: [
        { path: "a", content: "x".repeat(1_048_576) },
        { path: "b", content: "y" },
      ],
    });
    expect(big).toMatchObject({ kind: "denied", reason: "invalid_request" });
  });

  it("denies unsafe run and workspace ids (they end up in docker labels)", async () => {
    for (const runId of ["", "a b", "a=b", "x;y", "a".repeat(81), "../x"]) {
      expect(await neverRuns.run({ ...base, runId, command: ["echo"] })).toMatchObject({
        kind: "denied",
        reason: "invalid_request",
      });
    }
    expect(await neverRuns.run({ ...base, workspaceId: "ws id", command: ["echo"] })).toMatchObject(
      { kind: "denied", reason: "invalid_request" },
    );
  });
});

describe.skipIf(!ready.ok)("input files reach the scratch directory intact", () => {
  it("places unicode names and content byte for byte", async () => {
    const result = completed(
      await runner.run(
        request(["sh", "-c", "cat 'dir/é-日本.txt'; ls dir"], {
          files: [{ path: "dir/é-日本.txt", content: "héllo 🌍 שלום" }],
        }),
      ),
    );
    expect(result.stdout).toContain("héllo 🌍 שלום");
  });

  it("places a file of exactly 1 MiB", async () => {
    const result = completed(
      await runner.run(
        request(["sh", "-c", "wc -c < big.bin"], {
          files: [{ path: "big.bin", content: "z".repeat(1_048_576) }],
        }),
      ),
    );
    expect(result.stdout.trim()).toBe("1048576");
  });

  it("places a nested path longer than 100 bytes (ustar prefix split)", async () => {
    const path = `${"d".repeat(60)}/${"e".repeat(60)}/file.txt`;
    const result = completed(
      await runner.run(
        request(["sh", "-c", `cat ${path}`], { files: [{ path, content: "deep" }] }),
      ),
    );
    expect(result.stdout).toBe("deep");
  });

  it("does not throw out of run() for a single-segment name between 101 and 200 chars", async () => {
    const req = request(["sh", "-c", "ls"], {
      files: [{ path: "n".repeat(150), content: "x" }],
    });
    const result = await runner.run(req).catch((error: unknown) => ({ rejected: error }));
    expect(result).not.toHaveProperty("rejected");
    expect(await listSandboxContainers("docker", req.runId)).toEqual([]);
  });

  it("places a multibyte path under 200 chars but over 100 bytes without truncating its name", async () => {
    const path = `${"é".repeat(70)}.txt`; // 74 chars, 144 bytes
    const result = await runner.run(
      request(["sh", "-c", "ls"], { files: [{ path, content: "x" }] }),
    );
    expect(result.kind === "completed" ? result.stdout.trim() : "").toBe(path);
  });

  it("does not let a file in scratch be a symlink escape (a literal ../ name is refused up front)", async () => {
    const result = await runner.run(
      request(["sh", "-c", "ls -la /work"], { files: [{ path: "..hidden", content: "x" }] }),
    );
    expect(result.kind).toBe("completed");
  });
});

describe.skipIf(!ready.ok)("exit codes are not confused with sandbox denials", () => {
  it("reports a program's own exit 137 as completed, not as out_of_memory", async () => {
    const result = await sh("exit 137");
    expect(result).toMatchObject({ kind: "completed", exitCode: 137 });
  });

  it("reports a program's own exit 125 as completed, not as runtime_unavailable", async () => {
    const result = await sh("exit 125");
    expect(result).toMatchObject({ kind: "completed", exitCode: 125 });
  });
});

describe("run_code tool", () => {
  const context = {
    workspaceId: "ws-acceptance",
    runId: "acc-tool",
    agentId: "agent-1",
    signal: new AbortController().signal,
  };

  function spyRunner(): { runner: SandboxRunner; calls: SandboxRequest[] } {
    const calls: SandboxRequest[] = [];
    return {
      calls,
      runner: {
        run(req) {
          calls.push(req);
          return Promise.resolve({
            kind: "completed",
            exitCode: 0,
            stdout: "o",
            stderr: "e",
            durationMs: 1,
          });
        },
      },
    };
  }

  it("is a tier 3 tool needing the code.run capability and shows no limits field to the model", () => {
    const { runner: spy } = spyRunner();
    const tool = createRunCodeTool({ runner: spy });
    expect(tool).toMatchObject({ name: "run_code", tier: 3, capabilityKey: "code.run" });
    const props = (tool.modelInputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).sort()).toEqual(["command", "files"]);
    expect(tool.modelInputSchema).toMatchObject({ additionalProperties: false });
  });

  it.each([
    ["a limits field", { command: ["echo"], limits: { timeoutMs: 120000 } }],
    ["a limits field with lifted memory", { command: ["echo"], limits: { memoryMb: 1024 } }],
    ["an unknown field", { command: ["echo"], network: "host" }],
    ["a missing command", {}],
    ["an empty command array", { command: [] }],
    ["an empty program string", { command: [""] }],
    ["a command that is a string", { command: "echo hi" }],
    ["a non-string argument", { command: ["echo", 1] }],
    ["more than 64 arguments", { command: Array.from({ length: 65 }, () => "x") }],
    [
      "more than 32 files",
      {
        command: ["cat"],
        files: Array.from({ length: 33 }, (_v, i) => ({ path: `f${String(i)}`, content: "" })),
      },
    ],
    [
      "a file with an extra field",
      { command: ["cat"], files: [{ path: "a", content: "", mode: "4755" }] },
    ],
    ["a file without content", { command: ["cat"], files: [{ path: "a" }] }],
    [
      "a content over 1 MiB",
      { command: ["cat"], files: [{ path: "a", content: "x".repeat(1_048_577) }] },
    ],
    ["null input", null],
    ["an array input", [["echo"]]],
  ])("rejects input with %s and never calls the runner", async (_name, input) => {
    const { runner: spy, calls } = spyRunner();
    const tool = createRunCodeTool({ runner: spy });
    await expect(tool.execute(input, context)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("passes the worker's limits, not the model's, and the run's identity and signal to the runner", async () => {
    const { runner: spy, calls } = spyRunner();
    const tool = createRunCodeTool({ runner: spy, limits: { timeoutMs: 2_000 } });
    const output = await tool.execute({ command: ["echo", "x"] }, context);
    expect(output).toBe("exit_code: 0\nstdout:\no\nstderr:\ne");
    expect(calls[0]).toMatchObject({
      workspaceId: "ws-acceptance",
      runId: "acc-tool",
      command: ["echo", "x"],
      limits: { timeoutMs: 2_000 },
      signal: context.signal,
    });
  });

  it.each([
    ["timeout", { kind: "denied", reason: "timeout", message: "too slow", durationMs: 1 }],
    [
      "out_of_memory",
      { kind: "denied", reason: "out_of_memory", message: "too big", durationMs: 1 },
    ],
    [
      "runtime_unavailable",
      { kind: "denied", reason: "runtime_unavailable", message: "no docker", durationMs: 1 },
    ],
  ] as const)("throws a SandboxDeniedError for a %s deny", async (reason, denial) => {
    const tool = createRunCodeTool({
      runner: { run: () => Promise.resolve(denial) },
    });
    const error = await tool.execute({ command: ["echo"] }, context).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxDeniedError);
    expect(error).toMatchObject({ reason });
    expect((error as Error).message).toContain(`sandbox_denied (${reason})`);
  });

  it.skipIf(!ready.ok)(
    "throws a SandboxDeniedError end to end when a real call times out",
    async () => {
      const tool = createRunCodeTool({ runner, limits: { timeoutMs: 1_000 } });
      const error = await tool
        .execute({ command: ["sh", "-c", "sleep 60"] }, { ...context, runId: "acc-tool-real" })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxDeniedError);
      expect(error).toMatchObject({ reason: "timeout" });
      expect(await listSandboxContainers("docker", "acc-tool-real")).toEqual([]);
    },
  );

  it.skipIf(!ready.ok)("returns a non-zero exit as output, not as a deny", async () => {
    const tool = createRunCodeTool({ runner });
    const output = await tool.execute(
      { command: ["sh", "-c", "echo hi; exit 2"] },
      { ...context, runId: "acc-tool-exit2" },
    );
    expect(output).toBe("exit_code: 2\nstdout:\nhi\n\nstderr:\n");
  });
});

afterAll(async () => {
  if (!ready.ok) return;
  for (const runId of runIds) {
    expect(await listSandboxContainers("docker", runId)).toEqual([]);
  }
});
