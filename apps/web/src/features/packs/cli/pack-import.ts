import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { Database } from "@ago/shared";
import { createClient } from "@supabase/supabase-js";

import { runPackImport } from "./run-pack-import.ts";

// Entry for `pnpm pack:import` (a dry run). All behaviour lives in run-pack-import.ts so it can be tested
// without a process.
// pnpm runs the script from apps/web; INIT_CWD is where the person typed the command.
const resolvePath = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path);

const exitCode = await runPackImport(process.argv.slice(2), {
  env: process.env,
  // No session is kept: the command signs in, previews and signs out within one run.
  createClient: (url, anonKey) =>
    createClient<Database>(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  fileSize: async (path) => (await stat(resolvePath(path))).size,
  readFile: (path) => readFile(resolvePath(path), "utf8"),
  stdout: (line) => {
    console.log(line);
  },
  stderr: (line) => {
    console.error(line);
  },
});
process.exit(exitCode);
