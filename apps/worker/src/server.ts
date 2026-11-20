import { createServer, type Server, type ServerResponse } from "node:http";

import { prerequisiteResultSchema, type PrerequisiteResult } from "@ago/shared";

import { buildHealthReport, httpStatusFor, type HealthChecks } from "./health.js";

import type { Logger } from "./logger.js";

export const HEALTH_PATHS: readonly string[] = ["/health", "/healthz"];

export const PREREQUISITES_PATH = "/prerequisites";

export interface HealthServerOptions {
  readonly port: number;
  readonly checks: HealthChecks;
  readonly logger: Logger;
  readonly host?: string;
  /**
   * AGO-85: the capability prerequisite report. Served read-only at GET /prerequisites to loopback callers
   * only (the web app's enable action). Absent: the route does not exist.
   */
  readonly prerequisites?: () => Promise<readonly PrerequisiteResult[]>;
}

/** True for a caller on this machine. A container binding 0.0.0.0 still answers only its own loopback. */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * GET /prerequisites: check name, status and reason code only. No side effects, no request body read. Anything
 * that is not a GET from loopback looks like a missing route; a failure is a bare 500 (never an error text).
 */
function servePrerequisites(
  method: string | undefined,
  remoteAddress: string | undefined,
  report: () => Promise<readonly PrerequisiteResult[]>,
  res: ServerResponse,
  logger: Logger,
): void {
  if (method !== "GET" || !isLoopbackAddress(remoteAddress)) {
    res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}');
    return;
  }
  report()
    .then((results) => {
      const body = { results: results.map((r) => prerequisiteResultSchema.parse(r)) };
      res
        .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify(body));
    })
    .catch((error: unknown) => {
      logger.error({ err: error }, "prerequisite report failed");
      res.writeHead(500, { "content-type": "application/json" }).end('{"error":"unavailable"}');
    });
}

/** Minimal HTTP server exposing GET /health. No other route, no request body is read. */
export function startHealthServer(options: HealthServerOptions): Promise<Server> {
  const { checks, logger } = options;
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === PREREQUISITES_PATH && options.prerequisites !== undefined) {
      servePrerequisites(req.method, req.socket.remoteAddress, options.prerequisites, res, logger);
      return;
    }
    if (req.method !== "GET" || !HEALTH_PATHS.includes(path)) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}');
      return;
    }
    buildHealthReport(checks, process.uptime())
      .then((report) => {
        res
          .writeHead(httpStatusFor(report), {
            "content-type": "application/json",
            "cache-control": "no-store",
          })
          .end(JSON.stringify(report));
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, "health probe failed");
        res.writeHead(500, { "content-type": "application/json" }).end('{"status":"down"}');
      });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Bind loopback by default; containers set WORKER_HOST=0.0.0.0 via the Dockerfile.
    server.listen(options.port, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
