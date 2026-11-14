import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Database } from "@ago/shared";
import { createClient } from "@supabase/supabase-js";

import { runPackExport } from "./run-pack-export.ts";

// Entry for `pnpm pack:export`. All behaviour lives in run-pack-export.ts so it can be tested without a process.
const exitCode = await runPackExport(process.argv.slice(2), {
  env: process.env,
  // No session is kept: the command signs in, exports and signs out within one run.
  createClient: (url, anonKey) =>
    createClient<Database>(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  // pnpm runs the script from apps/web; INIT_CWD is where the person typed the command.
  writeFile: (path, data) =>
    writeFile(resolve(process.env.INIT_CWD ?? process.cwd(), path), data, "utf8"),
  stdout: (line) => {
    console.log(line);
  },
  stderr: (line) => {
    console.error(line);
  },
});
process.exit(exitCode);
