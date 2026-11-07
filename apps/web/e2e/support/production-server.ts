import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

import { expect } from "@playwright/test";

// Starts the already built app (`next start`) as its own production process with exactly the env it is
// given, and reports what a visitor and the operator would see. Used by specs that prove a configuration is
// refused at startup (AGO-148: the credential signing secret). Needs `pnpm build` first, like every E2E run.
const WEB_DIR = process.cwd();
const NEXT_BIN = path.join(WEB_DIR, "node_modules/next/dist/bin/next");

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

export interface StartedProduction {
  status: number;
  body: string;
  logs: string;
}

export async function startProduction(env: Record<string, string>): Promise<StartedProduction> {
  const port = await getFreePort();
  let logs = "";
  const child = spawn(
    process.execPath,
    [NEXT_BIN, "start", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: WEB_DIR,
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        NODE_ENV: "production",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk: Buffer) => (logs += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (logs += chunk.toString()));

  try {
    let response: { status: number; body: string } | undefined;
    await expect
      .poll(
        async () => {
          try {
            const res = await fetch(`http://127.0.0.1:${String(port)}/`);
            response = { status: res.status, body: await res.text() };
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 60_000, message: "the production server never started answering" },
      )
      .toBe(true);
    // Let the instrumentation error reach the log before it is read.
    await expect.poll(() => logs.length, { timeout: 10_000 }).toBeGreaterThan(0);
    if (!response) throw new Error("no response captured");
    return { status: response.status, body: response.body, logs };
  } finally {
    child.kill();
  }
}
