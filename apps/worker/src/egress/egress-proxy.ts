/**
 * The egress proxy (AGO-65). Default deny: a request goes out only when its host is on the run's allowlist,
 * its port is allowed, and every address the name resolves to is public. The proxy resolves the name once,
 * checks the answers, and connects to the checked IP, so a name that rebinds to an internal address cannot
 * reach it (SSRF / DNS rebinding).
 *
 * This file is deliberately self-contained: it imports only `node:` modules and uses erasable TypeScript
 * only, because the Docker launcher pipes it to `node --input-type=module-typescript -` inside a pinned
 * `node:24-alpine` container (no build, no host mount). The worker imports the same module for its tests
 * and for validating configuration. It handles `CONNECT` and plain HTTP through one `authorize()` check, never
 * follows redirects for the client, and listens on one port only (no admin or metrics endpoint).
 */
import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import { connect as netConnect, isIP } from "node:net";
import type { Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { domainToASCII } from "node:url";

export type EgressBlockReasonCode =
  | "not_allowlisted"
  | "port_not_allowed"
  | "private_address"
  | "invalid_host"
  | "host_mismatch"
  | "resolve_failed"
  | "too_many_connections"
  | "bad_request"
  | "timeout"
  | "upstream_error";

export interface EgressDecisionLine {
  readonly event: "egress.allowed" | "egress.blocked";
  readonly run_id: string;
  readonly workspace_id: string;
  readonly host: string;
  readonly port: number;
  readonly method: string;
  readonly reason?: EgressBlockReasonCode;
}

// ---------------------------------------------------------------------------------------------------------
// Host names
// ---------------------------------------------------------------------------------------------------------

const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Lower-cases, drops one trailing dot, converts IDN to punycode and checks the shape. Returns `undefined`
 * for anything that is not a plain DNS name: IP literals (also decimal / hex / octal forms), empty labels,
 * userinfo, ports, whitespace, an all-numeric last label.
 */
export function normalizeHost(raw: string): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_HOST_LENGTH * 4)
    return undefined;
  let value = raw.trim().toLowerCase();
  if (value.endsWith(".")) value = value.slice(0, -1);
  if (value.length === 0 || /[\s/\\:?#@[\]%*]/u.test(value)) return undefined;
  const ascii = domainToASCII(value);
  if (ascii === "" || ascii.length > MAX_HOST_LENGTH) return undefined;
  if (isIP(ascii) !== 0) return undefined;
  const labels = ascii.split(".");
  for (const label of labels) {
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH || !LABEL.test(label))
      return undefined;
  }
  const last = labels[labels.length - 1] ?? "";
  if (/^[0-9]+$/.test(last) || /^0x/i.test(last)) return undefined;
  return ascii;
}

export interface CompiledAllowlist {
  readonly exact: ReadonlySet<string>;
  /** Suffixes of `*.suffix` entries, normalised, each with at least two labels (`*.com` is refused). */
  readonly suffixes: readonly string[];
}

/** Compiles `example.com` / `*.example.com` entries. Throws on an invalid entry: a bad list must not half-apply. */
export function compileAllowlist(patterns: readonly string[]): CompiledAllowlist {
  const exact = new Set<string>();
  const suffixes: string[] = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string") throw new Error("allowlist entry is not a string");
    if (pattern.startsWith("*.")) {
      const suffix = normalizeHost(pattern.slice(2));
      if (!suffix?.includes(".")) {
        throw new Error(
          `allowlist entry ${JSON.stringify(pattern.slice(0, 80))} is not a valid wildcard`,
        );
      }
      suffixes.push(suffix);
    } else {
      const host = normalizeHost(pattern);
      if (host === undefined) {
        throw new Error(
          `allowlist entry ${JSON.stringify(pattern.slice(0, 80))} is not a valid host`,
        );
      }
      exact.add(host);
    }
  }
  return { exact, suffixes };
}

/** `host` must already be normalised. A wildcard never matches its own apex. */
export function isHostAllowed(list: CompiledAllowlist, host: string): boolean {
  if (list.exact.has(host)) return true;
  return list.suffixes.some(
    (suffix) => host.length > suffix.length + 1 && host.endsWith(`.${suffix}`),
  );
}

// ---------------------------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------------------------

function parseIPv4(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    value = value * 256 + n;
  }
  return value;
}

/** [base address, prefix length]. Every special-purpose range that must never be reachable. */
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isBlockedV4(value: number): boolean {
  return BLOCKED_V4.some(([base, bits]) => {
    const start = parseIPv4(base) ?? 0;
    const size = 2 ** (32 - bits);
    return value >= start && value < start + size;
  });
}

