import { createServer, type Server } from "node:http";

import { buildHealthReport, httpStatusFor, type HealthChecks } from "./health.js";

import type { Logger } from "./logger.js";

export const HEALTH_PATHS: readonly string[] = ["/health", "/healthz"];

export interface HealthServerOptions {
  readonly port: number;
  readonly checks: HealthChecks;
  readonly logger: Logger;
  readonly host?: string;
}

/** Minimal HTTP server exposing GET /health. No other route, no request body is read. */
export function startHealthServer(options: HealthServerOptions): Promise<Server> {
  const { checks, logger } = options;
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
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
