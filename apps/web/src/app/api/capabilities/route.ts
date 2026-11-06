import { listCapabilitiesQuerySchema, type ListCapabilitiesResponse } from "@ago/shared";
import type { NextRequest } from "next/server";

import {
  CapabilityCatalogError,
  listCapabilities,
} from "../../../features/capabilities/capability-catalog";
import { WorkspaceAccessError } from "../../../features/workspaces/workspace-access";
import {
  invalidInputResponse,
  parseInput,
  searchParamsToRecord,
} from "../../../lib/validation/parse-input";

// Never cache: the answer depends on the caller's session.
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}

/**
 * GET /api/capabilities?workspace_id=<uuid>: the workspace's capability catalog, for any member or
 * viewer. Read-only on purpose: tier, scope and default only change by migration, so there is no
 * write route (and an agent token has nothing to call).
 * 401 signed out, 403 not a member of that workspace, 400 bad input.
 */
export async function GET(request: NextRequest) {
  const query = parseInput(
    listCapabilitiesQuerySchema,
    searchParamsToRecord(request.nextUrl.searchParams),
  );
  if (!query.success) return invalidInputResponse(query.message);

  try {
    const capabilities = await listCapabilities(query.data.workspace_id);
    const body: ListCapabilitiesResponse = { capabilities };
    return Response.json(body, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return jsonError(error.code, error.code === "unauthenticated" ? 401 : 403);
    }
    if (error instanceof CapabilityCatalogError) return jsonError("catalog_unavailable", 500);
    throw error;
  }
}
