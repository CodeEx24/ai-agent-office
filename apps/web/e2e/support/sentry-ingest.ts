import { type ChildProcess, spawn } from "node:child_process";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import path from "node:path";
import { gunzipSync } from "node:zlib";

// AGO-104 QA helpers: a LOCAL fake Sentry ingest (accepts envelopes, never leaves the machine) and a
// second `next start` whose environment the test controls. Playwright runs with apps/web as the
// working directory and the production build already exists.

export interface FakeIngest {
  /** `http://publickey@127.0.0.1:<port>/1`: a DSN that points at this fake. */
  readonly dsn: string;
  readonly origin: string;
  readonly bodies: string[];
  close(): Promise<void>;
}

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      resolve(
        request.headers["content-encoding"] === "gzip"
          ? gunzipSync(raw).toString("utf8")
          : raw.toString("utf8"),
      );
    });
    request.on("error", reject);
  });
}

/** Starts the fake ingest on `port` (a free one when omitted). CORS is open so browsers may post. */
export async function startFakeIngest(port?: number): Promise<FakeIngest> {
  const bodies: string[] = [];
  const listenPort = port ?? (await getFreePort());
  const server: Server = createHttpServer((request, response) => {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "POST, OPTIONS",
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    readBody(request).then(
      (body) => {
        bodies.push(body);
        response.writeHead(200, { ...cors, "content-type": "application/json" });
        response.end("{}");
      },
      () => {
        response.writeHead(400, cors);
        response.end();
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", resolve);
  });
  return {
    dsn: `http://publickey@127.0.0.1:${String(listenPort)}/1`,
    origin: `http://127.0.0.1:${String(listenPort)}`,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

export type SentryEvent = Record<string, unknown> & {
  tags?: Record<string, string>;
  exception?: { values?: { value?: string }[] };
};

/** Error events (not sessions, transactions or client reports) found in the received envelopes. */
export function errorEventsOf(bodies: readonly string[]): SentryEvent[] {
  return bodies
    .flatMap((body) => body.split("\n"))
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as SentryEvent;
        return parsed.exception !== undefined || "message" in parsed ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

export interface AppServer {
  readonly baseUrl: string;
  /** Everything the server wrote to stdout and stderr so far. */
  logs(): string;
  stop(): Promise<void>;
}

/**
 * Starts a production server with exactly the Sentry variables a test passes. Other Sentry values
 * from the parent environment are removed so the test controls the whole configuration.
 */
export async function startAppServer(
  sentryEnv: { SENTRY_DSN?: string; NEXT_PUBLIC_SENTRY_DSN?: string },
  isReady: (baseUrl: string) => Promise<boolean>,
  /** Extra variables for the server (AGO-201 QA: a Supabase URL behind a fault proxy, the proxy-trust switch). */
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<AppServer> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const nextBin = createRequire(path.join(process.cwd(), "package.json")).resolve(
    "next/dist/bin/next",
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_ENV: "local",
    NEXT_PUBLIC_APP_URL: baseUrl,
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon-key-no-stack",
  };
  delete env.SENTRY_DSN;
  delete env.NEXT_PUBLIC_SENTRY_DSN;
  // Unset unless a test asks: the proxy-trust switch defaults to off (AGO-201).
  delete env.TRUST_PROXY_HEADERS;
  Object.assign(env, sentryEnv, extraEnv);

  const child: ChildProcess = spawn(
    process.execPath,
    [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)],
    { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const stop = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => {
        resolve();
      });
      child.kill();
    });

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`next start exited with code ${String(child.exitCode)}`);
    }
    try {
      if (await isReady(baseUrl)) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error("next start did not become ready in 60s");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { baseUrl, logs: () => output, stop };
}

/** The `connect-src` sources of a CSP header value. */
export function connectSrc(csp: string | undefined): string[] {
  const directive = csp?.split("; ").find((part) => part.startsWith("connect-src "));
  return directive ? directive.split(" ").slice(1) : [];
}
