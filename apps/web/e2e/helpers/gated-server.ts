import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";

import { expect } from "../fixtures";

// Starts a second production server WITHOUT ENABLE_DEV_3D, to prove the dev pages answer 404.
// Playwright runs with apps/web as the working directory and the build already exists.

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

export async function withGatedServer(
  probe: (baseUrl: string) => Promise<void>,
  request: { get: (url: string) => Promise<{ status: () => number }> },
): Promise<void> {
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
  };
  delete env.ENABLE_DEV_3D;

  let server: ChildProcess | undefined;
  try {
    server = spawn(
      process.execPath,
      [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)],
      { env, cwd: process.cwd(), stdio: "ignore" },
    );
    await expect
      .poll(
        async () => {
          try {
            return (await request.get(`${baseUrl}/`)).status();
          } catch {
            return 0;
          }
        },
        { timeout: 60_000 },
      )
      .toBe(200);
    await probe(baseUrl);
  } finally {
    server?.kill();
  }
}
