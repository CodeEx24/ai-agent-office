import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { connect, createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_SANDBOX_LIMITS, validateSandboxRequest } from "../sandbox/sandbox-runner.js";
import { DENY_ALL_EGRESS, createFileEgressAllowlistProvider } from "./allowlist-config.js";
import { createEgressProxy, type EgressDecisionLine } from "./egress-proxy.js";

// Functional acceptance tests for AGO-65, written from the acceptance criteria and the ticket's edge cases,
// black-box through the proxy's public factory. A stub resolver and local servers stand in for the internet.

const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

async function recordingTarget(): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { port: (server.address() as AddressInfo).port, seen };
}

/** Accepts TCP and then says nothing (or drips a byte now and then). */
async function stallingTarget(dripMs?: number): Promise<{ port: number; accepted: () => number }> {
  let accepted = 0;
  const sockets: Socket[] = [];
  const timers: NodeJS.Timeout[] = [];
  const server = createNetServer((socket) => {
    accepted += 1;
    sockets.push(socket);
    socket.on("error", () => undefined);
    if (dripMs !== undefined) timers.push(setInterval(() => socket.write("x"), dripMs));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => {
    timers.forEach(clearInterval);
    sockets.forEach((s) => s.destroy());
    server.close();
  });
  return { port: (server.address() as AddressInfo).port, accepted: () => accepted };
}

interface Options {
  hosts?: string[];
  ports?: number[];
  answers?: Record<string, string[]>;
  allowLoopback?: boolean;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  resolveTimeoutMs?: number;
  maxConnections?: number;
  maxHeaderBytes?: number;
  resolve?: (host: string) => Promise<readonly string[]>;
}

async function startProxy(options: Options = {}): Promise<{
  port: number;
  logs: EgressDecisionLine[];
  lookups: string[];
}> {
  const logs: EgressDecisionLine[] = [];
  const lookups: string[] = [];
  const answers = options.answers ?? {};
  const server = createEgressProxy({
    runId: "run-acc",
    workspaceId: "ws-acc",
    hosts: options.hosts ?? ["allowed.test"],
    ports: options.ports ?? [80, 443],
    log: (line) => logs.push(line),
    resolve:
      options.resolve ??
      ((host) => {
        lookups.push(host);
        return Promise.resolve(answers[host] ?? []);
      }),
    ...(options.allowLoopback === true ? { unsafeAllowAddressesForTests: ["127.0.0.1"] } : {}),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    ...(options.totalTimeoutMs === undefined ? {} : { totalTimeoutMs: options.totalTimeoutMs }),
    ...(options.resolveTimeoutMs === undefined
      ? {}
      : { resolveTimeoutMs: options.resolveTimeoutMs }),
    ...(options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections }),
    ...(options.maxHeaderBytes === undefined ? {} : { maxHeaderBytes: options.maxHeaderBytes }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { port: (server.address() as AddressInfo).port, logs, lookups };
}

/** Sends raw bytes to the proxy and returns everything it answers until it closes (or 3 s pass). */
function send(port: number, request: string, waitMs = 3000): Promise<string> {
  return new Promise<string>((resolve) => {
    let received = "";
    const socket = connect(port, "127.0.0.1", () => socket.write(request));
    socket.setTimeout(waitMs, () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      resolve(received);
    });
  });
}

const get = (url: string, host: string, extra = ""): string =>
  `GET ${url} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`;
const connectTo = (target: string): string => `CONNECT ${target} HTTP/1.1\r\n\r\n`;
const status = (response: string): string => response.split("\r\n")[0] ?? "";
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("AC1 blocked and logged: host names", () => {
  it("matches case, trailing dot and punycode the same way for the allowlist entry and the request", async () => {
    const target = await recordingTarget();
    const p = await startProxy({
      hosts: ["bücher.example", "*.Example.COM"],
      ports: [target.port],
      answers: {
        "xn--bcher-kva.example": ["127.0.0.1"],
        "a.example.com": ["127.0.0.1"],
      },
      allowLoopback: true,
    });
    const host = (h: string): string => `${h}:${String(target.port)}`;
    // Clients send IDNs as punycode; the allowlist entry "bücher.example" is normalised to the same form.
    const ok = [
      "XN--BCHER-KVA.EXAMPLE.",
      "xn--bcher-kva.example",
      "A.Example.COM.",
      "a.EXAMPLE.com",
    ];
    for (const name of ok) {
      const response = await send(p.port, get(`http://${host(name)}/`, host(name)));
      expect(status(response), name).toBe("HTTP/1.1 200 OK");
    }
    expect(target.seen).toHaveLength(ok.length);
  });

  it("blocks the apex of a wildcard, lookalikes, suffix and prefix tricks, and exact entries' subdomains", async () => {
    const target = await recordingTarget();
    const p = await startProxy({
      hosts: ["exact.example", "*.wild.example"],
      ports: [target.port],
      answers: { "exact.example": ["127.0.0.1"], "x.wild.example": ["127.0.0.1"] },
      allowLoopback: true,
    });
    const blocked = [
      "wild.example",
      "wild.example.",
      "notwild.example",
      "x.wild.example.evil.test",
      "wild.example.evil.test",
      "sub.exact.example",
      "xexact.example",
      "exact.example.evil.test",
      "evil.test",
    ];
    for (const name of blocked) {
      const target_ = `${name}:${String(target.port)}`;
      const response = await send(p.port, get(`http://${target_}/`, target_));
      expect(status(response), name).toBe("HTTP/1.1 403 Forbidden");
    }
    expect(target.seen).toHaveLength(0);
    expect(p.logs).toHaveLength(blocked.length);
    expect(
      p.logs.every((l) => l.event === "egress.blocked" && l.reason === "not_allowlisted"),
    ).toBe(true);
  });

  it("never looks up a blocked name or port, so a blocked request cannot leak through DNS", async () => {
    const p = await startProxy({ ports: [80] });
    await send(p.port, get("http://evil.test/", "evil.test"));
    await send(p.port, get("http://secret-data.evil.test/", "secret-data.evil.test"));
    await send(p.port, connectTo("evil.test:443"));
    await send(p.port, get("http://allowed.test:8080/", "allowed.test:8080"));
    await send(p.port, connectTo("allowed.test:22"));
    expect(p.lookups).toEqual([]);
    expect(p.logs.map((l) => l.reason)).toEqual([
      "not_allowlisted",
      "not_allowlisted",
      "not_allowlisted",
      "port_not_allowed",
      "port_not_allowed",
    ]);
  });

  it("rejects userinfo tricks, IP literals in every notation, and malformed CONNECT targets", async () => {
    const target = await recordingTarget();
    const p = await startProxy({ ports: [target.port, 80, 443] });
    const plain = [
      `http://allowed.test@evil.test:${String(target.port)}/`,
      `http://allowed.test:pw@127.0.0.1:${String(target.port)}/`,
      `http://127.0.0.1:${String(target.port)}/`,
      `http://2130706433:${String(target.port)}/`,
      `http://0x7f.1:${String(target.port)}/`,
      `http://[::1]:${String(target.port)}/`,
      `http://169.254.169.254:${String(target.port)}/latest/meta-data/`,
    ];
    for (const url of plain) {
      const response = await send(p.port, get(url, "allowed.test"));
      expect(status(response), url).toMatch(/^HTTP\/1\.1 (400|403) /);
    }
    for (const t of [
      "allowed.test@evil.test:443",
      "127.0.0.1:443",
      "2130706433:443",
      "[::1]:443",
      "allowed.test",
      ":443",
      "allowed.test:",
    ]) {
      const response = await send(p.port, connectTo(t));
      expect(status(response), t).toMatch(/^HTTP\/1\.1 (400|403) /);
    }
    expect(target.seen).toHaveLength(0);
    expect(p.lookups).toEqual([]);
    expect(p.logs.length).toBeGreaterThanOrEqual(plain.length + 7);
    expect(p.logs.every((l) => l.event === "egress.blocked")).toBe(true);
  });

  it("refuses raw non-ASCII bytes in the request (fail closed) and logs only ASCII host names", async () => {
    const target = await recordingTarget();
    const p = await startProxy({
      hosts: ["bücher.example"],
      ports: [target.port],
      answers: { "xn--bcher-kva.example": ["127.0.0.1"] },
      allowLoopback: true,
    });
    const raw = `bücher.example:${String(target.port)}`;
    const response = await send(p.port, get(`http://${raw}/`, raw));
    expect(status(response)).toBe("HTTP/1.1 400 Bad Request");
    expect(target.seen).toHaveLength(0);
    expect(p.logs.length).toBeGreaterThanOrEqual(1);
    for (const line of p.logs) expect(/^[\x21-\x7e]*$/.test(line.host)).toBe(true);
  });
});

describe("AC1 blocked and logged: addresses an allowlisted name resolves to", () => {
  const PRIVATE = [
    "127.0.0.1",
    "127.255.255.254",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "169.254.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "2002:7f00:1::1",
  ];

  it.each(PRIVATE)(
    "blocks %s for plain HTTP and for CONNECT, and logs private_address",
    async (address) => {
      const p = await startProxy({ answers: { "allowed.test": [address] } });
      const plain = await send(p.port, get("http://allowed.test/", "allowed.test"));
      const tunnel = await send(p.port, connectTo("allowed.test:443"));
      expect(status(plain)).toBe("HTTP/1.1 403 Forbidden");
      expect(status(tunnel)).toBe("HTTP/1.1 403 Forbidden");
      expect(tunnel).toContain("X-Egress-Reason: private_address");
      expect(p.logs.map((l) => [l.event, l.reason, l.host])).toEqual([
        ["egress.blocked", "private_address", "allowed.test"],
        ["egress.blocked", "private_address", "allowed.test"],
      ]);
    },
  );

  it.each([
    ["public first", ["93.184.216.34", "10.0.0.1"]],
    ["private first", ["10.0.0.1", "93.184.216.34"]],
    ["metadata hidden in the middle", ["93.184.216.34", "169.254.169.254", "93.184.216.35"]],
    ["IPv6 private after a public IPv4", ["93.184.216.34", "fd00::1"]],
  ])("blocks a name with mixed answers (%s)", async (_name, answers) => {
    const p = await startProxy({ answers: { "allowed.test": answers } });
    expect(status(await send(p.port, get("http://allowed.test/", "allowed.test")))).toBe(
      "HTTP/1.1 403 Forbidden",
    );
    expect(p.logs[0]?.reason).toBe("private_address");
  });

  it("blocks when the name does not resolve, resolves to nothing, or the resolver throws or hangs", async () => {
    const hang = await startProxy({
      resolveTimeoutMs: 100,
      resolve: () => new Promise<never>(() => undefined),
    });
    const boom = await startProxy({ resolve: () => Promise.reject(new Error("SERVFAIL")) });
    const none = await startProxy({ answers: { "allowed.test": [] } });
    for (const p of [hang, boom, none]) {
      expect(status(await send(p.port, get("http://allowed.test/", "allowed.test")))).toBe(
        "HTTP/1.1 403 Forbidden",
      );
      expect(status(await send(p.port, connectTo("allowed.test:443")))).toBe(
        "HTTP/1.1 403 Forbidden",
      );
      expect(p.logs.map((l) => l.reason)).toEqual(["resolve_failed", "resolve_failed"]);
    }
  });

  it("connects to the address it checked and resolves the name exactly once per request", async () => {
    const target = await recordingTarget();
    const p = await startProxy({
      ports: [target.port],
      answers: { "allowed.test": ["127.0.0.1"] },
      allowLoopback: true,
    });
    const host = `allowed.test:${String(target.port)}`;
    await send(p.port, get(`http://${host}/x`, host));
    expect(p.lookups).toEqual(["allowed.test"]);
    expect(target.seen[0]?.headers.host).toBe(host);
  });
});

describe("AC1 blocked and logged: ports and CONNECT", () => {
  it.each([
    "allowed.test:22",
    "allowed.test:25",
    "allowed.test:8080",
    "allowed.test:0",
    "allowed.test:65535",
    "allowed.test:65536",
    "allowed.test:99999",
  ])(
    "blocks CONNECT to the allowlisted host on a port that is not allowed (%s)",
    async (target) => {
      const p = await startProxy({ ports: [443], answers: { "allowed.test": ["93.184.216.34"] } });
      const response = await send(p.port, connectTo(target));
      expect(status(response)).toBe("HTTP/1.1 403 Forbidden");
      expect(p.logs[0]?.reason).toBe("port_not_allowed");
      expect(p.logs[0]?.method).toBe("CONNECT");
    },
  );

  it("blocks plain HTTP to a port outside the list, including the default port 80 when only 443 is allowed", async () => {
    const p = await startProxy({ ports: [443], answers: { "allowed.test": ["93.184.216.34"] } });
    expect(status(await send(p.port, get("http://allowed.test/", "allowed.test")))).toBe(
      "HTTP/1.1 403 Forbidden",
    );
    expect(status(await send(p.port, get("http://allowed.test:8443/", "allowed.test:8443")))).toBe(
      "HTTP/1.1 403 Forbidden",
    );
    expect(p.logs.map((l) => [l.port, l.reason])).toEqual([
      [80, "port_not_allowed"],
      [8443, "port_not_allowed"],
    ]);
  });

  it("denies everything on an empty host list and on an empty port list", async () => {
    const noHosts = await startProxy({ hosts: [], answers: { "allowed.test": ["93.184.216.34"] } });
    const noPorts = await startProxy({ ports: [], answers: { "allowed.test": ["93.184.216.34"] } });
    for (const p of [noHosts, noPorts]) {
      expect(status(await send(p.port, get("http://allowed.test/", "allowed.test")))).toBe(
        "HTTP/1.1 403 Forbidden",
      );
      expect(status(await send(p.port, connectTo("allowed.test:443")))).toBe(
        "HTTP/1.1 403 Forbidden",
      );
      expect(p.logs).toHaveLength(2);
    }
  });

  it("does not let a CONNECT to a blocked host reach any upstream, and does not tunnel after a 403", async () => {
    const stall = await stallingTarget();
    const p = await startProxy({
      ports: [stall.port],
      answers: { "allowed.test": ["127.0.0.1"] },
      allowLoopback: true,
    });
    const response = await send(
      p.port,
      `CONNECT evil.test:${String(stall.port)} HTTP/1.1\r\n\r\nGET / HTTP/1.1\r\nHost: allowed.test\r\n\r\n`,
    );
    expect(status(response)).toBe("HTTP/1.1 403 Forbidden");
    expect(stall.accepted()).toBe(0);
  });
});

describe("AC1 blocked and logged: timeout means deny", () => {
  it("denies a plain request whose upstream accepts and never answers (504, logged as timeout)", async () => {
    const stall = await stallingTarget();
    const p = await startProxy({
      ports: [stall.port],
      answers: { "allowed.test": ["127.0.0.1"] },
      allowLoopback: true,
      idleTimeoutMs: 150,
    });
    const host = `allowed.test:${String(stall.port)}`;
    const response = await send(p.port, get(`http://${host}/`, host));
    expect(status(response)).toBe("HTTP/1.1 504 Gateway Timeout");
    expect(p.logs.map((l) => l.reason)).toContain("timeout");
  });

  it("closes an idle CONNECT tunnel and logs timeout", async () => {
    const stall = await stallingTarget();
    const p = await startProxy({
      ports: [stall.port],
      answers: { "allowed.test": ["127.0.0.1"] },
      allowLoopback: true,
      idleTimeoutMs: 150,
    });
    const response = await send(p.port, connectTo(`allowed.test:${String(stall.port)}`), 2000);
    expect(status(response)).toBe("HTTP/1.1 200 Connection Established");
    await sleep(50);
    expect(p.logs.map((l) => l.reason)).toEqual([undefined, "timeout"]);
  });

  it("cuts a tunnel that keeps trickling bytes once the total time is up (idle alone would never fire)", async () => {
    const drip = await stallingTarget(40);
    const p = await startProxy({
      ports: [drip.port],
      answers: { "allowed.test": ["127.0.0.1"] },
      allowLoopback: true,
      idleTimeoutMs: 5000,
      totalTimeoutMs: 400,
    });
    const started = Date.now();
    await send(p.port, connectTo(`allowed.test:${String(drip.port)}`), 4000);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(p.logs.map((l) => l.reason)).toContain("timeout");
  });
});

describe("caps: connections and header size", () => {
  it("drops connections over the cap and logs too_many_connections", async () => {
    const p = await startProxy({ maxConnections: 2 });
    const held: Socket[] = [];
    for (let i = 0; i < 4; i += 1) {
      const socket = connect(p.port, "127.0.0.1");
      socket.on("error", () => undefined);
      held.push(socket);
    }
    closers.push(() => {
      held.forEach((s) => s.destroy());
    });
    await sleep(300);
    expect(p.logs.filter((l) => l.reason === "too_many_connections").length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("refuses an oversized header block without forwarding anything", async () => {
    const target = await recordingTarget();
    const p = await startProxy({
      ports: [target.port],
      answers: { "allowed.test": ["127.0.0.1"] },
      allowLoopback: true,
      maxHeaderBytes: 1024,
    });
    const host = `allowed.test:${String(target.port)}`;
    const response = await send(
      p.port,
      get(`http://${host}/`, host, `X-Big: ${"a".repeat(4096)}\r\n`),
    );
    expect(status(response)).toMatch(/^HTTP\/1\.1 4\d\d /);
    expect(target.seen).toHaveLength(0);
    expect(p.logs.map((l) => l.reason)).toContain("bad_request");
  });

  it("refuses an ambiguous request that carries both Content-Length and Transfer-Encoding", async () => {
    const target = await recordingTarget();
    const p = await startProxy({
      ports: [target.port],
      answers: { "allowed.test": ["127.0.0.1"] },
      allowLoopback: true,
    });
    const host = `allowed.test:${String(target.port)}`;
    const response = await send(
      p.port,
      `POST http://${host}/ HTTP/1.1\r\nHost: ${host}\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\nGET http://evil.test/ HTTP/1.1\r\nHost: evil.test\r\n\r\n`,
    );
    expect(response).not.toContain("200 OK");
    expect(target.seen.filter((s) => s.url.includes("evil"))).toHaveLength(0);
  });

  it("does not support protocol upgrades (no WebSocket side door over plain HTTP)", async () => {
    const target = await recordingTarget();
    const p = await startProxy({
      ports: [target.port],
      answers: { "allowed.test": ["127.0.0.1"] },
      allowLoopback: true,
    });
    const host = `allowed.test:${String(target.port)}`;
    const response = await send(
      p.port,
      get(`http://${host}/`, host, "Upgrade: websocket\r\nConnection: Upgrade\r\n"),
    );
    expect(response).not.toContain("101");
    expect(target.seen.filter((s) => s.headers.upgrade !== undefined)).toHaveLength(0);
  });
});

describe("log content: fields present, no bodies, credential headers or query strings", () => {
  const SECRETS = [
    "SECRET-QUERY-TOKEN",
    "hunter2",
    "SECRET-BEARER",
    "SECRET-COOKIE",
    "c2VjcmV0cHJveHk",
    "SECRET-BODY",
    "x-api-key-SECRET",
  ];

  it("logs exactly the documented fields for allowed and blocked requests, plain and CONNECT, and nothing else", async () => {
    const target = await recordingTarget();
    const p = await startProxy({
      ports: [target.port],
      answers: { "allowed.test": ["127.0.0.1"], "evil.test": ["93.184.216.34"] },
      allowLoopback: true,
    });
    const creds =
      "Authorization: Bearer SECRET-BEARER\r\nCookie: session=SECRET-COOKIE\r\nProxy-Authorization: Basic c2VjcmV0cHJveHk=\r\nX-Api-Key: x-api-key-SECRET\r\n";
    const query = "?token=SECRET-QUERY-TOKEN&password=hunter2";
    const allowedHost = `allowed.test:${String(target.port)}`;
    const evilHost = `evil.test:${String(target.port)}`;
    const body = "SECRET-BODY";
    await send(
      p.port,
      `POST http://${allowedHost}/login${query} HTTP/1.1\r\nHost: ${allowedHost}\r\n${creds}Content-Length: ${String(body.length)}\r\nConnection: close\r\n\r\n${body}`,
    );
    await send(
      p.port,
      `POST http://${evilHost}/login${query} HTTP/1.1\r\nHost: ${evilHost}\r\n${creds}Content-Length: ${String(body.length)}\r\nConnection: close\r\n\r\n${body}`,
    );
    await send(p.port, `CONNECT evil.test:${String(target.port)} HTTP/1.1\r\n${creds}\r\n`);
    await send(p.port, `CONNECT allowed.test:${String(target.port)} HTTP/1.1\r\n${creds}\r\n`, 500);

    expect(p.logs.length).toBeGreaterThanOrEqual(4);
    const serialised = JSON.stringify(p.logs);
    for (const secret of SECRETS) expect(serialised).not.toContain(secret);
    expect(serialised).not.toMatch(/login|token=|password/);
    for (const line of p.logs) {
      expect(Object.keys(line).sort()).toEqual(
        line.event === "egress.blocked"
          ? ["event", "host", "method", "port", "reason", "run_id", "workspace_id"]
          : ["event", "host", "method", "port", "run_id", "workspace_id"],
      );
      expect(line.run_id).toBe("run-acc");
      expect(line.workspace_id).toBe("ws-acc");
      expect(line.port).toBe(target.port);
    }
    expect(p.logs[0]).toEqual({
      event: "egress.allowed",
      run_id: "run-acc",
      workspace_id: "ws-acc",
      host: "allowed.test",
      port: target.port,
      method: "POST",
    });
    expect(p.logs[1]).toEqual({
      event: "egress.blocked",
      run_id: "run-acc",
      workspace_id: "ws-acc",
      host: "evil.test",
      port: target.port,
      method: "POST",
      reason: "not_allowlisted",
    });
  });

  it("forwards the client's own credentials to the allowed server but never the proxy credentials", async () => {
    const target = await recordingTarget();
    const p = await startProxy({
      ports: [target.port],
      answers: { "allowed.test": ["127.0.0.1"] },
      allowLoopback: true,
    });
    const host = `allowed.test:${String(target.port)}`;
    await send(
      p.port,
      get(
        `http://${host}/`,
        host,
        "Authorization: Bearer abc\r\nProxy-Authorization: Basic eHl6\r\n",
      ),
    );
    expect(target.seen[0]?.headers.authorization).toBe("Bearer abc");
    expect(target.seen[0]?.headers["proxy-authorization"]).toBeUndefined();
  });

  it("a throwing log sink never turns a block into an allow", async () => {
    const target = await recordingTarget();
    const server = createEgressProxy({
      runId: "r",
      workspaceId: "w",
      hosts: ["allowed.test"],
      ports: [target.port],
      log: () => {
        throw new Error("sink down");
      },
      resolve: () => Promise.resolve(["127.0.0.1"]),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => {
      server.closeAllConnections();
      server.close();
    });
    const port = (server.address() as AddressInfo).port;
    const host = `evil.test:${String(target.port)}`;
    expect(status(await send(port, get(`http://${host}/`, host)))).toBe("HTTP/1.1 403 Forbidden");
    expect(target.seen).toHaveLength(0);
  });
});

describe("AC1 allowlist file on disk: empty, missing and invalid all deny", () => {
  async function inTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "ago-egress-"));
    closers.push(() => rm(dir, { recursive: true, force: true }));
    return body(dir);
  }
  const provider = (path: string | undefined, warnings: string[] = []) =>
    createFileEgressAllowlistProvider({ path, warn: (m) => warnings.push(m) });
  const valid = { version: 1, workspaces: { w1: { hosts: ["a.example.com"], ports: [443] } } };

  it("reads a real file, and re-reads it so an edit applies to the next call", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "egress.json");
      await writeFile(path, JSON.stringify(valid));
      const p = provider(path);
      expect(await p.forWorkspace("w1")).toEqual({ hosts: ["a.example.com"], ports: [443] });
      await writeFile(
        path,
        JSON.stringify({ version: 1, workspaces: { w1: { hosts: ["b.example.com"] } } }),
      );
      expect(await p.forWorkspace("w1")).toEqual({ hosts: ["b.example.com"], ports: [80, 443] });
      await writeFile(path, "{ broken");
      expect(await p.forWorkspace("w1")).toEqual(DENY_ALL_EGRESS);
      await rm(path);
      expect(await p.forWorkspace("w1")).toEqual(DENY_ALL_EGRESS);
    });
  });

  it("denies for no path, a missing file, a directory, an empty file and a null/array/scalar document, warning each time", async () => {
    await inTempDir(async (dir) => {
      await mkdir(join(dir, "adir"));
      const files: [string, string][] = [
        ["empty.json", ""],
        ["null.json", "null"],
        ["array.json", "[]"],
        ["scalar.json", "42"],
        ["string.json", '"hosts"'],
        ["emptyobj.json", "{}"],
      ];
      for (const [name, text] of files) await writeFile(join(dir, name), text);
      const paths = [
        undefined,
        join(dir, "missing.json"),
        join(dir, "adir"),
        ...files.map(([n]) => join(dir, n)),
      ];
      for (const path of paths) {
        const warnings: string[] = [];
        expect(await provider(path, warnings).forWorkspace("w1"), String(path)).toEqual(
          DENY_ALL_EGRESS,
        );
        if (path !== undefined) expect(warnings.length, path).toBeGreaterThanOrEqual(1);
      }
    });
  });

  it("denies when a field widens the policy or a value has the wrong type, including prototype-pollution keys", async () => {
    await inTempDir(async (dir) => {
      const bad: unknown[] = [
        { version: 1, workspaces: { w1: { hosts: "a.example.com" } } },
        { version: 1, workspaces: { w1: { hosts: ["a.example.com", 5] } } },
        { version: 1, workspaces: { w1: { hosts: ["a.example.com"], ports: ["443"] } } },
        { version: 1, workspaces: { w1: { hosts: ["a.example.com"], ports: [] } } },
        { version: 1, workspaces: { w1: { hosts: ["a.example.com"], ports: [443.5] } } },
        { version: 1, workspaces: { w1: { hosts: ["a.example.com"], ports: [65536] } } },
        { version: 1, workspaces: { w1: { hosts: ["*"] } } },
        { version: 1, workspaces: { w1: { hosts: ["*.com"] } } },
        { version: 1, workspaces: { w1: { hosts: ["10.0.0.1"] } } },
        { version: 1, workspaces: { w1: { hosts: ["169.254.169.254"] } } },
        { version: 1, workspaces: { w1: { hosts: ["http://a.example.com"] } } },
        { version: 1, workspaces: { w1: { hosts: ["a.example.com:443"] } } },
        { version: 1, workspaces: { w1: { hosts: ["a.example.com"], allowPrivate: true } } },
        { version: 1, workspaces: { w1: { hosts: ["a.example.com"] } }, allowAll: true },
        { version: "1", workspaces: {} },
        { workspaces: { w1: { hosts: ["a.example.com"] } } },
      ];
      for (const [i, doc] of bad.entries()) {
        const path = join(dir, `bad-${String(i)}.json`);
        await writeFile(path, JSON.stringify(doc));
        expect(await provider(path).forWorkspace("w1"), JSON.stringify(doc)).toEqual(
          DENY_ALL_EGRESS,
        );
      }
      const pollution = join(dir, "pollution.json");
      await writeFile(
        pollution,
        '{"version":1,"workspaces":{"__proto__":{"hosts":["evil.example.com"]}}}',
      );
      for (const id of ["w1", "__proto__", "constructor"]) {
        expect(await provider(pollution).forWorkspace(id), id).toEqual(DENY_ALL_EGRESS);
      }
    });
  });

  it("denies a workspace that is not listed even when others are", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "egress.json");
      await writeFile(path, JSON.stringify(valid));
      expect(await provider(path).forWorkspace("someone-else")).toEqual(DENY_ALL_EGRESS);
    });
  });

  it("a UTF-8 byte order mark (Windows editors add one) still fails closed", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "bom.json");
      await writeFile(path, String.fromCharCode(0xfeff) + JSON.stringify(valid));
      const warnings: string[] = [];
      const result = await provider(path, warnings).forWorkspace("w1");
      // Either it is accepted or it denies with a warning. It must never throw or allow something else.
      expect([DENY_ALL_EGRESS, { hosts: ["a.example.com"], ports: [443] }]).toContainEqual(result);
    });
  });
});

