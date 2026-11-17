import { MAX_PACK_BYTES } from "@ago/shared/pack-import-preview";
import type { NextRequest } from "next/server";

import {
  ApplyPackImportError,
  applyAgentPackImport,
} from "../../../../features/packs/apply-agent-pack-import";
import {
  NO_STORE,
  REJECTION_STATUS,
  jsonError,
} from "../../../../features/packs/import-route-support";
import { PreviewPackImportError } from "../../../../features/packs/preview-agent-pack-import";
import { applyPackImportQuerySchema } from "../../../../features/packs/preview-request";
import { readLimitedBody } from "../../../../features/packs/read-limited-body";
import {
  WorkspaceAccessError,
  requireWorkspaceRole,
} from "../../../../features/workspaces/workspace-access";
import { rejectAgentCredential } from "../../../../lib/auth/human-only";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";
import {
  invalidInputResponse,
  parseInput,
  searchParamsToRecord,
} from "../../../../lib/validation/parse-input";

const APPLY_ERROR_STATUS = { forbidden: 403, stale: 409, invalid: 422, failed: 500 } as const;

/**
 * POST /api/agent-packs/import?workspace_id=<uuid>&conflict=skip|rename|new_version: imports an agent pack (AGO-194).
 * The body is the pack file itself (`Content-Type: application/json`). It plans exactly like the dry run
 * (`POST /api/agent-packs/import/preview`, same query) and writes the plan in ONE database transaction, so the
 * answer to a dry run with the same rule is what is applied. Every agent lands in Strict mode; Tier 3 and 4
 * capabilities, budgets above the cap, departments, secret references and notes are ignored and reported; an agent
 * that would hold a trifecta combination is imported archived (disabled) with the reason shown. One event with the
 * pack checksum is written on success and none on failure.
 * Human only: an agent credential is refused first (403). The caller must be an owner of THAT workspace; the
 * database function checks the owner role and the workspace again.
 * 200 the report (with `eventId`), 400 bad query, 401 signed out, 403 not allowed, 409 the workspace changed since it
 * was read (retry), 413 over the size limit, 415 not JSON, 422 not a valid pack or not importable (a fixed message and,
 * for a blocked pack, the report; never the pack's own text), 500. Nothing is written on any non-200 answer.
 */
export async function POST(request: NextRequest) {
  const agentDenied = rejectAgentCredential(request);
  if (agentDenied) return agentDenied;

  // A cross-site form cannot send a JSON content type without a preflight, so this also blocks CSRF.
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return jsonError("unsupported_media_type", 415);
  }
  const query = parseInput(
    applyPackImportQuerySchema,
    searchParamsToRecord(request.nextUrl.searchParams),
  );
  if (!query.success) return invalidInputResponse(query.message);

  try {
    // Authorize before the body is read: a caller who may not import costs nothing.
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
    const result = await applyAgentPackImport(client, {
      workspaceId: query.data.workspace_id,
      text: body.text,
      conflictRule: query.data.conflict,
    });
    if (result.ok) return Response.json(result.report, { status: 200, headers: NO_STORE });
    if ("blocked" in result) {
      return jsonError("not_importable", 422, {
        message: "The pack cannot be imported. Nothing was written.",
        report: result.blocked,
      });
    }
    return jsonError(result.error.code, REJECTION_STATUS[result.error.code], {
      message: result.error.message,
      issues: result.error.issues,
    });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return jsonError(error.code, error.code === "unauthenticated" ? 401 : 403);
    }
    if (error instanceof ApplyPackImportError) {
      return jsonError(error.code, APPLY_ERROR_STATUS[error.code]);
    }
    if (error instanceof PreviewPackImportError) return jsonError("failed", 500);
    throw error;
  }
}
