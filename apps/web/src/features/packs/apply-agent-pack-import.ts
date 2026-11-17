import type { Database } from "@ago/shared";
import { computePackChecksum } from "@ago/shared/pack-export";
import { buildImportPlan, type ImportPlan } from "@ago/shared/pack-import-plan";
import {
  DEFAULT_CONFLICT_RULE,
  validatePackText,
  type ConflictRule,
  type ImportPreview,
  type PackRejection,
} from "@ago/shared/pack-import-preview";
import type { SupabaseClient } from "@supabase/supabase-js";

import { loadPackImportContext } from "./preview-agent-pack-import";

/**
 * Agent pack import, the apply (AGO-194). The same path as the dry run (AGO-193), then ONE database call.
 *
 * The pack is validated first, the workspace is read through the caller's own client (row-level security applies),
 * and the plan comes from `buildImportPlan`, the function the preview is built from: the report the owner saw is the
 * plan that is applied. The only write is `rpc("import_agent_pack")`, one database transaction: every agent, skill,
 * capability grant and the audit event are written together or not at all. The function checks the owner role and the
 * workspace itself and refuses an agent principal (it has no signed-in person), so the route guard is not the only
 * line. It reads tiers from its own capability catalog and never sets a mode, so a tampered plan cannot give an
 * agent more than the pack path allows. A blocked pack (a checksum mismatch, a model off the allowlist) never
 * reaches the database. This file has no `server-only` import because the CLI runs it too (AGO-195); the route does
 * the role check. No service-role key anywhere.
 */

export type ApplyPackImportErrorCode = "forbidden" | "stale" | "invalid" | "failed";

export class ApplyPackImportError extends Error {
  // An explicit field, not a parameter property: the CLI runs this file with Node's type stripping.
  readonly code: ApplyPackImportErrorCode;

  constructor(code: ApplyPackImportErrorCode) {
    super(`Agent pack import failed: ${code}`);
    this.name = "ApplyPackImportError";
    this.code = code;
  }
}

/** What the apply answers: the dry run's report, plus the event that records it. */
export interface ImportReport extends ImportPreview {
  applied: true;
  eventId: string;
  conflictRule: ConflictRule;
}

export type ApplyPackImportResult =
  | { ok: true; report: ImportReport }
  /** The pack parsed but cannot be imported at all (all-or-nothing). Nothing was written. */
  | { ok: false; blocked: ImportPreview }
  | { ok: false; error: PackRejection };

type Client = SupabaseClient<Database>;

interface ImportRpcResult {
  data: unknown;
  error: { code?: string } | null;
}

/** The generated database types do not list this function until they are regenerated, so the call is typed here. */
interface ImportRpcClient {
  rpc(
    name: "import_agent_pack",
    args: { p_workspace_id: string; p_checksum: string; p_plan: ImportPlan },
  ): PromiseLike<ImportRpcResult>;
}

const INSUFFICIENT_PRIVILEGE = "42501";
const UNIQUE_VIOLATION = "23505";
const SERIALIZATION_FAILURE = "40001";
const INVALID_PARAMETER = "22023";
const NO_DATA_FOUND = "P0002";

function codeOf(error: { code?: string }): ApplyPackImportErrorCode {
  switch (error.code) {
    case INSUFFICIENT_PRIVILEGE:
      return "forbidden";
    // The workspace changed between the reading and the write (a name now exists, or is gone): plan again.
    case UNIQUE_VIOLATION:
    case SERIALIZATION_FAILURE:
      return "stale";
    case INVALID_PARAMETER:
    case NO_DATA_FOUND:
      return "invalid";
    default:
      return "failed";
  }
}

function isEventId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export async function applyAgentPackImport(
  client: Client,
  input: { workspaceId: string; text: string; conflictRule?: ConflictRule },
): Promise<ApplyPackImportResult> {
  const validated = validatePackText(input.text);
  if (!validated.ok) return validated;

  const conflictRule = input.conflictRule ?? DEFAULT_CONFLICT_RULE;
  const context = await loadPackImportContext(client, input.workspaceId, conflictRule);
  const { preview, plan } = buildImportPlan(validated.pack, context);
  if (!preview.importable) return { ok: false, blocked: preview };

  const { data, error } = await (client as unknown as ImportRpcClient).rpc("import_agent_pack", {
    p_workspace_id: input.workspaceId,
    // The checksum of the content, whether or not the pack carried one: the event always records what was imported.
    p_checksum: computePackChecksum(validated.pack),
    p_plan: plan,
  });
  if (error) throw new ApplyPackImportError(codeOf(error));
  if (!isEventId(data)) throw new ApplyPackImportError("failed");

  return { ok: true, report: { ...preview, applied: true, eventId: data, conflictRule } };
}
