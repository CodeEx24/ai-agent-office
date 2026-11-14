import type { Database } from "@ago/shared";
import { MAX_PACK_BYTES, type ImportPreview } from "@ago/shared/pack-import-preview";
import type { SupabaseClient } from "@supabase/supabase-js";

// Explicit .ts extensions: `pnpm pack:import` runs this file with Node's native type stripping.
import { previewAgentPackImport } from "../preview-agent-pack-import.ts";
import { previewPackImportQuerySchema } from "../preview-request.ts";
import { REQUIRED_ENV } from "./run-pack-export.ts";

/**
 * `pnpm pack:import` (AGO-193): the command line front of the same `previewAgentPackImport` the API route calls.
 * In this ticket it is a DRY RUN ONLY: it reads a pack file and prints what an import would change. It writes
 * nothing to the workspace and has no apply option (applying a pack is a later ticket). Asking for `--apply`
 * prints that it is not available yet.
 *
 * Like `pack:export` it signs in AS THE PERSON running it with the public anon key, so row-level security
 * applies, and it asks for the same role the API asks for (an owner of the workspace). There is no service-role
 * key in this path. The password and session token are never printed; a failed sign-in prints a fixed line.
 *
 *   pnpm pack:import --workspace <uuid> --file <pack.json> [--json]
 */

export const IMPORT_USAGE = `Usage: pnpm pack:import --workspace <uuid> --file <pack.json> [--json]

  --workspace  the workspace to preview the import into (required; you must be its owner)
  --file       the agent pack file to check (required)
  --json       print the preview as JSON instead of text

This is a dry run: nothing is written. Applying a pack is not available yet.
Sign-in uses ${REQUIRED_ENV.slice(2).join(" and ")} from the environment.`;

export interface ImportCliDeps {
  env: Readonly<Record<string, string | undefined>>;
  createClient(url: string, anonKey: string): SupabaseClient<Database>;
  /** Size of the file in bytes, checked before it is read. */
  fileSize(path: string): Promise<number>;
  readFile(path: string): Promise<string>;
  stdout(line: string): void;
  stderr(line: string): void;
}

interface ParsedArgs {
  workspace?: string;
  file?: string;
  json: boolean;
  apply: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs | null {
  const parsed: ParsedArgs = { json: false, apply: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") parsed.help = true;
    else if (flag === "--json") parsed.json = true;
    else if (flag === "--apply") parsed.apply = true;
    else if (flag === "--workspace" || flag === "--file") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) return null;
      if (flag === "--workspace") parsed.workspace = value;
      else parsed.file = value;
      index += 1;
    } else return null;
  }
  return parsed;
}

/** The readable form of a preview. Names, numbers and fixed reason words only (the preview holds no pack prose). */
export function formatPreview(preview: ImportPreview): string[] {
  const lines: string[] = [];
  const { summary } = preview;
  lines.push(
    `Pack "${preview.packName}" (format v${String(preview.packVersion)})`,
    `Agents: ${String(summary.agents.create)} to create, ${String(summary.agents.update)} to update, ${String(summary.agents.skip)} to skip`,
    `Skills: ${String(summary.skills.create)} to create, ${String(summary.skills.update)} to update, ${String(summary.skills.skip)} to skip`,
  );
  for (const agent of preview.agents) {
    lines.push(
      `  agent ${agent.name}: ${agent.action}${agent.conflict ? " (name already exists)" : ""}`,
    );
    if (agent.trifecta.declared) {
      lines.push(
        `    WARNING: declares a trifecta combination (${agent.trifecta.legs.join(", ")})${
          agent.trifecta.remainsAfterIgnoring
            ? ""
            : "; it is gone once ignored capabilities are dropped"
        }`,
      );
    }
    for (const capability of agent.capabilities) {
      const tier = capability.tier === null ? "unknown tier" : `tier ${String(capability.tier)}`;
      lines.push(`    capability ${capability.name} [${tier}]: ${capability.status}`);
    }
  }
  for (const skill of preview.skills) {
    lines.push(
      `  skill ${skill.name}: ${skill.action}${skill.conflict ? " (name already exists)" : ""}`,
    );
  }
  for (const reference of preview.references) {
    lines.push(`  set up afterwards: ${reference.kind} ${reference.name}`);
  }
  for (const blocker of preview.blockers) lines.push(`  BLOCKED: ${blocker.message}`);
  lines.push(
    preview.importable
      ? "Importable: yes. Nothing was written."
      : "Importable: no. Nothing was written.",
  );
  return lines;
}

/** Runs the command and returns the process exit code: 0 importable, 1 blocked or failed, 2 bad usage. */
export async function runPackImport(argv: readonly string[], deps: ImportCliDeps): Promise<number> {
  const args = parseArgs(argv);
  if (args === null) {
    deps.stderr(IMPORT_USAGE);
    return 2;
  }
  if (args.help) {
    deps.stdout(IMPORT_USAGE);
    return 0;
  }
  if (args.apply) {
    deps.stderr("Applying a pack is not available yet. This command only previews (a dry run).");
    return 2;
  }
  const query = previewPackImportQuerySchema.safeParse({ workspace_id: args.workspace });
  if (!query.success || args.file === undefined) {
    deps.stderr(
      `Invalid arguments: --workspace (a uuid) and --file are required.\n${IMPORT_USAGE}`,
    );
    return 2;
  }
  const missing = REQUIRED_ENV.filter((name) => !deps.env[name]);
  if (missing.length > 0) {
    deps.stderr(`Missing environment variables: ${missing.join(", ")}`);
    return 2;
  }

  // The size is checked before the file is read, like the route checks the declared length.
  let text: string;
  try {
    if ((await deps.fileSize(args.file)) > MAX_PACK_BYTES) {
      deps.stderr(
        `The file is too large. The limit is ${String(MAX_PACK_BYTES / 1024 / 1024)} MB.`,
      );
      return 1;
    }
    text = await deps.readFile(args.file);
  } catch {
    deps.stderr("The pack file could not be read.");
    return 1;
  }

  const client = deps.createClient(
    deps.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    deps.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  );
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
    // The same rule as the route: an owner of THAT workspace, read through the person's own session.
    const membership = await client
      .from("members")
      .select("role")
      .eq("workspace_id", query.data.workspace_id)
      .eq("user_id", signIn.data.user.id)
      .is("removed_at", null)
      .maybeSingle();
    if (membership.error || membership.data?.role !== "owner") {
      deps.stderr("Your account may not preview imports in that workspace (owners can).");
      return 1;
    }

    const result = await previewAgentPackImport(client, {
      workspaceId: query.data.workspace_id,
      text,
    });
    if (!result.ok) {
      deps.stderr(result.error.message);
      for (const issue of result.error.issues ?? []) {
        deps.stderr(`  ${issue.path}: ${issue.message}`);
      }
      return 1;
    }
    if (args.json) deps.stdout(JSON.stringify(result.preview, null, 2));
    else for (const line of formatPreview(result.preview)) deps.stdout(line);
    return result.preview.importable ? 0 : 1;
  } catch {
    deps.stderr("The preview failed. Nothing was written.");
    return 1;
  } finally {
    await client.auth.signOut();
  }
}
