import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo, type Server } from "node:net";

import { EGRESS_BLOCK_REASONS } from "@ago/shared";
import { afterEach, describe, expect, it } from "vitest";

import {
  compileAllowlist,
  createEgressProxy,
  isBlockedAddress,
  isHostAllowed,
  normalizeHost,
  type EgressBlockReasonCode,
  type EgressDecisionLine,
} from "./egress-proxy.js";

describe("normalizeHost", () => {
  it.each([
    ["Example.COM", "example.com"],
    ["example.com.", "example.com"],
    ["  api.example.com  ", "api.example.com"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["XN--BCHER-KVA.example", "xn--bcher-kva.example"],
  ])("normalises %s", (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });

  it.each([
    "",
    ".",
    "127.0.0.1",
    "2130706433",
    "0x7f000001",
    "0177.0.0.1",
    "[::1]",
    "::1",
    "example.com:80",
    "user@example.com",
    "example.com/path",
    "a..b.com",
    "-bad.example.com",
    "exa mple.com",
    "*.example.com",
    "example.123",
    `${"a".repeat(64)}.example.com`,
  ])("rejects %j", (input) => {
    expect(normalizeHost(input)).toBeUndefined();
  });
});

describe("allowlist matching", () => {
  const list = compileAllowlist(["Example.com", "*.Api.Example.org", "bücher.example"]);

  it("matches an exact host after normalisation", () => {
    expect(isHostAllowed(list, "example.com")).toBe(true);
    expect(isHostAllowed(list, normalizeHost("EXAMPLE.com.") ?? "")).toBe(true);
    expect(isHostAllowed(list, "xn--bcher-kva.example")).toBe(true);
  });

  it("does not let an exact entry match subdomains or lookalikes", () => {
    expect(isHostAllowed(list, "www.example.com")).toBe(false);
    expect(isHostAllowed(list, "example.com.evil.test")).toBe(false);
    expect(isHostAllowed(list, "evilexample.com")).toBe(false);
  });

  it("matches wildcard subdomains but never the apex or a lookalike", () => {
    expect(isHostAllowed(list, "a.api.example.org")).toBe(true);
    expect(isHostAllowed(list, "a.b.api.example.org")).toBe(true);
    expect(isHostAllowed(list, "api.example.org")).toBe(false);
    expect(isHostAllowed(list, "xapi.example.org")).toBe(false);
    expect(isHostAllowed(list, "api.example.org.evil.test")).toBe(false);
  });

  it("allows nothing when empty", () => {
    expect(isHostAllowed(compileAllowlist([]), "example.com")).toBe(false);
  });

  it.each(["*", "*.com", "*.", "*.*.example.com", "http://example.com", "10.0.0.1", "*.127.0.0.1"])(
    "refuses the entry %j",
    (entry) => {
      expect(() => compileAllowlist([entry])).toThrow();
    },
  );

  it("is all-or-nothing: one bad entry rejects the list", () => {
    expect(() => compileAllowlist(["example.com", "not a host"])).toThrow();
  });
});

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "169.254.0.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "64:ff9b::7f00:1",
    "2002:7f00:1::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001:db8::1",
    "::127.0.0.1",
    "fe80::1%eth0",
    "not-an-ip",
    "",
  ])("blocks %j", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    "93.184.216.34",
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",
    "2606:4700:4700::1111",
    "2a00:1450::1",
  ])("allows the public address %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

it("decision reasons match the shared contract", () => {
  const local: readonly EgressBlockReasonCode[] = EGRESS_BLOCK_REASONS;
  expect(local).toHaveLength(EGRESS_BLOCK_REASONS.length);
});

// ---------------------------------------------------------------------------------------------------------
// The proxy end to end, in process: a stub resolver and a local target stand in for the internet.
// ---------------------------------------------------------------------------------------------------------

const closers: (() => void)[] = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
});

interface Target {
  readonly port: number;
  readonly hits: string[];
}