function parseIPv6(ip: string): number[] | undefined {
  if (ip.includes("%")) return undefined;
  let text = ip.toLowerCase();
  const tail = text.lastIndexOf(":");
  if (text.slice(tail + 1).includes(".")) {
    const v4 = parseIPv4(text.slice(tail + 1));
    if (v4 === undefined) return undefined;
    text = `${text.slice(0, tail + 1)}${Math.floor(v4 / 65_536).toString(16)}:${(v4 % 65_536).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const toGroups = (part: string): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const head = toGroups(halves[0] ?? "");
  if (head === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const rest = toGroups(halves[1] ?? "");
  if (rest === undefined || head.length + rest.length > 7) return undefined;
  return [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest];
}

/**
 * True when the address must not be connected to: not an IP at all, private, loopback, link-local, cloud
 * metadata (169.254.169.254), CGNAT, multicast, reserved, IPv4-mapped / NAT64 / 6to4 / Teredo tricks, or
 * anything outside global unicast IPv6 (2000::/3). Unknown or unparsable input is blocked.
 */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const value = parseIPv4(ip);
    return value === undefined || isBlockedV4(value);
  }
  if (family !== 6) return true;
  const g = parseIPv6(ip);
  if (g === undefined) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    // ::ffff:a.b.c.d is an IPv4 address in disguise: judge the embedded address. Every other ::/96 is blocked.
    return g5 === 0xffff ? isBlockedV4(g6 * 65_536 + g7) : true;
  }
  if ((g0 & 0xe000) !== 0x2000) return true; // outside 2000::/3
  if (g0 === 0x2001 && g1 < 0x0200) return true; // 2001::/23 protocol assignments incl. Teredo
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x2002) return true; // 6to4
  if (g0 === 0x3fff && g1 < 0x1000) return true; // documentation 3fff::/20
  return false;
}

// ---------------------------------------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------------------------------------

export interface EgressProxyOptions {
  readonly runId: string;
  readonly workspaceId: string;
  /** `example.com` / `*.example.com`. Empty means deny everything. */
  readonly hosts: readonly string[];
  /** Allowed destination ports. Empty means deny everything. */
  readonly ports: readonly number[];
  readonly log: (decision: EgressDecisionLine) => void;
  /** Resolves a normalised host to its addresses. Defaults to the system resolver. */
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  readonly maxConnections?: number;
  readonly maxHeaderBytes?: number;
  readonly idleTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly resolveTimeoutMs?: number;
  /**
   * TEST ONLY. Exact IP addresses exempt from the private-range block, so a local target container can stand
   * in for "the internet". Never set from configuration: the allowlist schema has no such field.
   */
  readonly unsafeAllowAddressesForTests?: readonly string[];
}

type Authorization =
  | { readonly ok: true; readonly host: string; readonly address: string; readonly family: 4 | 6 }
  | { readonly ok: false; readonly host: string; readonly reason: EgressBlockReasonCode };

const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_MAX_HEADER_BYTES = 8 * 1024;
const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_TOTAL_MS = 120_000;
const DEFAULT_RESOLVE_MS = 5_000;

/** Safe to put in a log line: printable ASCII only and short. */
function loggableHost(raw: string): string {
  return raw.replace(/[^\x21-\x7e]/g, "?").slice(0, 100);
}

function defaultResolve(host: string): Promise<readonly string[]> {
  return lookup(host, { all: true, order: "verbatim" }).then((answers) =>
    answers.map((a) => a.address),
  );
}

export function createEgressProxy(options: EgressProxyOptions): Server {
  const allowlist = compileAllowlist(options.hosts);
  const ports = new Set(options.ports);
  const resolve = options.resolve ?? defaultResolve;
  const idleMs = options.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  const totalMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_MS;
  const resolveMs = options.resolveTimeoutMs ?? DEFAULT_RESOLVE_MS;
  const unsafeAllowed = new Set(options.unsafeAllowAddressesForTests ?? []);

  const record = (
    event: EgressDecisionLine["event"],
    host: string,
    port: number,
    method: string,
    reason?: EgressBlockReasonCode,
  ): void => {
    const line: EgressDecisionLine = {
      event,
      run_id: options.runId,
      workspace_id: options.workspaceId,
      host,
      port,
      method,
      ...(reason === undefined ? {} : { reason }),
    };
    try {
      options.log(line);
    } catch {
      // A failing log sink must not turn a deny into an allow, or crash the proxy.
    }
  };

  /** The one check CONNECT and plain HTTP share. Default deny. */
  async function authorize(rawHost: string, port: number): Promise<Authorization> {
    const host = normalizeHost(rawHost);
    if (host === undefined)
      return { ok: false, host: loggableHost(rawHost), reason: "invalid_host" };
    if (!isHostAllowed(allowlist, host)) return { ok: false, host, reason: "not_allowlisted" };
    if (!ports.has(port)) return { ok: false, host, reason: "port_not_allowed" };
    let answers: readonly string[];
    try {
      answers = await withTimeout(resolve(host), resolveMs);
    } catch {
      return { ok: false, host, reason: "resolve_failed" };
    }
    if (answers.length === 0) return { ok: false, host, reason: "resolve_failed" };
    // Any private answer blocks the whole name: an attacker-controlled record can mix public and internal.
    if (answers.some((address) => isBlockedAddress(address) && !unsafeAllowed.has(address))) {
      return { ok: false, host, reason: "private_address" };
    }
    const address = answers[0] ?? "";
    return { ok: true, host, address, family: isIP(address) === 6 ? 6 : 4 };
  }

  const server = createServer({
    maxHeaderSize: options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES,
  });
  server.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  server.headersTimeout = 10_000;
  server.requestTimeout = totalMs;
  server.keepAliveTimeout = 1_000;

  server.on("drop", () => {
    record("egress.blocked", "", 0, "-", "too_many_connections");
  });
  server.on("clientError", (_error, socket) => {
    record("egress.blocked", "", 0, "-", "bad_request");
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    else socket.destroy();
  });

  // Plain HTTP in absolute form: `GET http://host[:port]/path`.
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    void handlePlain(req, res).catch(() => {
      if (!res.headersSent) deny(res, 502, "upstream_error");
      res.destroy();
    });
  });

  // CONNECT host:port, a tunnel (TLS passes through untouched).
  server.on("connect", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    void handleConnect(req, socket, head).catch(() => {
      socket.destroy();
    });
  });

  // No `upgrade` listener: Node closes the socket, so WebSocket upgrades over plain HTTP are unsupported.

  async function handlePlain(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      record("egress.blocked", "", 0, method, "bad_request");
      deny(res, 400, "bad_request");
      return;
    }
    if (url.protocol !== "http:" || url.username !== "" || url.password !== "") {
      record("egress.blocked", loggableHost(url.hostname), 0, method, "bad_request");
      deny(res, 400, "bad_request");
      return;
    }
    const port = url.port === "" ? 80 : Number(url.port);
    const auth = await authorize(url.hostname, port);
    if (!auth.ok) {
      record("egress.blocked", auth.host, port, method, auth.reason);
      deny(res, 403, auth.reason);
      return;
    }
    if (!hostHeaderAgrees(req, auth.host, port, 80)) {
      record("egress.blocked", auth.host, port, method, "host_mismatch");
      deny(res, 400, "host_mismatch");
      return;
    }
    record("egress.allowed", auth.host, port, method);
    forward(req, res, auth, port, `${url.pathname}${url.search}`);
  }

  function forward(
    req: IncomingMessage,
    res: ServerResponse,
    auth: Extract<Authorization, { ok: true }>,
    port: number,
    path: string,
  ): void {
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name) || name === "host") continue;
      headers[name] = value;
    }
    headers.host = port === 80 ? auth.host : `${auth.host}:${String(port)}`;
    headers.connection = "close";
    // Connect to the checked IP (pinned): the name is never resolved a second time.
    const upstream = httpRequest({
      host: auth.address,
      family: auth.family,
      port,
      method: req.method ?? "GET",
      path,
      headers,
      agent: false,
      setHost: false,
    });
    const total = setTimeout(() => {
      record("egress.blocked", auth.host, port, req.method ?? "GET", "timeout");
      upstream.destroy();
      res.destroy();
    }, totalMs);
    upstream.setTimeout(idleMs, () => {
      record("egress.blocked", auth.host, port, req.method ?? "GET", "timeout");
      upstream.destroy();
      if (!res.headersSent) deny(res, 504, "timeout");
      else res.destroy();
    });
    upstream.on("response", (up) => {
      // Redirects are passed back untouched: the client must come back through this proxy for the next hop.
      res.writeHead(up.statusCode ?? 502, stripHopByHop(up.headers));
      up.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) deny(res, 502, "upstream_error");
      else res.destroy();
    });
    res.on("close", () => {
      clearTimeout(total);
      upstream.destroy();
    });
    req.pipe(upstream);
  }

  async function handleConnect(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    socket.on("error", () => {
      socket.destroy();
    });
    const match = /^([^\s:[\]]+):([0-9]{1,5})$/.exec(req.url ?? "");
    if (match === null) {
      record("egress.blocked", loggableHost(req.url ?? ""), 0, "CONNECT", "invalid_host");
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const port = Number(match[2]);
    const auth = await authorize(match[1] ?? "", port);
    if (!auth.ok) {
      record("egress.blocked", auth.host, port, "CONNECT", auth.reason);
      socket.end(
        `HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\nX-Egress-Reason: ${auth.reason}\r\n\r\n`,
      );
      return;
    }
    if (!hostHeaderAgrees(req, auth.host, port, 443)) {
      record("egress.blocked", auth.host, port, "CONNECT", "host_mismatch");
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    record("egress.allowed", auth.host, port, "CONNECT");
    const upstream = netConnect({ host: auth.address, family: auth.family, port });
    let established = false;
    const end = (): void => {
      clearTimeout(total);
      upstream.destroy();
      socket.destroy();
    };
    const total = setTimeout(() => {
      record("egress.blocked", auth.host, port, "CONNECT", "timeout");
      end();
    }, totalMs);
    const onIdle = (): void => {
      record("egress.blocked", auth.host, port, "CONNECT", "timeout");
      end();
    };
    upstream.setTimeout(idleMs, onIdle);
    socket.setTimeout(idleMs, onIdle);
    upstream.once("connect", () => {
      established = true;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => {
      if (!established && socket.writable) {
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      }
      end();
    });
    upstream.once("close", end);
    socket.once("close", end);
  }

  return server;
}

function deny(res: ServerResponse, status: number, reason: EgressBlockReasonCode): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "content-type": "text/plain",
    connection: "close",
    "x-egress-reason": reason,
  });
  res.end(`egress denied: ${reason}\n`);
}

