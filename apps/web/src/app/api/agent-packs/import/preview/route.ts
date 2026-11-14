import { MAX_PACK_BYTES, type PackRejection } from "@ago/shared/pack-import-preview";
import type { NextRequest } from "next/server";

import {
  PreviewPackImportError,
  previewAgentPackImport,
} from "../../../../../features/packs/preview-agent-pack-import";
import { previewPackImportQuerySchema } from "../../../../../features/packs/preview-request";
import { readLimitedBody } from "../../../../../features/packs/read-limited-body";
import {
  WorkspaceAccessError,
  requireWorkspaceRole,
} from "../../../../../features/workspaces/workspace-access";
import { rejectAgentCredential } from "../../../../../lib/auth/human-only";
import { createSupabaseServerClient } from "../../../../../lib/supabase/server";
import {
  invalidInputResponse,
  parseInput,
  searchParamsToRecord,
} from "../../../../../lib/validation/parse-input";

// Never cache: the answer depends on the caller's session and describes the workspace's agents.
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function jsonError(error: string, status: number, extra: object = {}): Response {
  return Response.json({ error, ...extra }, { status, headers: NO_STORE });
}

const REJECTION_STATUS: Record<PackRejection["code"], number> = {
  too_large: 413,
  too_deep: 422,
  too_complex: 422,
  invalid_json: 422,
  not_a_pack: 422,
  too_many_agents: 422,
  too_many_skills: 422,
  too_many_notes: 422,
  invalid_pack: 422,
};

/**
 * POST /api/agent-packs/import/preview?workspace_id=<uuid>: a dry run of importing an agent pack (AGO-193).
 * The body is the pack file itself (`Content-Type: application/json`). NOTHING IS WRITTEN: the answer lists what
 * import would create, update or skip, every capability with its risk tier, Tier 3 and 4 and trifecta flags,
 * name conflicts, what to set up afterwards, and what import would ignore and why.
 * Human only: an agent credential is refused first (403). The caller must be an owner of THAT workspace.
 * 200 the preview (also when it says `importable: false`), 400 bad query, 401 signed out, 403 not allowed,
 * 413 over the size limit, 415 not JSON, 422 not a valid pack (a fixed message, never the pack's own text), 500.
 */
export async function POST(request: NextRequest) {
  const agentDenied = rejectAgentCredential(request);
  if (agentDenied) return agentDenied;

  // A cross-site form cannot send a JSON content type without a preflight, so this also blocks CSRF.
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return jsonError("unsupported_media_type", 415);
  }
  const query = parseInput(
    previewPackImportQuerySchema,
    searchParamsToRecord(request.nextUrl.searchParams),
  );
  if (!query.success) return invalidInputResponse(query.message);

  try {
    // Authorize before the body is read: a caller who may not preview costs nothing.
    await requireWorkspaceRole(query.data.workspace_id, "owner");

    const body = await readLimitedBody(request, MAX_PACK_BYTES);
    if (!body.ok) {
      return body.reason === "too_large"
        ? jsonError("too_large", 413, {
            message: `The file is too large. The limit is ${String(MAX_PACK_BYTES / 1024 / 1024)} MB.`,
          })
        : invalidInputResponse("The body could not be read.");
    }

    const client = await createSupabaseServerClient();
    const result = await previewAgentPackImport(client, {
      workspaceId: query.data.workspace_id,
      text: body.text,
    });
    if (!result.ok) {
      return jsonError(result.error.code, REJECTION_STATUS[result.error.code], {
        message: result.error.message,
        issues: result.error.issues,
      });
    }
    return Response.json(result.preview, { status: 200, headers: NO_STORE });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return jsonError(error.code, error.code === "unauthenticated" ? 401 : 403);
    }
    if (error instanceof PreviewPackImportError) return jsonError("failed", 500);
    throw error;
  }
}