async function startTarget(): Promise<Target> {
  const hits: string[] = [];
  const server: HttpServer = createHttpServer((req, res) => {
    hits.push(`${req.method ?? ""} ${req.url ?? ""} host=${req.headers.host ?? ""}`);
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://elsewhere.test/" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello from target");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { port: (server.address() as AddressInfo).port, hits };
}

interface Harness {
  readonly proxyPort: number;
  readonly logs: EgressDecisionLine[];
  send(request: string): Promise<string>;
}

async function startProxy(
  overrides: {
    hosts?: string[];
    ports?: number[];
    answers?: Record<string, string[]>;
    allowLoopback?: boolean;
  } = {},
): Promise<Harness> {
  const logs: EgressDecisionLine[] = [];
  const answers = overrides.answers ?? {};
  const server = createEgressProxy({
    runId: "run-1",
    workspaceId: "ws-1",
    hosts: overrides.hosts ?? ["allowed.test"],
    ports: overrides.ports ?? [80, 443],
    log: (line) => logs.push(line),
    resolve: (host) => Promise.resolve(answers[host] ?? []),
    ...(overrides.allowLoopback === true ? { unsafeAllowAddressesForTests: ["127.0.0.1"] } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const proxyPort = (server.address() as AddressInfo).port;
  return {
    proxyPort,
    logs,
    send: (request) =>
      new Promise<string>((resolve) => {
        let received = "";
        const socket = connect(proxyPort, "127.0.0.1", () => {
          socket.write(request);
        });
        socket.setTimeout(3000, () => {
          socket.destroy();
        });
        socket.on("data", (chunk: Buffer) => {
          received += chunk.toString("utf8");
        });
        socket.on("error", () => undefined);
        socket.on("close", () => {
          resolve(received);
        });
      }),
  };
}

const get = (target: string, host: string): string =>
  `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;
const connectReq = (target: string, hostHeader?: string): string =>
  `CONNECT ${target} HTTP/1.1\r\n${hostHeader === undefined ? "" : `Host: ${hostHeader}\r\n`}\r\n`;

describe("egress proxy: plain HTTP", () => {
  it("blocks a host that is not on the allowlist, logs it, and never contacts the target", async () => {
    const target = await startTarget();
    const proxy = await startProxy({
      answers: { "other.test": ["127.0.0.1"] },
      allowLoopback: true,
    });
    const response = await proxy.send(
      get(`http://other.test:${String(target.port)}/`, `other.test:${String(target.port)}`),
    );
    expect(response).toMatch(/^HTTP\/1\.1 403/);
    expect(response.toLowerCase()).toContain("x-egress-reason: not_allowlisted");
    expect(target.hits).toHaveLength(0);
    expect(proxy.logs).toEqual([
      {
        event: "egress.blocked",
        run_id: "run-1",
        workspace_id: "ws-1",
        host: "other.test",
        port: target.port,
        method: "GET",
        reason: "not_allowlisted",
      },
    ]);
  });

  it("forwards an allowlisted host through the checked address", async () => {
    const target = await startTarget();
    const proxy = await startProxy({
      ports: [target.port],
      answers: { "allowed.test": ["127.0.0.1"] },
      allowLoopback: true,
    });
    const response = await proxy.send(
      get(`http://allowed.test:${String(target.port)}/page`, `allowed.test:${String(target.port)}`),
    );
    expect(response).toMatch(/^HTTP\/1\.1 200/);
    expect(response).toContain("hello from target");
    expect(target.hits).toEqual([`GET /page host=allowed.test:${String(target.port)}`]);
    expect(proxy.logs[0]).toMatchObject({
      event: "egress.allowed",
      host: "allowed.test",
      method: "GET",
    });
  });

  it("does not follow redirects for the client", async () => {
    const target = await startTarget();
    const proxy = await startProxy({
      ports: [target.port],
      answers: { "allowed.test": ["127.0.0.1"] },
      allowLoopback: true,
    });
    const response = await proxy.send(
      get(
        `http://allowed.test:${String(target.port)}/redirect`,
        `allowed.test:${String(target.port)}`,
      ),
    );
    expect(response).toMatch(/^HTTP\/1\.1 302/);
    expect(response.toLowerCase()).toContain("location: http://elsewhere.test/");
    expect(target.hits).toHaveLength(1);
  });

  it("blocks an allowlisted name that resolves to a private address (SSRF / rebinding)", async () => {
    const target = await startTarget();
    const proxy = await startProxy({
      ports: [target.port],
      answers: { "allowed.test": ["127.0.0.1"] },
    });
    const response = await proxy.send(
      get(`http://allowed.test:${String(target.port)}/`, `allowed.test:${String(target.port)}`),
    );
    expect(response).toMatch(/^HTTP\/1\.1 403/);
    expect(proxy.logs[0]).toMatchObject({ event: "egress.blocked", reason: "private_address" });
    expect(target.hits).toHaveLength(0);
  });

  it.each([
    ["metadata service", "169.254.169.254"],
    ["ipv4-mapped loopback", "::ffff:127.0.0.1"],
    ["a public answer mixed with a private one", "10.0.0.5"],
  ])("blocks %s in the answers", async (_label, bad) => {
    const proxy = await startProxy({ answers: { "allowed.test": ["93.184.216.34", bad] } });
    const response = await proxy.send(get("http://allowed.test/", "allowed.test"));
    expect(response).toMatch(/^HTTP\/1\.1 403/);
    expect(proxy.logs[0]?.reason).toBe("private_address");
  });

  it("blocks when the name does not resolve", async () => {
    const proxy = await startProxy({ answers: {} });
    const response = await proxy.send(get("http://allowed.test/", "allowed.test"));
    expect(response).toMatch(/^HTTP\/1\.1 403/);
    expect(proxy.logs[0]?.reason).toBe("resolve_failed");
  });

  it("blocks a port that is not allowed", async () => {
    const proxy = await startProxy({ answers: { "allowed.test": ["93.184.216.34"] } });
    const response = await proxy.send(get("http://allowed.test:8080/", "allowed.test:8080"));
    expect(response).toMatch(/^HTTP\/1\.1 403/);
    expect(proxy.logs[0]).toMatchObject({ reason: "port_not_allowed", port: 8080 });
  });

  it("blocks IP literals as hosts", async () => {
    const open = await startProxy({ answers: {} });
    const response = await open.send(get("http://127.0.0.1/", "127.0.0.1"));
    expect(response).toMatch(/^HTTP\/1\.1 403/);
    expect(open.logs[0]?.reason).toBe("invalid_host");
  });

  it("rejects a request whose Host header disagrees with the target", async () => {
    const proxy = await startProxy({ answers: { "allowed.test": ["93.184.216.34"] } });
    const response = await proxy.send(get("http://allowed.test/", "other.test"));
    expect(response).toMatch(/^HTTP\/1\.1 400/);
    expect(proxy.logs[0]?.reason).toBe("host_mismatch");
  });

  it("rejects a request with two Host headers", async () => {
    const proxy = await startProxy({ answers: { "allowed.test": ["93.184.216.34"] } });
    const response = await proxy.send(
      "GET http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\nHost: allowed.test\r\nConnection: close\r\n\r\n",
    );
    expect(response).toMatch(/^HTTP\/1\.1 (400|403)/);
  });

  it("refuses an origin-form request (not an absolute URL)", async () => {
    const proxy = await startProxy({ answers: { "allowed.test": ["93.184.216.34"] } });
    const response = await proxy.send(get("/", "allowed.test"));
    expect(response).toMatch(/^HTTP\/1\.1 400/);
    expect(proxy.logs[0]?.reason).toBe("bad_request");
  });

  it("denies everything when the allowlist is empty", async () => {
    const proxy = await startProxy({ hosts: [], answers: { "allowed.test": ["93.184.216.34"] } });
    const response = await proxy.send(get("http://allowed.test/", "allowed.test"));
    expect(response).toMatch(/^HTTP\/1\.1 403/);
    expect(proxy.logs[0]?.reason).toBe("not_allowlisted");
  });

  it("never logs the path, the query string, headers or bodies", async () => {
    const proxy = await startProxy({ hosts: [] });
    await proxy.send(
      `GET http://other.test/private/path?token=SECRET123&k=v HTTP/1.1\r\nHost: other.test\r\nAuthorization: Bearer SECRET456\r\nConnection: close\r\n\r\n`,
    );
    const text = JSON.stringify(proxy.logs);
    expect(text).not.toMatch(/SECRET|token|private|path|Bearer/);
    expect(Object.keys(proxy.logs[0] ?? {}).sort()).toEqual(
      ["event", "host", "method", "port", "reason", "run_id", "workspace_id"].sort(),
    );
  });

  it("answers a malformed request with 400 and logs it", async () => {
    const proxy = await startProxy();
    const response = await proxy.send("NOT HTTP AT ALL\r\n\r\n");
    expect(response).toMatch(/^HTTP\/1\.1 400/);
    expect(proxy.logs[0]?.reason).toBe("bad_request");
  });
});