function stripHopByHop(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    out[name] = value;
  }
  out.connection = "close";
  return out;
}

/** True when the Host header names the same host and port as the request target (or is absent). One Host only. */
function hostHeaderAgrees(
  req: IncomingMessage,
  host: string,
  port: number,
  defaultPort: number,
): boolean {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if ((req.rawHeaders[i] ?? "").toLowerCase() === "host") count += 1;
  }
  if (count === 0) return true;
  if (count > 1) return false;
  const header = req.headers.host ?? "";
  const match = /^([^\s:[\]]+)(?::([0-9]{1,5}))?$/.exec(header);
  if (match === null) return false;
  const headerPort = match[2] === undefined ? defaultPort : Number(match[2]);
  return normalizeHost(match[1] ?? "") === host && headerPort === port;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out"));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("failed"));
      },
    );
  });
}

// ---------------------------------------------------------------------------------------------------------
// Container entry point: runs only when the launcher sets EGRESS_PROXY_MAIN=1 (never on import).
// ---------------------------------------------------------------------------------------------------------

function listValue(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The single non-internal IPv4 address of this container. The listener binds to it and nothing else. */
function onlyAddress(): string | undefined {
  const found: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === "IPv4" && !entry.internal) found.push(entry.address);
    }
  }
  return found.length === 1 ? found[0] : undefined;
}