describe("sandbox request validation of the egress list", () => {
  const base = {
    workspaceId: "ws",
    runId: "r1",
    command: ["true"],
    limits: DEFAULT_SANDBOX_LIMITS,
  };
  const reasons = (egress: unknown): string | undefined =>
    validateSandboxRequest({ ...base, egress } as Parameters<typeof validateSandboxRequest>[0]);

  it("accepts a normal list and the empty (deny all) list", () => {
    expect(
      reasons({ hosts: ["a.example.com", "*.b.example.com"], ports: [80, 443] }),
    ).toBeUndefined();
    expect(reasons({ hosts: [], ports: [] })).toBeUndefined();
  });

  it.each([
    [
      "too many hosts",
      { hosts: Array.from({ length: 201 }, (_, i) => `h${String(i)}.example.com`), ports: [443] },
    ],
    [
      "too many ports",
      { hosts: ["a.example.com"], ports: Array.from({ length: 11 }, (_, i) => 1000 + i) },
    ],
    ["a TLD wildcard", { hosts: ["*.com"], ports: [443] }],
    ["a bare wildcard", { hosts: ["*"], ports: [443] }],
    ["an IP literal", { hosts: ["10.0.0.1"], ports: [443] }],
    ["a fractional port", { hosts: ["a.example.com"], ports: [80.5] }],
    ["port zero", { hosts: ["a.example.com"], ports: [0] }],
    ["a string port", { hosts: ["a.example.com"], ports: ["443"] }],
    ["a host with a path", { hosts: ["a.example.com/x"], ports: [443] }],
  ])("rejects %s with a typed invalid-request message", (_name, egress) => {
    expect(reasons(egress)).toMatch(/egress/i);
  });
});