describe("egress proxy: CONNECT", () => {
  async function startEchoTarget(): Promise<{ port: number; connections: () => number }> {
    let count = 0;
    const server: Server = createTcpServer((socket) => {
      count += 1;
      socket.on("data", (chunk) => socket.write(chunk));
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => {
      server.close();
    });
    return { port: (server.address() as AddressInfo).port, connections: () => count };
  }

  it("blocks CONNECT to a host that is not on the allowlist, logs it, and opens no connection", async () => {
    const echo = await startEchoTarget();
    const proxy = await startProxy({
      ports: [echo.port],
      answers: { "other.test": ["127.0.0.1"] },
      allowLoopback: true,
    });
    const response = await proxy.send(connectReq(`other.test:${String(echo.port)}`));
    expect(response).toMatch(/^HTTP\/1\.1 403/);
    expect(echo.connections()).toBe(0);
    expect(proxy.logs[0]).toMatchObject({
      event: "egress.blocked",
      host: "other.test",
      method: "CONNECT",
      reason: "not_allowlisted",
    });
  });

  it("tunnels bytes for an allowlisted host", async () => {
    const echo = await startEchoTarget();
    const proxy = await startProxy({
      ports: [echo.port],
      answers: { "allowed.test": ["127.0.0.1"] },
      allowLoopback: true,
    });
    const reply = await new Promise<string>((resolve) => {
      let received = "";
      const socket = connect(proxy.proxyPort, "127.0.0.1", () => {
        socket.write(connectReq(`allowed.test:${String(echo.port)}`));
      });
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
        if (received.includes("200 Connection Established") && !received.includes("ping")) {
          socket.write("ping");
        }
        if (received.endsWith("ping")) socket.end();
      });
      socket.on("error", () => undefined);
      socket.on("close", () => {
        resolve(received);
      });
    });
    expect(reply).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\nping$/);
    expect(proxy.logs[0]).toMatchObject({ event: "egress.allowed", method: "CONNECT" });
  });

  it("blocks a CONNECT whose Host header names a different host", async () => {
    const echo = await startEchoTarget();
    const proxy = await startProxy({
      ports: [echo.port],
      answers: { "allowed.test": ["127.0.0.1"] },
      allowLoopback: true,
    });
    const response = await proxy.send(
      connectReq(`allowed.test:${String(echo.port)}`, `other.test:${String(echo.port)}`),
    );
    expect(response).toMatch(/^HTTP\/1\.1 400/);
    expect(echo.connections()).toBe(0);
    expect(proxy.logs[0]?.reason).toBe("host_mismatch");
  });

  it.each([
    "127.0.0.1:80",
    "169.254.169.254:80",
    "[::1]:443",
    "allowed.test",
    "allowed.test:99999x",
  ])("blocks the malformed or IP-literal target %s", async (target) => {
    const proxy = await startProxy({ answers: { "allowed.test": ["93.184.216.34"] } });
    const response = await proxy.send(connectReq(target));
    expect(response).toMatch(/^HTTP\/1\.1 (400|403)/);
    expect(proxy.logs[0]?.event).toBe("egress.blocked");
  });

  it("blocks CONNECT to the proxy itself (a private address)", async () => {
    const proxy = await startProxy({
      hosts: ["proxy.test"],
      answers: { "proxy.test": ["127.0.0.1"] },
    });
    const response = await proxy.send(connectReq("proxy.test:80"));
    expect(response).toMatch(/^HTTP\/1\.1 403/);
    expect(proxy.logs[0]?.reason).toBe("private_address");
  });
});