function main(): void {
  const log = (decision: EgressDecisionLine): void => {
    process.stdout.write(`${JSON.stringify(decision)}\n`);
  };
  const runId = process.env.EGRESS_RUN_ID ?? "";
  const workspaceId = process.env.EGRESS_WORKSPACE_ID ?? "";
  const listenPort = Number(process.env.EGRESS_LISTEN_PORT ?? "3128");
  // A start-up failure exits non-zero: the launcher treats "not ready" as deny and never runs the sandbox.
  const fail = (message: string): never => {
    process.stderr.write(`egress proxy cannot start: ${message}\n`);
    process.exit(1);
  };
  const address = onlyAddress();
  if (address === undefined) fail("expected exactly one network interface at start");
  const unsafe = listValue("EGRESS_UNSAFE_ALLOW_ADDRESSES_TEST_ONLY");
  let server: Server;
  try {
    server = createEgressProxy({
      runId,
      workspaceId,
      hosts: listValue("EGRESS_HOSTS"),
      ports: listValue("EGRESS_PORTS").map(Number),
      log,
      ...(unsafe.length > 0 ? { unsafeAllowAddressesForTests: unsafe } : {}),
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "invalid configuration");
  }
  server.on("error", () => {
    process.exit(1);
  });
  server.listen(listenPort, address, () => {
    process.stdout.write(
      `${JSON.stringify({ event: "egress.ready", address, port: listenPort })}\n`,
    );
  });
}

if (process.env.EGRESS_PROXY_MAIN === "1") main();
