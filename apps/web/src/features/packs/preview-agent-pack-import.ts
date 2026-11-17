import type { Database } from "@ago/shared";
import {
  DEFAULT_CONFLICT_RULE,
  buildImportPreview,
  validatePackText,
  type CatalogCapability,
  type ConflictRule,
  type ExistingPackAgent,
  type ExistingPackSkill,
  type ImportPreview,
  type PackRejection,
  type PreviewContext,
} from "@ago/shared/pack-import-preview";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Agent pack import, dry run: the data path (AGO-193). One function serves the API route and `pnpm pack:import`.
 *
 * It WRITES NOTHING. It takes the caller's own Supabase client, so every read goes through row-level security as
 * that person, and it only ever calls `.from(table).select(...)`: no insert, update, delete, upsert or rpc. A
 * test records every call and fails on anything else. It selects named columns of three tables (`agents`,
 * `skills`, `capabilities`) filtered by `workspace_id`, never credentials, identities, runs or budget usage. This
 * file has no `server-only` import because the CLI runs it too; the route does the role check.
 *
 * The pack is validated BEFORE the workspace is read, so a file that is too big, too deep, not JSON or not a
 * valid pack costs no database work.
 */

export class PreviewPackImportError extends Error {
  // An explicit field, not a parameter property: the CLI runs this file with Node's type stripping.
  readonly code = "failed";

  constructor() {
    super("Agent pack preview failed: could not read the workspace");
    this.name = "PreviewPackImportError";
  }
}

export type PreviewPackImportResult =
  { ok: true; preview: ImportPreview } | { ok: false; error: PackRejection };

type Client = SupabaseClient<Database>;

/** PostgREST returns at most 1000 rows a request, so a larger table is read in pages. */
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

async function readAll<Row>(
  readPage: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: unknown }>,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await readPage(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error || !data) throw new PreviewPackImportError();
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
  throw new PreviewPackImportError();
}

/**
 * Reads the workspace state a plan is built from: SELECT only, as the caller, filtered by `workspace_id`. The dry run
 * and the apply (AGO-194) both call this, so they plan from the same reading.
 */
export async function loadPackImportContext(
  client: Client,
  workspaceId: string,
  conflictRule: ConflictRule,
): Promise<PreviewContext> {
  const [agentRows, skillRows, catalogRows, grantRows] = await Promise.all([
    readAll((from, to) =>
      client
        .from("agents")
        .select("id, name, role, model, thinking_effort, prompt, archived_at")
        .eq("workspace_id", workspaceId)
        .order("name", { ascending: true })
        .range(from, to),
    ),
    readAll((from, to) =>
      client
        .from("skills")
        .select("name, version, body")
        .eq("workspace_id", workspaceId)
        .order("name", { ascending: true })
        .range(from, to),
    ),
    readAll((from, to) =>
      client
        .from("capabilities")
        .select("key, tier, scope")
        .eq("workspace_id", workspaceId)
        .order("key", { ascending: true })
        .range(from, to),
    ),
    // What each existing agent holds now: an update adds to it, so the trifecta lint judges the union.
    readAll((from, to) =>
      client
        .from("agent_capabilities")
        .select("agent_id, capability")
        .eq("workspace_id", workspaceId)
        .order("agent_id", { ascending: true })
        .range(from, to),
    ),
  ]);

  const heldByAgent = new Map<string, string[]>();
  for (const grant of grantRows) {
    const held = heldByAgent.get(grant.agent_id) ?? [];
    held.push(grant.capability);
    heldByAgent.set(grant.agent_id, held);
  }
  const existingAgents: ExistingPackAgent[] = agentRows.map((row) => ({
    capabilities: heldByAgent.get(row.id) ?? [],
    name: row.name,
    role: row.role,
    model: row.model,
    thinkingEffort: row.thinking_effort,
    prompt: row.prompt,
    archived: row.archived_at !== null,
  }));
  const existingSkills: ExistingPackSkill[] = skillRows.map((row) => ({
    name: row.name,
    version: row.version,
    body: row.body,
  }));
  const catalog: CatalogCapability[] = catalogRows.map((row) => ({
    key: row.key,
    tier: row.tier,
    scope: row.scope,
  }));

  return { existingAgents, existingSkills, catalog, conflictRule };
}

export async function previewAgentPackImport(
  client: Client,
  input: { workspaceId: string; text: string; conflictRule?: ConflictRule },
): Promise<PreviewPackImportResult> {
  const validated = validatePackText(input.text);
  if (!validated.ok) return validated;
  const context = await loadPackImportContext(
    client,
    input.workspaceId,
    input.conflictRule ?? DEFAULT_CONFLICT_RULE,
  );
  return { ok: true, preview: buildImportPreview(validated.pack, context) };
}
