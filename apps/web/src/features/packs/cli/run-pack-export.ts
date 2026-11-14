import type { Database } from "@ago/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

// Explicit .ts extensions: `pnpm pack:export` runs this file with Node's native type stripping.
import { ExportAgentPackError, exportAgentPack } from "../export-agent-pack.ts";
import { exportAgentPackRequestSchema } from "../export-request.ts";

/**
 * `pnpm pack:export` (AGO-192): the command line front of the same `exportAgentPack` the API route calls.
 *
 * It signs in AS THE PERSON running it (email and password from the environment) with the public anon key, so
 * row-level security and the member-role check in `record_pack_export` apply exactly as they do for the API.
 * There is no service-role key anywhere in this path. The password and the session token are never printed or
 * logged, and a failed sign-in prints a fixed message, never the server's error text.
 *
 *   pnpm pack:export --workspace <uuid> [--agent <uuid> ...] [--name <text>] [--out <file>]
 *
 * Environment (names only; see docs/features/agent-packs.md):
 *   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, AGO_CLI_EMAIL, AGO_CLI_PASSWORD
 */

export const REQUIRED_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "AGO_CLI_EMAIL",
  "AGO_CLI_PASSWORD",
] as const;

export const DEFAULT_OUT_FILE = "agent-pack.json";

export const USAGE = `Usage: pnpm pack:export --workspace <uuid> [--agent <uuid> ...] [--name <text>] [--out <file>]

  --workspace  the workspace to export from (required)
  --agent      an agent id to export; repeat for several. Omit to export every active agent
  --name       the pack name (default "Agent pack")
  --out        where to write the pack (default ${DEFAULT_OUT_FILE})

Sign-in uses ${REQUIRED_ENV.slice(2).join(" and ")} from the environment.`;

export interface CliDeps {
  env: Readonly<Record<string, string | undefined>>;
  createClient(url: string, anonKey: string): SupabaseClient<Database>;
  writeFile(path: string, data: string): Promise<void>;
  stdout(line: string): void;
  stderr(line: string): void;
}

interface ParsedArgs {
  workspace?: string;
  agents: string[];
  name?: string;
  out: string;
  help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs | null {
  const parsed: ParsedArgs = { agents: [], out: DEFAULT_OUT_FILE, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      parsed.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) return null;
    if (flag === "--workspace") parsed.workspace = value;
    else if (flag === "--agent") parsed.agents.push(value);
    else if (flag === "--name") parsed.name = value;
    else if (flag === "--out") parsed.out = value;
    else return null;
    index += 1;
  }
  return parsed;
}

const FAILURE_MESSAGE: Record<ExportAgentPackError["code"], string> = {
  not_found: "An agent was not found in that workspace.",
  no_agents: "There are no agents to export.",
  forbidden: "Your account may not export agents in that workspace (members and owners can).",
  invalid_pack:
    "The agents cannot form a valid pack (for example, a prompt holds a secret-looking value).",
  failed: "The export failed. Nothing was written.",
};

/** Runs the command and returns the process exit code: 0 done, 1 failed, 2 bad usage. */
export async function runPackExport(argv: readonly string[], deps: CliDeps): Promise<number> {
  const args = parseArgs(argv);
  if (args === null) {
    deps.stderr(USAGE);
    return 2;
  }
  if (args.help) {
    deps.stdout(USAGE);
    return 0;
  }

  const request = exportAgentPackRequestSchema.safeParse({
    workspace_id: args.workspace,
    agent_ids: args.agents.length > 0 ? args.agents : undefined,
    name: args.name,
  });
  if (!request.success) {
    deps.stderr(
      `Invalid arguments: ${request.error.issues[0]?.path.join(".") ?? "input"}.\n${USAGE}`,
    );
    return 2;
  }

  const missing = REQUIRED_ENV.filter((name) => !deps.env[name]);
  if (missing.length > 0) {
    deps.stderr(`Missing environment variables: ${missing.join(", ")}`);
    return 2;
  }
  const url = deps.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const anonKey = deps.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

  const client = deps.createClient(url, anonKey);
  const signIn = await client.auth.signInWithPassword({
    email: deps.env.AGO_CLI_EMAIL ?? "",
    password: deps.env.AGO_CLI_PASSWORD ?? "",
  });
  if (signIn.error) {
    // Fixed text on purpose: the server's message could echo what was sent.
    deps.stderr("Sign-in failed. Check AGO_CLI_EMAIL and AGO_CLI_PASSWORD.");
    return 1;
  }

  try {
    const exported = await exportAgentPack(client, {
      workspaceId: request.data.workspace_id,
      agentIds: request.data.agent_ids,
      name: request.data.name,
    });
    await deps.writeFile(args.out, exported.json);
    deps.stdout(
      `Exported ${String(exported.pack.agents.length)} agent(s) and ${String(exported.pack.skills.length)} skill(s) to ${args.out}\nChecksum sha256:${exported.checksum}`,
    );
    return 0;
  } catch (error) {
    if (error instanceof ExportAgentPackError) {
      deps.stderr(FAILURE_MESSAGE[error.code]);
      return 1;
    }
    deps.stderr("The export failed. Nothing was written.");
    return 1;
  } finally {
    await client.auth.signOut();
  }
}
