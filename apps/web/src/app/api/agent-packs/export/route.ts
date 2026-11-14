import type { NextRequest } from "next/server";

import { exportAgentPackRequestSchema } from "../../../../features/packs/export-request";
import {
  ExportAgentPackError,
  exportAgentPack,
  type ExportFailureCode,
} from "../../../../features/packs/export-agent-pack";
import {
  WorkspaceAccessError,
  requireWorkspaceRole,
} from "../../../../features/workspaces/workspace-access";
import { rejectAgentCredential } from "../../../../lib/auth/human-only";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";
import { invalidInputResponse, parseInput } from "../../../../lib/validation/parse-input";

// Never cache: the answer depends on the caller's session and holds agent prompts.
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}

const FAILURE_STATUS: Record<ExportFailureCode, number> = {
  not_found: 404,
  no_agents: 404,
  forbidden: 403,
  invalid_pack: 422,
  failed: 500,
};

/**
 * POST /api/agent-packs/export: export agents and the skills they use to one agent pack (AGO-192).
 * Body: { workspace_id, agent_ids?, name? }. Omit agent_ids for every active agent.
 * Human only: an agent credential is refused first (403). A member or owner may export; a viewer may not.
 * The export is logged (exporter and agent list) before the file is returned, so a failed log means no file.
 * 200 the pack as a JSON download, 400 bad input, 401 signed out, 403 not allowed, 404 an agent not found or
 * nothing to export, 415 not JSON, 422 the data cannot form a valid pack (a secret-shaped value, say), 500.
 */
export async function POST(request: NextRequest) {
  const agentDenied = rejectAgentCredential(request);
  if (agentDenied) return agentDenied;

  // A cross-site form cannot send a JSON content type without a preflight, so this also blocks CSRF.
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return jsonError("unsupported_media_type", 415);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidInputResponse("The body must be valid JSON.");
  }
  const input = parseInput(exportAgentPackRequestSchema, body);
  if (!input.success) return invalidInputResponse(input.message);

  try {
    await requireWorkspaceRole(input.data.workspace_id, "member");
    const client = await createSupabaseServerClient();
    const exported = await exportAgentPack(client, {
      workspaceId: input.data.workspace_id,
      agentIds: input.data.agent_ids,
      name: input.data.name,
    });
    return new Response(exported.json, {
      status: 200,
      headers: {
        ...NO_STORE,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exported.fileName}"`,
        "X-Pack-Checksum": exported.checksum,
      },
    });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return jsonError(error.code, error.code === "unauthenticated" ? 401 : 403);
    }
    if (error instanceof ExportAgentPackError) {
      return jsonError(error.code, FAILURE_STATUS[error.code]);
    }
    throw error;
  }
}
